package com.iteria.platepress

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Log
import java.io.ByteArrayOutputStream
import kotlin.concurrent.thread
import kotlin.math.max
import kotlin.math.sqrt

/**
 * Always-on microphone with a simple energy voice-activity detector: each spoken utterance is cut
 * out and handed over, like a regular chat. Echo from the glasses' own speaker is suppressed by
 * ignoring audio while text-to-speech is playing (and shortly after).
 */
class Listener(
    private val onUtterance: (pcm: ByteArray, sampleRate: Int) -> Unit,
    private val onSpeech: (speaking: Boolean) -> Unit,
    private val isSpeakerBusy: () -> Boolean,
) {
    @Volatile var enabled = true
    @Volatile var running = false; private set
    private var stop = false

    fun start() {
        if (running) return
        running = true
        stop = false
        thread(name = "listener") { loop() }
    }

    fun shutdown() { stop = true }

    private fun loop() {
        val rate = 16_000
        val minBuf = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        var rec: AudioRecord? = null
        for (source in listOf(MediaRecorder.AudioSource.VOICE_COMMUNICATION, MediaRecorder.AudioSource.MIC)) {
            try {
                val r = AudioRecord(source, rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, max(minBuf, 8192))
                if (r.state == AudioRecord.STATE_INITIALIZED) { rec = r; break } else r.release()
            } catch (e: Exception) { Log.w(TAG, "audio source $source failed: ${e.message}") }
        }
        val r = rec ?: run { Log.e(TAG, "no microphone"); running = false; return }
        val chunk = ShortArray(320) // 20 ms
        val bytes = ByteArray(chunk.size * 2)
        val out = ByteArrayOutputStream(rate * 2 * 12)
        var noise = 300.0            // adaptive noise floor (RMS)
        var inSpeech = false
        var speechMs = 0
        var silenceMs = 0
        var utteranceMs = 0
        var lastSpeakerBusyAt = 0L
        try {
            r.startRecording()
            while (!stop) {
                val n = r.read(chunk, 0, chunk.size)
                if (n <= 0) continue
                val now = System.currentTimeMillis()
                if (isSpeakerBusy()) lastSpeakerBusyAt = now
                val muted = !enabled || now - lastSpeakerBusyAt < 600
                var sum = 0.0
                for (i in 0 until n) { val v = chunk[i].toDouble(); sum += v * v }
                val rms = sqrt(sum / n)
                if (!inSpeech) noise = if (rms < noise) noise * 0.9 + rms * 0.1 else noise * 0.995 + rms * 0.005
                val threshold = max(noise * 3.0, MIN_SPEECH_RMS)
                val loud = rms > threshold && !muted
                if (!inSpeech) {
                    if (loud) { speechMs += 20; if (speechMs >= 160) { inSpeech = true; silenceMs = 0; utteranceMs = 0; out.reset(); onSpeech(true) } }
                    else speechMs = 0
                    if (speechMs > 0 || inSpeech) { for (i in 0 until n) { bytes[2 * i] = (chunk[i].toInt() and 0xff).toByte(); bytes[2 * i + 1] = (chunk[i].toInt() shr 8).toByte() }; out.write(bytes, 0, n * 2) }
                    else if (out.size() > 0) out.reset()
                    continue
                }
                for (i in 0 until n) { bytes[2 * i] = (chunk[i].toInt() and 0xff).toByte(); bytes[2 * i + 1] = (chunk[i].toInt() shr 8).toByte() }
                out.write(bytes, 0, n * 2)
                utteranceMs += 20
                if (loud) silenceMs = 0 else silenceMs += 20
                val done = silenceMs >= END_SILENCE_MS || utteranceMs >= MAX_UTTERANCE_MS || muted
                if (done) {
                    inSpeech = false; speechMs = 0
                    onSpeech(false)
                    if (utteranceMs - silenceMs >= MIN_UTTERANCE_MS && !muted) onUtterance(out.toByteArray(), rate)
                    out.reset()
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "listener error: ${e.message}")
        } finally {
            try { r.stop() } catch (_: Exception) {}
            r.release()
            running = false
        }
    }

    companion object {
        const val TAG = "Listener"
        const val MIN_SPEECH_RMS = 600.0
        const val END_SILENCE_MS = 700
        const val MIN_UTTERANCE_MS = 400
        const val MAX_UTTERANCE_MS = 12_000
    }
}
