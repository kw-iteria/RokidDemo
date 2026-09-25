package com.iteria.platepress

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.util.Log
import java.util.concurrent.LinkedBlockingQueue
import kotlin.concurrent.thread

/** Plays the server's streamed neural voice (PCM16 mono) as chunks arrive; tracks when it is audible. */
class VoicePlayer {
    private val queue = LinkedBlockingQueue<ByteArray>()
    private var track: AudioTrack? = null
    private var rate = 24_000
    @Volatile private var currentId = ""
    @Volatile private var lastAudioAt = 0L
    @Volatile private var queuedMs = 0L
    @Volatile private var playedUntil = 0L

    init { thread(name = "voice-player", isDaemon = true) { loop() } }

    fun enqueue(id: String, sampleRate: Int, pcm: ByteArray, stop: Boolean) {
        if (stop) { flush(); return }
        if (id != currentId) { flush(); currentId = id }
        if (sampleRate != rate) { rate = sampleRate; recreate() }
        if (pcm.isNotEmpty()) queue.offer(pcm)
    }

    /** True while speech is (probably) coming out of the speaker, so the microphone ignores it. */
    fun isPlaying(): Boolean = queue.isNotEmpty() || System.currentTimeMillis() < playedUntil + 350

    fun flush() {
        queue.clear()
        try { track?.pause(); track?.flush(); track?.play() } catch (_: Exception) {}
        playedUntil = 0L
    }

    private fun recreate() {
        try { track?.release() } catch (_: Exception) {}
        track = null
    }

    private fun ensureTrack(): AudioTrack? {
        track?.let { return it }
        return try {
            val minBuf = AudioTrack.getMinBufferSize(rate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
            AudioTrack.Builder()
                .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANT).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                .setAudioFormat(AudioFormat.Builder().setSampleRate(rate).setEncoding(AudioFormat.ENCODING_PCM_16BIT).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                .setBufferSizeInBytes(maxOf(minBuf, rate * 2)) // one second of buffer
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build().also { it.play(); track = it }
        } catch (e: Exception) { Log.e(TAG, "AudioTrack failed", e); null }
    }

    private fun loop() {
        while (true) {
            val chunk = queue.take()
            val t = ensureTrack() ?: continue
            try {
                var off = 0
                while (off < chunk.size) {
                    val n = t.write(chunk, off, chunk.size - off) // blocks while the buffer is full
                    if (n <= 0) break
                    off += n
                }
                val ms = chunk.size * 1000L / (rate * 2)
                val now = System.currentTimeMillis()
                playedUntil = maxOf(playedUntil, now) + ms
                lastAudioAt = now
            } catch (e: Exception) {
                Log.w(TAG, "write failed: ${e.message}"); recreate()
            }
        }
    }

    fun release() { try { track?.release() } catch (_: Exception) {} }

    companion object { const val TAG = "VoicePlayer" }
}
