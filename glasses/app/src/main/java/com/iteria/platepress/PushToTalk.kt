package com.iteria.platepress

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Log
import java.io.ByteArrayOutputStream
import kotlin.concurrent.thread
import kotlin.math.sqrt

/**
 * Records one utterance from the glasses microphone (16 kHz mono PCM16) and hands it over when the
 * speaker goes quiet. Ends after ~1 s of silence following speech, 3 s of nothing at all, or 8 s max.
 */
class PushToTalk(
    private val onAudio: (pcm: ByteArray, sampleRate: Int) -> Unit,
    private val onState: (recording: Boolean) -> Unit,
) {
    @Volatile var recording = false; private set
    @Volatile private var stopRequested = false

    fun toggle() { if (recording) stop() else start() }

    fun start() {
        if (recording) return
        recording = true
        stopRequested = false
        onState(true)
        thread(name = "push-to-talk") { record() }
    }

    fun stop() { stopRequested = true }

    private fun record() {
        val rate = 16_000
        val minBuf = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val rec = try {
            AudioRecord(MediaRecorder.AudioSource.MIC, rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(minBuf, 8192))
        } catch (e: Exception) {
            Log.e(TAG, "AudioRecord failed", e); finish(null, rate); return
        }
        if (rec.state != AudioRecord.STATE_INITIALIZED) { rec.release(); finish(null, rate); return }
        val out = ByteArrayOutputStream(rate * 2 * 8)
        val chunk = ShortArray(320) // 20 ms
        val bytes = ByteArray(chunk.size * 2)
        var speechStarted = false
        var lastLoudMs = 0L
        val t0 = System.currentTimeMillis()
        try {
            rec.startRecording()
            while (!stopRequested) {
                val n = rec.read(chunk, 0, chunk.size)
                if (n <= 0) continue
                var sum = 0.0
                for (i in 0 until n) { val v = chunk[i].toDouble(); sum += v * v }
                val rms = sqrt(sum / n)
                val now = System.currentTimeMillis()
                if (rms > SPEECH_RMS) { speechStarted = true; lastLoudMs = now }
                for (i in 0 until n) { bytes[2 * i] = (chunk[i].toInt() and 0xff).toByte(); bytes[2 * i + 1] = (chunk[i].toInt() shr 8).toByte() }
                out.write(bytes, 0, n * 2)
                if (speechStarted && now - lastLoudMs > 1000) break
                if (!speechStarted && now - t0 > 3000) break
                if (now - t0 > 8000) break
            }
        } catch (e: Exception) {
            Log.w(TAG, "recording error: ${e.message}")
        } finally {
            try { rec.stop() } catch (_: Exception) {}
            rec.release()
        }
        finish(if (speechStarted) out.toByteArray() else null, rate)
    }

    private fun finish(pcm: ByteArray?, rate: Int) {
        recording = false
        onState(false)
        if (pcm != null) onAudio(pcm, rate)
    }

    companion object {
        const val TAG = "PushToTalk"
        const val SPEECH_RMS = 700.0
    }
}
