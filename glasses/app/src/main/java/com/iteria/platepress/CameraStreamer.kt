package com.iteria.platepress

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Matrix
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
                    .setResolutionStrategy(ResolutionStrategy(Size(1280, 960), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER))
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
            status = "bound (" + p.availableCameraInfos.size + " camera(s))"
            Log.i(TAG, "camera bound")
        } catch (e: Exception) {
            Log.e(TAG, "camera bind failed", e)
            status = "bind failed"; lastError = e.message ?: e.toString()
        }
    }

    private fun onFrame(image: ImageProxy) {
        val now = System.currentTimeMillis()
        if (now - lastSentAt < (1000.0 / targetFps).toLong()) return
        if (lastSentAt != 0L) fps = 0.8f * fps + 0.2f * (1000f / (now - lastSentAt))
        lastSentAt = now

        val plane = image.planes[0]
        val strideWidth = plane.rowStride / plane.pixelStride
        var bmp = Bitmap.createBitmap(strideWidth, image.height, Bitmap.Config.ARGB_8888)
        plane.buffer.rewind()
        bmp.copyPixelsFromBuffer(plane.buffer)
        if (strideWidth != image.width) bmp = Bitmap.createBitmap(bmp, 0, 0, image.width, image.height)
        // Optional centre crop so the frame matches what the operator sees through the lens.
        val targetRatio = when (aspect) { "landscape" -> 16f / 9f; "square" -> 1f; else -> 0f }
        if (targetRatio > 0f) {
            val cur = bmp.width.toFloat() / bmp.height
            if (cur < targetRatio) { val h = (bmp.width / targetRatio).toInt(); bmp = Bitmap.createBitmap(bmp, 0, (bmp.height - h) / 2, bmp.width, h) }
            else if (cur > targetRatio) { val w = (bmp.height * targetRatio).toInt(); bmp = Bitmap.createBitmap(bmp, (bmp.width - w) / 2, 0, w, bmp.height) }
        }

        val scale = targetLongEdge.toFloat() / maxOf(bmp.width, bmp.height)
        val rotation = (image.imageInfo.rotationDegrees + extraRotation + 360) % 360 // 0 once CameraX rotated the buffer
        if (scale < 1f || rotation != 0 || mirror) {
            val m = Matrix()
            if (scale < 1f) m.postScale(scale, scale)
            if (mirror) m.postScale(-1f, 1f)
            if (rotation != 0) m.postRotate(rotation.toFloat())
            bmp = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, m, true)
        }
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
