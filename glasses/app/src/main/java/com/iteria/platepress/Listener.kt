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
    @Volatile var source = "none"; private set
    @Volatile var noiseFloor = 0.0; private set
    @Volatile var lastPeak = 0.0; private set
    @Volatile var utterances = 0; private set
    @Volatile var restartRequested = false
    private var stop = false

    fun start() {
        if (running) return
        running = true
        stop = false
        thread(name = "listener") { loop() }
    }

    fun shutdown() { stop = true }

    private fun loop() {
        // Try the echo-cancelled path first; if it delivers silence, fall back to the raw microphone.
        var sourceIndex = 0
        val sources = listOf(MediaRecorder.AudioSource.VOICE_COMMUNICATION to "voice_comm", MediaRecorder.AudioSource.MIC to "mic")
        while (!stop) {
            val (src, name) = sources[sourceIndex.coerceIn(0, sources.size - 1)]
            source = name
            val silent = record(src)
            if (stop) break
            if (silent && sourceIndex < sources.size - 1) { Log.w(TAG, "$name delivered silence, switching source"); sourceIndex++ } else sourceIndex = sources.size - 1
        }
        running = false
    }

    /** Records until stopped; returns true if the first seconds were dead silence (bad source). */
    private fun record(audioSource: Int): Boolean {
        val rate = 16_000
        val minBuf = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val r = try {
            AudioRecord(audioSource, rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, max(minBuf, 8192)).takeIf { it.state == AudioRecord.STATE_INITIALIZED }
        } catch (e: Exception) { Log.w(TAG, "audio source $audioSource failed: ${e.message}"); null }
        if (r == null) { Thread.sleep(500); return true }
        val chunk = ShortArray(320) // 20 ms
        val bytes = ByteArray(chunk.size * 2)
        val out = ByteArrayOutputStream(rate * 2 * 12)
        var noise = 300.0            // adaptive noise floor (RMS)
        var inSpeech = false
        var speechMs = 0
        var silenceMs = 0
        var utteranceMs = 0
        var lastSpeakerBusyAt = 0L
        var totalMs = 0
        var maxRms = 0.0
        var deadSource = false
        try {
            r.startRecording()
            while (!stop && !restartRequested) {
                val n = r.read(chunk, 0, chunk.size)
                if (n <= 0) continue
                val now = System.currentTimeMillis()
                if (isSpeakerBusy()) lastSpeakerBusyAt = now
                val muted = !enabled || now - lastSpeakerBusyAt < 500
                var sum = 0.0
                for (i in 0 until n) { val v = chunk[i].toDouble(); sum += v * v }
                val rms = sqrt(sum / n)
                totalMs += 20; if (rms > maxRms) maxRms = rms
                if (totalMs == 2000 && maxRms < 3.0) { deadSource = true; break } // two seconds of digital silence: wrong source
                if (!inSpeech) noise = if (rms < noise) noise * 0.9 + rms * 0.1 else noise * 0.995 + rms * 0.005
                noiseFloor = noise
                val threshold = max(noise * 2.5, MIN_SPEECH_RMS)
                val loud = rms > threshold && !muted
                if (loud && rms > lastPeak) lastPeak = rms
                if (!inSpeech) {
                    if (loud) { speechMs += 20; if (speechMs >= 120) { inSpeech = true; silenceMs = 0; utteranceMs = 0; out.reset(); onSpeech(true) } }
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
                    if (utteranceMs - silenceMs >= MIN_UTTERANCE_MS && !muted) { utterances++; onUtterance(out.toByteArray(), rate) }
                    out.reset()
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "listener error: ${e.message}")
        } finally {
            try { r.stop() } catch (_: Exception) {}
            r.release()
        }
        restartRequested = false
        return deadSource
    }

    companion object {
        const val TAG = "Listener"
        const val MIN_SPEECH_RMS = 350.0
        const val END_SILENCE_MS = 700
        const val MIN_UTTERANCE_MS = 400
        const val MAX_UTTERANCE_MS = 12_000
    }
}
