package com.iteria.platepress

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

/** Owns the server connection, the HUD state, and the sound reactions to phase changes. */
class AppModel(context: Context) {
    private val app = context.applicationContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val _state = MutableStateFlow(HudState())
    val state: StateFlow<HudState> = _state
    val sounds = Sounds(app)
    private val discovery = Discovery(app)
    private val prefs = app.getSharedPreferences("platepress", Context.MODE_PRIVATE)
    val link = ServerLink(
        onStateJson = ::onServerState,
        onConnection = { up, endpoint -> _state.update { it.copy(connected = up, host = endpoint, phase = if (up) it.phase else "CONNECTING") } },
        onEvent = ::onServerEvent,
    )
    private val talk = PushToTalk(
        onAudio = { pcm, rate -> link.sendAudio(pcm, rate); _state.update { it.copy(thinking = true) } },
        onState = { rec -> _state.update { it.copy(listening = rec) }; if (rec) sounds.tick() },
    )
    private var lastPhase = ""
    private var alarmJob: Job? = null

    fun clockOffset(): Long = link.clockOffset

    /** Filled in by the activity so the heartbeat can report camera health to the server. */
    var cameraStatus: () -> JSONObject = { JSONObject().put("status", "no camera object") }
    /** Filled in by the activity: applies camera settings pushed from the console. */
    var applyCamera: (JSONObject) -> Unit = {}

    fun start() {
        scope.launch { connectionLoop() }
        scope.launch {
            while (isActive) {
                delay(2000)
                if (link.connected) {
                    link.ping()
                    link.sendJson(JSONObject().put("t", "status").put("camera", cameraStatus()).put("voice", sounds.voiceEnabled))
                }
            }
        }
    }

    private suspend fun connectionLoop() {
        while (currentCoroutineContext().isActive) {
            if (!link.connected) {
                val fallback = BuildConfig.FALLBACK_HOST.takeIf { it.isNotBlank() }?.let { it to BuildConfig.SERVER_PORT }
                val remembered = prefs.getString("host", null)?.let { it to prefs.getInt("port", BuildConfig.SERVER_PORT) }
                val target = withContext(Dispatchers.IO) { discovery.listen(2500) } ?: remembered ?: fallback
                if (target != null) {
                    _state.update { it.copy(host = "${target.first}:${target.second}") }
                    link.connect(target.first, target.second)
                    var waited = 0
                    while (!link.connected && waited < 4000) { delay(100); waited += 100 }
                    if (link.connected) prefs.edit().putString("host", target.first).putInt("port", target.second).apply()
                    else prefs.edit().remove("host").apply()
                }
            }
            delay(1000)
        }
    }

    private fun onServerState(json: JSONObject) {
        val next = HudState.fromServer(json, _state.value).copy(connected = true, voice = sounds.voiceEnabled)
        _state.value = next
        if (next.phase != lastPhase) {
            onPhaseChange(next.phase)
            lastPhase = next.phase
        }
    }

    private fun onServerEvent(j: JSONObject) {
        when (j.optString("t")) {
            "chat" -> if (j.optString("role") == "assistant") {
                val text = j.optString("text")
                _state.update { it.copy(chatText = text, chatAt = System.currentTimeMillis(), thinking = false) }
                sounds.say(text)
            }
            "chat.thinking" -> _state.update { it.copy(thinking = j.optBoolean("on")) }
            "camera" -> applyCamera(j)
        }
    }

    /** Temple tap: record one utterance and send it to the assistant. */
    fun talk() {
        if (!link.connected) { sounds.tick(); return }
        talk.toggle()
    }

    private fun onPhaseChange(to: String) {
        when (to) {
            "AWAIT_CLOSE" -> { sounds.tick(); sounds.say("Please close the plate press") }
            "COUNTDOWN" -> sounds.chime()
            "AWAIT_OPEN" -> sounds.say("Open the plate press")
            "COMPLETE" -> { sounds.done(); sounds.say("Plate press motion completed") }
        }
        if (to == "AWAIT_OPEN") startAlarm() else stopAlarm()
    }

    private fun startAlarm() {
        alarmJob?.cancel()
        alarmJob = scope.launch { while (isActive) { sounds.alarmBeep(); delay(700) } }
    }

    private fun stopAlarm() {
        alarmJob?.cancel()
        alarmJob = null
    }

    fun onFrame(jpeg: ByteArray, w: Int, h: Int) { link.sendFrame(jpeg, w, h) }
    fun gesture(name: String) { link.sendJson(JSONObject().put("t", "gesture").put("name", name)) }
    fun toggleVoice(): Boolean {
        sounds.voiceEnabled = !sounds.voiceEnabled
        _state.update { it.copy(voice = sounds.voiceEnabled) }
        if (sounds.voiceEnabled) sounds.say("Voice on") else sounds.tick()
        return sounds.voiceEnabled
    }

    fun close() {
        talk.stop()
        stopAlarm()
        scope.cancel()
        link.close()
        sounds.release()
    }
}
