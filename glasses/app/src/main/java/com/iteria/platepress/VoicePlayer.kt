package com.iteria.platepress

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Build
import android.util.Log
import java.util.concurrent.LinkedBlockingQueue
import kotlin.concurrent.thread

/**
 * Plays the server's streamed neural voice (PCM16 mono) as chunks arrive; tracks when it is audible.
 *
 * Latency: a streaming AudioTrack only starts (and restarts after running dry) once its start
 * threshold is filled, which by default is the whole buffer. The buffer is kept small, the start
 * threshold is ~60 ms (API 31+; older devices get a small effective buffer instead), and the end of
 * each reply is drained with stop() so its tail is always heard.
 *
 * Threading: the WebSocket reader thread only enqueues. Every AudioTrack call happens on the player
 * thread. A flush (new reply, interrupt, voice off) bumps [generation]; queued and half-written audio
 * from an older generation is dropped within one 20 ms slice.
 */
class VoicePlayer {
    private class Item(val gen: Int, val rate: Int, val pcm: ByteArray, val end: Boolean)

    private val queue = LinkedBlockingQueue<Item>()
    private var track: AudioTrack? = null          // player thread only
    private var trackRate = 0                      // player thread only
    private var playedGen = 0                      // player thread only
    @Volatile private var generation = 0
    @Volatile private var currentId = ""
    @Volatile private var cancelledId = ""
    @Volatile private var playedUntil = 0L

    init { thread(name = "voice-player", isDaemon = true) { loop() } }

    fun enqueue(id: String, sampleRate: Int, pcm: ByteArray, stop: Boolean, last: Boolean = false) {
        if (stop) { if (id == currentId) flush(); return }
        if (id == cancelledId) return                       // late chunks of a reply the wearer interrupted
        if (id != currentId) { flush(); currentId = id }
        val gen = generation
        if (pcm.isNotEmpty()) queue.offer(Item(gen, sampleRate, pcm, false))
        if (last) queue.offer(Item(gen, sampleRate, EMPTY, true))
    }

    /** True while speech is (probably) coming out of the speaker, so the microphone ignores it. */
    fun isPlaying(): Boolean = queue.any { !it.end && it.gen == generation } || System.currentTimeMillis() < playedUntil + 350

    /** Drops everything queued or playing (new reply, interrupt, voice switched off). */
    fun flush() {
        cancelledId = currentId
        generation++
        queue.clear()
        queue.offer(Item(generation, 0, EMPTY, false)) // wakes the player so it silences the track now
        playedUntil = 0L
    }

    private fun ensureTrack(rate: Int): AudioTrack? {
        track?.let { if (trackRate == rate) return it; try { it.release() } catch (_: Exception) {}; track = null }
        return try {
            val minBuf = AudioTrack.getMinBufferSize(rate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
            AudioTrack.Builder()
                .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANT).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                .setAudioFormat(AudioFormat.Builder().setSampleRate(rate).setEncoding(AudioFormat.ENCODING_PCM_16BIT).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                .setBufferSizeInBytes(maxOf(minBuf, rate * 2 / 4)) // ~250 ms capacity: rides out network jitter
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build().also {
                    val startFrames = rate * 60 / 1000
                    if (Build.VERSION.SDK_INT >= 31) {
                        try { it.setStartThresholdInFrames(minOf(it.bufferSizeInFrames, startFrames)) } catch (e: Exception) { Log.w(TAG, "start threshold: ${e.message}") }
                    } else {
                        // Before API 31 the start threshold is the effective buffer size, so shrink that.
                        try { it.setBufferSizeInFrames(maxOf(minBuf / 2, rate / 10)) } catch (e: Exception) { Log.w(TAG, "buffer size: ${e.message}") }
                    }
                    it.play(); track = it; trackRate = rate
                }
        } catch (e: Exception) { Log.e(TAG, "AudioTrack failed", e); null }
    }

    private fun silence(t: AudioTrack) {
        try { t.pause(); t.flush() } catch (_: Exception) {}
    }

    private fun loop() {
        while (true) {
            val item = queue.take()
            if (item.gen != playedGen) {                      // a flush happened: cut the old reply off
                playedGen = item.gen
                track?.let { silence(it) }
            }
            if (item.gen != generation) continue              // stale
            if (item.end) { try { track?.stop() } catch (_: Exception) {}; continue } // drains the buffered tail
            if (item.pcm.isEmpty()) continue                   // wake-up marker
            val t = ensureTrack(item.rate) ?: continue
            try {
                if (t.playState != AudioTrack.PLAYSTATE_PLAYING) t.play()
                val slice = item.rate * 2 * 20 / 1000            // 20 ms: a flush interrupts within one slice
                var off = 0
                while (off < item.pcm.size && item.gen == generation) {
                    val n = t.write(item.pcm, off, minOf(slice, item.pcm.size - off)) // blocks while the buffer is full
                    if (n <= 0) break
                    off += n
                }
                val ms = off * 1000L / (item.rate * 2)
                playedUntil = maxOf(playedUntil, System.currentTimeMillis()) + ms
            } catch (e: Exception) {
                Log.w(TAG, "write failed: ${e.message}")
                try { t.release() } catch (_: Exception) {}
                track = null
            }
        }
    }

    fun release() { flush() }

    companion object {
        const val TAG = "VoicePlayer"
        private val EMPTY = ByteArray(0)
    }
}
