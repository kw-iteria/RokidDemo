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
/** The computer over the USB cable, via `adb reverse` (see tools/install_glasses.sh). */
private const val USB_HOST = "127.0.0.1"

class AppModel(context: Context) {
    private val app = context.applicationContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val _state = MutableStateFlow(HudState())
    val state: StateFlow<HudState> = _state
    val sounds = Sounds(app)
    private val discovery = Discovery(app)
    private val prefs = app.getSharedPreferences("platepress", Context.MODE_PRIVATE)
    val player = VoicePlayer()
    @Volatile private var serverVoice = true   // replies spoken by the server's neural voice (else device TTS)
    @Volatile private var stagedStt = false    // the server takes the two-step utterance hand-over (an older one would answer the partial)
    val link = ServerLink(
        onStateJson = ::onServerState,
        onConnection = { up, endpoint -> _state.update { it.copy(connected = up, host = endpoint, phase = if (up) it.phase else "CONNECTING") } },
        onEvent = ::onServerEvent,
        onBinary = { header, body -> if (header.optString("t") == "tts" && sounds.voiceEnabled) player.enqueue(header.optString("id"), header.optInt("rate", 24_000), body, header.optBoolean("stop"), header.optBoolean("last")) },
    )
    private val listener = Listener(
        onPartial = { utt, part, pcm, rate -> stagedStt && link.connected && link.sendAudio(pcm, rate, utt, part, "partial") },
        onUtterance = { utt, part, extends, pcm, rate ->
            if (link.connected) { link.sendAudio(pcm, rate, utt, part, if (stagedStt) "final" else "", extends); _state.update { it.copy(thinking = true, chatStreaming = "", heardText = "") } }
        },
        onSpeech = { speaking -> _state.update { it.copy(speaking = speaking) } },
        isSpeakerBusy = { sounds.isSpeaking() || player.isPlaying() },
    )
    private val wifiJoiner = WifiJoiner(app)
    @Volatile private var pairingJob: Job? = null
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
                    link.sendJson(JSONObject().put("t", "status").put("camera", cameraStatus()).put("voice", sounds.voiceEnabled)
                        .put("mic", JSONObject().put("enabled", listener.enabled).put("running", listener.running).put("source", listener.source)
                            .put("noise", listener.noiseFloor.toInt()).put("peak", listener.lastPeak.toInt()).put("utterances", listener.utterances)))
                }
            }
        }
    }

    private suspend fun connectionLoop() {
        while (currentCoroutineContext().isActive) {
            if (pairingJob?.isActive == true) { delay(300); continue } // the pairing code is in charge
            if (!link.connected) {
                val fallback = BuildConfig.FALLBACK_HOST.takeIf { it.isNotBlank() }?.let { it to BuildConfig.SERVER_PORT }
                val remembered = prefs.getString("host", null)?.let { it to prefs.getInt("port", BuildConfig.SERVER_PORT) }
                // Try the last good server straight away (a restart keeps its address); only listen for
                // the discovery beacon when that fails, instead of always waiting up to 2.5 s first.
                val ok = remembered != null && tryConnect(remembered, 1500)
                val viaWifi = ok || run {
                    val target = withContext(Dispatchers.IO) { discovery.listen(2500) } ?: fallback
                    target != null && tryConnect(target, 4000)
                }
                // USB cable: `adb reverse tcp:8787 tcp:8787` (tools/install_glasses.sh sets it up) makes the
                // computer reachable at localhost even when the Wi-Fi keeps devices apart (client isolation).
                if (!viaWifi) tryConnect(USB_HOST to BuildConfig.SERVER_PORT, 800)
            }
            delay(if (link.connected) 1000 else 300)
        }
    }

    /** Camera frames while not connected: look for the console's pairing code. */
    fun scanForPairing(bmp: android.graphics.Bitmap) {
        if (link.connected || pairingJob?.isActive == true) return
        val code = PairingCode.scan(bmp) ?: return
        pairingJob = scope.launch { pairWith(code) }
    }

    private fun pairingStatus(text: String) = _state.update { it.copy(pairing = text) }

    /** Connect to the computer from the code; join its Wi-Fi first if it can't be reached. */
    private suspend fun pairWith(code: PairingCode) {
        sounds.tick()
        pairingStatus("Found your computer")
        suspend fun reach(timeoutMs: Int): Boolean { for (h in code.hosts) if (tryConnect(h to code.port, timeoutMs)) return true; return false }
        if (reach(3000) || tryConnect(USB_HOST to code.port, 800)) return pairedOk()
        if (code.ssid.isNotEmpty()) {
            pairingStatus("Joining ${code.ssid}…")
            if (!wifiJoiner.join(code.ssid, code.password)) {
                pairingStatus("Couldn't join ${code.ssid}. Check the Wi-Fi password on the computer.")
                delay(5000); pairingStatus(""); return
            }
            pairingStatus("Connecting to your computer…")
            repeat(8) { if (reach(2500)) return pairedOk(); delay(500) }
        }
        // Same network name is not enough: many office/mesh Wi-Fis isolate devices from each other.
        pairingStatus("Your Wi-Fi is keeping the glasses and computer apart. Plug in the cable, or try another network.")
        delay(5000); pairingStatus("")
    }

    private fun pairedOk() { pairingStatus(""); sounds.chime() }

    private suspend fun tryConnect(target: Pair<String, Int>, timeoutMs: Int): Boolean {
        _state.update { it.copy(host = "${target.first}:${target.second}") }
        link.connect(target.first, target.second)
        var waited = 0
        while (!link.connected && waited < timeoutMs) { delay(50); waited += 50 }
        // Only remember this address if *this* connection is the live one (another path, e.g. the pairing
        // code, may have connected elsewhere in the meantime).
        val ok = link.connected && link.endpoint == "${target.first}:${target.second}"
        if (ok && target.first != USB_HOST) prefs.edit().putString("host", target.first).putInt("port", target.second).apply()
        return ok
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
            "chat" -> when (j.optString("role")) {
                "assistant" -> {
                    val text = j.optString("text")
                    _state.update { it.copy(chatText = text, chatAt = System.currentTimeMillis(), chatStreaming = "", thinking = false) }
                    if (!serverVoice) sounds.say(text)   // otherwise the neural voice is already streaming in
                }
                "user" -> if (j.optString("from").startsWith("glasses")) _state.update { it.copy(heardText = j.optString("text"), heardAt = System.currentTimeMillis(), thinking = true) }
            }
            "chat.reset" -> {   // new conversation (from the console, a voice command or a triple tap)
                player.flush()
                _state.update { it.copy(chatText = "", chatAt = 0L, chatStreaming = "", heardText = "", thinking = false) }
            }
            "chat.delta" -> _state.update { it.copy(chatStreaming = it.chatStreaming + j.optString("delta"), thinking = true) }
            "chat.thinking" -> _state.update { it.copy(thinking = j.optBoolean("on") || it.chatStreaming.isNotEmpty()) }
            "camera" -> applyCamera(j)
            "voice" -> { serverVoice = j.optString("mode") == "server"; stagedStt = j.optString("stt") == "staged" }
        }
    }

    /** Start the always-on microphone (after the permission is granted). */
    fun startListening() {
        listener.start()
        _state.update { it.copy(listening = listener.enabled) }
    }

    /** Temple tap: stop whatever the assistant is saying and listen (never mutes). */
    fun attention() {
        player.flush()
        listener.clearEchoGuard = true
        link.sendJson(JSONObject().put("t", "interrupt"))
        if (!listener.enabled) { listener.enabled = true; _state.update { it.copy(listening = true) } }
        if (!listener.running) listener.start()
        _state.update { it.copy(thinking = false, chatStreaming = "") }
        sounds.tick()
    }

    /** Triple tap: start a new conversation (the server keeps the old one in the console's history). */
    fun newConversation() {
        player.flush()
        link.sendJson(JSONObject().put("t", "new_chat"))
        sounds.chime()
    }

    /** Long press: mute / unmute the microphone. */
    fun toggleMic() {
        listener.enabled = !listener.enabled
        _state.update { it.copy(listening = listener.enabled) }
        if (listener.enabled) sounds.tick() else sounds.chime()
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

    fun onFrame(jpeg: ByteArray, w: Int, h: Int, motion: Float) { link.sendFrame(jpeg, w, h, motion) }
    fun gesture(name: String) { link.sendJson(JSONObject().put("t", "gesture").put("name", name)) }
    fun toggleVoice(): Boolean {
        sounds.voiceEnabled = !sounds.voiceEnabled
        _state.update { it.copy(voice = sounds.voiceEnabled) }
        if (!sounds.voiceEnabled) { player.flush(); sounds.tick() } else sounds.chime()
        return sounds.voiceEnabled
    }

    fun close() {
        listener.shutdown()
        player.release()
        stopAlarm()
        scope.cancel()
        link.close()
        sounds.release()
    }
}
