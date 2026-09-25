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
    private val sink: (jpeg: ByteArray, w: Int, h: Int) -> Unit,
) {
    var targetFps = 6.0
    var targetLongEdge = 480
    var jpegQuality = 60
    /** Extra rotation in degrees if CameraX's own upright correction is wrong on this device. */
    var extraRotation = 0

    @Volatile var fps = 0f; private set
    @Volatile var framesSent = 0L; private set

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
            }
        }, ContextCompat.getMainExecutor(context))
    }

    private fun bind() {
        val p = provider ?: return
        val analysis = ImageAnalysis.Builder()
            .setResolutionSelector(
                ResolutionSelector.Builder()
                    .setResolutionStrategy(ResolutionStrategy(Size(640, 480), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER))
                    .build()
            )
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888)
            .setOutputImageRotationEnabled(true)
            .build()
        analysis.setAnalyzer(executor) { image ->
            try { onFrame(image) } catch (e: Exception) { Log.w(TAG, "frame failed: ${e.message}") } finally { image.close() }
        }
        p.unbindAll()
        p.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, analysis)
        Log.i(TAG, "camera bound")
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

        val scale = targetLongEdge.toFloat() / maxOf(bmp.width, bmp.height)
        val rotation = (image.imageInfo.rotationDegrees + extraRotation + 360) % 360 // 0 once CameraX rotated the buffer
        if (scale < 1f || rotation != 0) {
            val m = Matrix()
            if (scale < 1f) m.postScale(scale, scale)
            if (rotation != 0) m.postRotate(rotation.toFloat())
            bmp = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, m, true)
        }
        out.reset()
        bmp.compress(Bitmap.CompressFormat.JPEG, jpegQuality, out)
        sink(out.toByteArray(), bmp.width, bmp.height)
        framesSent++
    }

    fun stop() {
        try { provider?.unbindAll() } catch (_: Exception) {}
    }

    companion object { const val TAG = "CameraStreamer" }
}
