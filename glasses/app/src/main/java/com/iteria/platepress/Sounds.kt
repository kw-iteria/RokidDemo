package com.iteria.platepress

import android.content.Context
import android.media.AudioManager
import android.media.ToneGenerator
import android.speech.tts.TextToSpeech
import java.util.Locale

/** Short tones for transitions, a repeating alert while the press must be opened, and spoken prompts. */
class Sounds(context: Context) {
    private val tone: ToneGenerator? = try { ToneGenerator(AudioManager.STREAM_MUSIC, 85) } catch (_: Exception) { null }
    @Volatile private var ttsReady = false
    @Volatile var voiceEnabled = true
    private lateinit var tts: TextToSpeech

    init {
        tts = TextToSpeech(context.applicationContext) { status ->
            if (status == TextToSpeech.SUCCESS) {
                tts.language = Locale.US
                ttsReady = true
            }
        }
    }

    fun tick() { tone?.startTone(ToneGenerator.TONE_PROP_BEEP, 120) }
    fun chime() { tone?.startTone(ToneGenerator.TONE_PROP_ACK, 200) }
    fun alarmBeep() { tone?.startTone(ToneGenerator.TONE_CDMA_ALERT_CALL_GUARD, 260) }
    fun done() { tone?.startTone(ToneGenerator.TONE_PROP_PROMPT, 320) }

    @Volatile private var lastSpokeAt = 0L
    fun say(text: String) {
        if (voiceEnabled && ttsReady) { lastSpokeAt = System.currentTimeMillis(); tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "pp-${System.nanoTime()}") }
    }
    /** True while the speaker is (probably) playing our own voice, so the microphone ignores it. */
    fun isSpeaking(): Boolean = try {
        val since = System.currentTimeMillis() - lastSpokeAt
        ttsReady && (since < 400 || (tts.isSpeaking && since < 10_000)) // prompts are short: a stuck isSpeaking must not hold the mic
    } catch (_: Exception) { false }

    fun release() {
        tone?.release()
        try { tts.shutdown() } catch (_: Exception) {}
    }
}
