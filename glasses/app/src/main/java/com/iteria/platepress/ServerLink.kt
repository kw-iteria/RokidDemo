package com.iteria.platepress

import android.os.Build
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import java.net.InetAddress
import java.net.Socket
import java.util.concurrent.TimeUnit
import javax.net.SocketFactory

/** WebSocket to the PlatePress server: frames up, state down, clock offset on the side. */
class ServerLink(
    private val onStateJson: (JSONObject) -> Unit,
    private val onConnection: (up: Boolean, endpoint: String) -> Unit,
    private val onEvent: (JSONObject) -> Unit = {},
    private val onBinary: (header: JSONObject, body: ByteArray) -> Unit = { _, _ -> },
) {
    private val client = OkHttpClient.Builder()
        .socketFactory(NoDelaySocketFactory)   // small messages (interrupt, ping) never wait behind Nagle
        // Protocol pings are only a backstop: OkHttp drops the socket when one pong is late by the whole
        // interval, and a 2 s interval cut working links on every short Wi-Fi stall. Liveness is judged
        // by [silentForMs] instead (the server sends state twice a second).
        .pingInterval(10, TimeUnit.SECONDS)
        .connectTimeout(3, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    @Volatile private var ws: WebSocket? = null
    @Volatile var connected = false; private set
    /** serverNow - localNow, so the countdown ring on the glasses agrees with the server. */
    @Volatile var clockOffset = 0L; private set
    @Volatile private var bestRtt = Long.MAX_VALUE
    @Volatile private var bestRttAt = 0L
    @Volatile var endpoint = ""; private set
    @Volatile private var lastHeardAt = 0L
    private var seq = 0

    /** Milliseconds since anything arrived from the server on the live socket. */
    fun silentForMs(): Long = if (connected) System.currentTimeMillis() - lastHeardAt else 0L

    /** The link went quiet for too long: drop it and tell the owner, so the connection loop starts over. */
    fun dropSilent() { close(); markDown() }

    // Every connect() starts a new generation. Callbacks from an older socket (one we already dropped,
    // e.g. a slow attempt to a stale remembered address) must not touch the state: its late
    // onFailure used to mark a freshly opened, working connection as down.
    @Volatile private var generation = 0

    fun connect(host: String, port: Int) {
        close()
        endpoint = "$host:$port"
        val gen = ++generation
        val request = Request.Builder().url("ws://$host:$port/ws/glasses").build()
        ws = client.newWebSocket(request, object : WebSocketListener() {
            private fun current() = gen == generation
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (!current()) { webSocket.close(1000, "superseded"); return }
                connected = true
                lastHeardAt = System.currentTimeMillis()
                val device = JSONObject()
                    .put("model", Build.MODEL).put("manufacturer", Build.MANUFACTURER)
                    .put("sdk", Build.VERSION.SDK_INT).put("app", BuildConfig.VERSION_NAME)
                webSocket.send(JSONObject().put("t", "hello").put("device", device).toString())
                onConnection(true, endpoint)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (!current()) return
                lastHeardAt = System.currentTimeMillis()
                try {
                    val j = JSONObject(text)
                    when (j.optString("t")) {
                        "state" -> {
                            // Only a first estimate: later the RTT-corrected pong sample is kept, so the
                            // countdown ring does not jump by the one-way delay on every state message.
                            if (bestRtt == Long.MAX_VALUE) clockOffset = j.getLong("server_now") - System.currentTimeMillis()
                            onStateJson(j)
                        }
                        "pong" -> {
                            val now = System.currentTimeMillis()
                            val rtt = now - j.getLong("ts")
                            // keep the lowest-RTT sample (most accurate); re-accept after 30 s so drift is tracked
                            if (rtt <= bestRtt || now - bestRttAt > 30_000) {
                                bestRtt = rtt; bestRttAt = now
                                clockOffset = j.getLong("server_now") + rtt / 2 - now
                            }
                        }
                        "chat", "chat.delta", "chat.thinking", "chat.reset", "camera", "voice" -> onEvent(j)
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "bad message: ${e.message}")
                }
            }

            override fun onMessage(webSocket: WebSocket, bytes: okio.ByteString) {
                if (!current()) return
                lastHeardAt = System.currentTimeMillis()
                try {
                    val b = bytes.toByteArray()
                    if (b.size < 4) return
                    val n = ((b[0].toInt() and 0xff) shl 8) or (b[1].toInt() and 0xff)
                    if (2 + n > b.size) return
                    val header = JSONObject(String(b, 2, n, Charsets.UTF_8))
                    onBinary(header, b.copyOfRange(2 + n, b.size))
                } catch (e: Exception) { Log.w(TAG, "bad binary message: ${e.message}") }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.w(TAG, "websocket failure (${if (current()) "current" else "stale"}): ${t.message}")
                if (current()) markDown()
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(1000, null) }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { if (current()) markDown() }
        })
    }

    private fun markDown() {
        connected = false
        bestRtt = Long.MAX_VALUE
        onConnection(false, endpoint)
    }

    /** Sends one JPEG in the shared envelope: [u16 headerLen][JSON header][JPEG]. Drops the frame when the socket is congested. */
    fun sendFrame(jpeg: ByteArray, w: Int, h: Int, motion: Float = 0f): Boolean {
        val socket = ws ?: return false
        if (!connected) return false
        // Drop instead of queueing: a backlog of JPEGs makes every frame stale and delays voice uploads
        // that share this socket. At most about one frame may be waiting.
        if (socket.queueSize() > 64_000L) return false
        val header = JSONObject().put("seq", seq++).put("ts", System.currentTimeMillis()).put("w", w).put("h", h).put("motion", (motion * 1000).toInt() / 1000.0).toString().toByteArray()
        val out = ByteArray(2 + header.size + jpeg.size)
        out[0] = (header.size shr 8).toByte()
        out[1] = (header.size and 0xff).toByte()
        System.arraycopy(header, 0, out, 2, header.size)
        System.arraycopy(jpeg, 0, out, 2 + header.size, jpeg.size)
        return socket.send(out.toByteString())
    }

    fun sendJson(obj: JSONObject) { ws?.send(obj.toString()) }

    /** True while more than about one frame is waiting in the socket (a frame encoded now would only be dropped). */
    fun congested(): Boolean = (ws?.queueSize() ?: 0L) > 64_000L

    /**
     * Spoken audio: same envelope as frames, header {"t":"audio","rate":16000,...}, body PCM16 mono.
     * `stage` "partial" / "final" with the utterance id and part number implement the two-step hand-over
     * described in [Listener]; without a stage the body is a whole utterance.
     */
    fun sendAudio(pcm: ByteArray, sampleRate: Int, utt: Long = 0L, part: Int = 0, stage: String = "", extends: Boolean = false): Boolean {
        val socket = ws ?: return false
        if (!connected) return false
        val header = JSONObject().put("t", "audio").put("rate", sampleRate).put("ts", System.currentTimeMillis())
            .apply { if (stage.isNotEmpty()) put("stage", stage).put("utt", utt).put("part", part).put("extends", extends) }
            .toString().toByteArray()
        val out = ByteArray(2 + header.size + pcm.size)
        out[0] = (header.size shr 8).toByte()
        out[1] = (header.size and 0xff).toByte()
        System.arraycopy(header, 0, out, 2, header.size)
        System.arraycopy(pcm, 0, out, 2 + header.size, pcm.size)
        return socket.send(out.toByteString())
    }
    fun ping() { sendJson(JSONObject().put("t", "ping").put("ts", System.currentTimeMillis())) }

    fun close() {
        generation++ // anything the old socket reports from now on is ignored
        ws?.cancel()
        ws = null
        connected = false
    }

    companion object { const val TAG = "ServerLink" }

    /** Plain sockets with TCP_NODELAY on. */
    private object NoDelaySocketFactory : SocketFactory() {
        private val base = SocketFactory.getDefault()
        private fun Socket.nd(): Socket = apply { tcpNoDelay = true }
        override fun createSocket(): Socket = base.createSocket().nd()
        override fun createSocket(host: String?, port: Int): Socket = base.createSocket(host, port).nd()
        override fun createSocket(host: String?, port: Int, localHost: InetAddress?, localPort: Int): Socket = base.createSocket(host, port, localHost, localPort).nd()
        override fun createSocket(host: InetAddress?, port: Int): Socket = base.createSocket(host, port).nd()
        override fun createSocket(address: InetAddress?, port: Int, localAddress: InetAddress?, localPort: Int): Socket = base.createSocket(address, port, localAddress, localPort).nd()
    }
}
