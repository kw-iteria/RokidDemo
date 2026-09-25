package com.iteria.platepress

import org.json.JSONObject

/** Everything the glasses need to render, parsed from the server's `state` message. */
data class HudState(
    val phase: String = "CONNECTING",
    val message: String = "Connecting",
    val sub: String = "",
    val hint: String = "",
    val alarm: Boolean = false,
    val countdownEndsAt: Long = 0L,        // server clock, ms
    val countdownStartedAt: Long = 0L,
    val countdownDurationMs: Long = 10_000L,
    val lastLid: String = "",
    val lastVisible: Boolean = false,
    val lastLatencyMs: Int = 0,
    val run: Int = 0,
    val connected: Boolean = false,
    val host: String = "",
    val voice: Boolean = true,
    val cameraLive: Boolean = false,
    val chatText: String = "",
    val chatAt: Long = 0L,
    val chatStreaming: String = "",   // assistant reply while it streams in
    val heardText: String = "",       // what speech-to-text understood
    val heardAt: Long = 0L,
    val listening: Boolean = false,   // microphone armed (always-on mode)
    val speaking: Boolean = false,    // operator is talking right now
    val thinking: Boolean = false,    // waiting for the assistant
) {
    companion object {
        fun fromServer(json: JSONObject, prev: HudState): HudState {
            val s = json.getJSONObject("session")
            val cd = s.optJSONObject("countdown")
            val lv = s.optJSONObject("last_verdict")
            return prev.copy(
                phase = s.optString("phase", "IDLE"),
                message = s.optString("message"),
                sub = s.optString("sub"),
                hint = s.optString("hint"),
                alarm = s.optBoolean("alarm"),
                countdownEndsAt = cd?.optLong("ends_at") ?: 0L,
                countdownStartedAt = cd?.optLong("started_at") ?: 0L,
                countdownDurationMs = cd?.optLong("duration_ms") ?: 10_000L,
                lastLid = lv?.optString("lid") ?: "",
                lastVisible = lv?.optBoolean("press_visible") ?: false,
                lastLatencyMs = lv?.optInt("latency_ms") ?: 0,
                run = s.optInt("run"),
                cameraLive = json.optJSONObject("camera")?.optBoolean("live") ?: prev.cameraLive,
            )
        }
    }
}
