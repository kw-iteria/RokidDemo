package com.iteria.platepress

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import android.util.Log
import android.util.Size
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors

/** CameraX analysis stream -> small upright JPEGs at a steady rate. */
class CameraStreamer(
    private val context: Context,
    private val owner: LifecycleOwner,
    private val sink: (jpeg: ByteArray, w: Int, h: Int, motion: Float) -> Unit,
) {
    private var prevSmall: IntArray? = null
    private val smallW = 48
    private val smallH = 36

    /** Mean absolute gray change versus the previous sent frame, 0..1 (≈40 gray levels = 1). */
    private fun motionScore(bmp: Bitmap): Float {
        val small = Bitmap.createScaledBitmap(bmp, smallW, smallH, false)
        val px = IntArray(smallW * smallH)
        small.getPixels(px, 0, smallW, 0, 0, smallW, smallH)
        for (i in px.indices) { val c = px[i]; px[i] = ((c shr 16 and 0xff) * 77 + (c shr 8 and 0xff) * 150 + (c and 0xff) * 29) shr 8 }
        val prev = prevSmall
        prevSmall = px
        if (prev == null) return 0f
        var sum = 0L
        for (i in px.indices) sum += kotlin.math.abs(px[i] - prev[i])
        return (sum.toFloat() / px.size / 40f).coerceIn(0f, 1f)
    }
    var targetFps = 6.0
    var targetLongEdge = 720
    var jpegQuality = 60
    /** Extra rotation in degrees if CameraX's own upright correction is wrong on this device. */
    @Volatile var extraRotation = 0
    @Volatile var mirror = false
    /** "native" keeps the sensor aspect; "landscape" crops the centre to 16:9 (like the glasses' own videos); "square" crops to 1:1. */
    @Volatile var aspect = "native"

    /** Set while the glasses are not connected: gets full-resolution upright frames to look for the pairing code. */
    @Volatile var scanner: ((Bitmap) -> Unit)? = null
    /** Whether to scan right now (only while not connected; no extra work otherwise). */
    @Volatile var scanWhile: () -> Boolean = { false }
    private var lastScanAt = 0L
    /** Whether a frame encoded now would actually be sent (link up, socket not congested); otherwise the frame is skipped before any work. */
    @Volatile var wanted: () -> Boolean = { true }

    @Volatile var fps = 0f; private set
    @Volatile var framesSent = 0L; private set
    @Volatile var status = "starting"; private set
    @Volatile var lastError = ""; private set

    private val executor = Executors.newSingleThreadExecutor()
    private var lastSentAt = 0L
    private val out = ByteArrayOutputStream(96 * 1024)
    private var provider: ProcessCameraProvider? = null

    fun start() {
        val future = ProcessCameraProvider.getInstance(context)
        future.addListener({
            try {
                provider = future.get()
                bind()
            } catch (e: Exception) {
                Log.e(TAG, "camera init failed", e)
                status = "init failed"; lastError = e.message ?: e.toString()
            }
        }, ContextCompat.getMainExecutor(context))
    }

    private fun bind() {
        val p = provider ?: return
        val analysis = ImageAnalysis.Builder()
            .setResolutionSelector(
                ResolutionSelector.Builder()
                    // Capture only as large as the sent frame needs: every analysed frame is converted to RGBA,
                    // so 1280x960 cost ~1.8x the work of 960x720 for a 720 px frame.
                    .setResolutionStrategy(ResolutionStrategy(captureSize(), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER))
                    .build()
            )
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888)
            .setOutputImageRotationEnabled(true)
            .build()
        analysis.setAnalyzer(executor) { image ->
            try { onFrame(image) } catch (e: Exception) { Log.w(TAG, "frame failed: ${e.message}"); lastError = e.message ?: e.toString() } finally { image.close() }
        }
        try {
            p.unbindAll()
            val selector = if (p.hasCamera(CameraSelector.DEFAULT_BACK_CAMERA)) CameraSelector.DEFAULT_BACK_CAMERA else CameraSelector.Builder().build()
            p.bindToLifecycle(owner, selector, analysis)
            boundSize = captureSize()
            status = "bound (" + p.availableCameraInfos.size + " camera(s))"
            Log.i(TAG, "camera bound")
        } catch (e: Exception) {
            Log.e(TAG, "camera bind failed", e)
            status = "bind failed"; lastError = e.message ?: e.toString()
        }
    }

    private fun captureSize(): Size = if (targetLongEdge <= 960) Size(960, 720) else Size(1280, 960)
    private var boundSize: Size? = null

    /** Applies a new frame size; re-binds the camera only when the capture size must change. */
    fun setLongEdge(px: Int) {
        targetLongEdge = px
        if (provider != null && boundSize != null && captureSize() != boundSize) ContextCompat.getMainExecutor(context).execute { bind() }
    }

    private var nextDueAt = 0L
    // Reused from frame to frame. A fresh 960x720 copy plus a fresh scaled bitmap per frame drove a
    // native-allocation GC every ~6 s on this low-RAM device (200-430 ms of GC work each, logcat
    // "NativeAlloc concurrent copying GC"), competing with the camera and network threads.
    private var srcBmp: Bitmap? = null
    private var outBmp: Bitmap? = null
    private var outCanvas: Canvas? = null
    private val outPaint = Paint(Paint.FILTER_BITMAP_FLAG)
    private val xform = Matrix()
    private val bounds = RectF()
    private val srcRect = Rect()
    private val dstRect = RectF()

    private fun onFrame(image: ImageProxy) {
        val now = System.currentTimeMillis()
        scanner?.takeIf { scanWhile() }?.let { scan ->
            // full resolution (a code seen from a hand's span away is small), about 4 times a second
            if (now - lastScanAt >= 250) {
                lastScanAt = now
                val plane = image.planes[0]
                val sw = plane.rowStride / plane.pixelStride
                var full = Bitmap.createBitmap(sw, image.height, Bitmap.Config.ARGB_8888)
                plane.buffer.rewind(); full.copyPixelsFromBuffer(plane.buffer)
                if (sw != image.width) full = Bitmap.createBitmap(full, 0, 0, image.width, image.height)
                try { scan(full) } catch (e: Exception) { Log.w(TAG, "pairing scan failed: ${e.message}") }
            }
        }
        val period = (1000.0 / targetFps).toLong()
        // Pace on a fixed schedule (small tolerance for sensor jitter) instead of "period since the last
        // send", which rounded every interval up to the next sensor frame (~5 fps instead of 6).
        // The analysis thread sleeps until the next frame is due: while it is busy CameraX only swaps
        // its cached frame (KEEP_ONLY_LATEST) and hands over the newest one the moment this returns,
        // instead of converting every one of the sensor's ~30 frames a second to RGBA for nothing.
        val wait = nextDueAt - 8 - now
        if (wait > 0) {
            if (wait <= period) Thread.sleep(wait)
            return
        }
        nextDueAt = if (now - nextDueAt > period) now + period else nextDueAt + period
        if (!wanted()) return // nobody would receive it: skip the copy, scale and JPEG
        if (lastSentAt != 0L) fps = 0.8f * fps + 0.2f * (1000f / (now - lastSentAt))
        lastSentAt = now

        val plane = image.planes[0]
        val strideWidth = plane.rowStride / plane.pixelStride
        val src = srcBmp?.takeIf { it.width == strideWidth && it.height == image.height }
            ?: Bitmap.createBitmap(strideWidth, image.height, Bitmap.Config.ARGB_8888).also { srcBmp?.recycle(); srcBmp = it }
        plane.buffer.rewind()
        src.copyPixelsFromBuffer(plane.buffer)
        // The part of the buffer to send: the real width (row padding excluded), optionally centre-cropped
        // so the frame matches what the operator sees through the lens.
        var cropL = 0; var cropT = 0; var cropW = image.width; var cropH = image.height
        val targetRatio = when (aspect) { "landscape" -> 16f / 9f; "square" -> 1f; else -> 0f }
        if (targetRatio > 0f) {
            val cur = cropW.toFloat() / cropH
            if (cur < targetRatio) { val h = (cropW / targetRatio).toInt(); cropT = (cropH - h) / 2; cropH = h }
            else if (cur > targetRatio) { val w = (cropH * targetRatio).toInt(); cropL = (cropW - w) / 2; cropW = w }
        }

        val scale = minOf(1f, targetLongEdge.toFloat() / maxOf(cropW, cropH))
        val rotation = (image.imageInfo.rotationDegrees + extraRotation + 360) % 360 // 0 once CameraX rotated the buffer
        // Crop, scale, mirror and rotate in one filtered draw into the reusable output bitmap
        // (what Bitmap.createBitmap(src, x, y, w, h, matrix, true) does, without allocating).
        xform.reset()
        if (scale < 1f) xform.postScale(scale, scale)
        if (mirror) xform.postScale(-1f, 1f)
        if (rotation != 0) xform.postRotate(rotation.toFloat())
        bounds.set(cropL.toFloat(), cropT.toFloat(), (cropL + cropW).toFloat(), (cropT + cropH).toFloat())
        xform.mapRect(bounds)
        xform.postTranslate(-bounds.left, -bounds.top)
        val outW = Math.round(bounds.width()).coerceAtLeast(1)
        val outH = Math.round(bounds.height()).coerceAtLeast(1)
        val bmp = outBmp?.takeIf { it.width == outW && it.height == outH }
            ?: Bitmap.createBitmap(outW, outH, Bitmap.Config.ARGB_8888).also { outBmp?.recycle(); outBmp = it; outCanvas = Canvas(it) }
        val canvas = outCanvas!!
        srcRect.set(cropL, cropT, cropL + cropW, cropT + cropH)
        dstRect.set(srcRect)
        canvas.save()
        canvas.concat(xform)
        canvas.drawBitmap(src, srcRect, dstRect, outPaint)
        canvas.restore()
        val motion = motionScore(bmp)
        out.reset()
        bmp.compress(Bitmap.CompressFormat.JPEG, jpegQuality, out)
        sink(out.toByteArray(), bmp.width, bmp.height, motion)
        framesSent++
        if (framesSent == 1L) status = "streaming " + bmp.width + "x" + bmp.height
    }

    fun stop() {
        try { provider?.unbindAll() } catch (_: Exception) {}
    }

    companion object { const val TAG = "CameraStreamer" }
}
