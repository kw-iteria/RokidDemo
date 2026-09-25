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
import java.util.concurrent.TimeUnit

/** WebSocket to the PlatePress server: frames up, state down, clock offset on the side. */
class ServerLink(
    private val onStateJson: (JSONObject) -> Unit,
    private val onConnection: (up: Boolean, endpoint: String) -> Unit,
    private val onEvent: (JSONObject) -> Unit = {},
) {
    private val client = OkHttpClient.Builder()
        .pingInterval(5, TimeUnit.SECONDS)
        .connectTimeout(3, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    @Volatile private var ws: WebSocket? = null
    @Volatile var connected = false; private set
    /** serverNow - localNow, so the countdown ring on the glasses agrees with the server. */
    @Volatile var clockOffset = 0L; private set
    @Volatile var endpoint = ""; private set
    private var seq = 0

    fun connect(host: String, port: Int) {
        close()
        endpoint = "$host:$port"
        val request = Request.Builder().url("ws://$host:$port/ws/glasses").build()
        ws = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                connected = true
                val device = JSONObject()
                    .put("model", Build.MODEL).put("manufacturer", Build.MANUFACTURER)
                    .put("sdk", Build.VERSION.SDK_INT).put("app", BuildConfig.VERSION_NAME)
                webSocket.send(JSONObject().put("t", "hello").put("device", device).toString())
                onConnection(true, endpoint)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                try {
                    val j = JSONObject(text)
                    when (j.optString("t")) {
                        "state" -> {
                            clockOffset = j.getLong("server_now") - System.currentTimeMillis()
                            onStateJson(j)
                        }
                        "pong" -> {
                            val rtt = System.currentTimeMillis() - j.getLong("ts")
                            clockOffset = j.getLong("server_now") + rtt / 2 - System.currentTimeMillis()
                        }
                        "chat", "chat.thinking" -> onEvent(j)
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "bad message: ${e.message}")
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.w(TAG, "websocket failure: ${t.message}")
                markDown()
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(1000, null) }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { markDown() }
        })
    }

    private fun markDown() {
        connected = false
        onConnection(false, endpoint)
    }

    /** Sends one JPEG in the shared envelope: [u16 headerLen][JSON header][JPEG]. Drops the frame when the socket is congested. */
    fun sendFrame(jpeg: ByteArray, w: Int, h: Int): Boolean {
        val socket = ws ?: return false
        if (!connected) return false
        if (socket.queueSize() > 400_000L) return false
        val header = JSONObject().put("seq", seq++).put("ts", System.currentTimeMillis()).put("w", w).put("h", h).toString().toByteArray()
        val out = ByteArray(2 + header.size + jpeg.size)
        out[0] = (header.size shr 8).toByte()
        out[1] = (header.size and 0xff).toByte()
        System.arraycopy(header, 0, out, 2, header.size)
        System.arraycopy(jpeg, 0, out, 2 + header.size, jpeg.size)
        return socket.send(out.toByteString())
    }

    fun sendJson(obj: JSONObject) { ws?.send(obj.toString()) }

    /** Push-to-talk audio: same envelope as frames, header {"t":"audio","rate":16000}, body PCM16 mono. */
    fun sendAudio(pcm: ByteArray, sampleRate: Int): Boolean {
        val socket = ws ?: return false
        if (!connected) return false
        val header = JSONObject().put("t", "audio").put("rate", sampleRate).put("ts", System.currentTimeMillis()).toString().toByteArray()
        val out = ByteArray(2 + header.size + pcm.size)
        out[0] = (header.size shr 8).toByte()
        out[1] = (header.size and 0xff).toByte()
        System.arraycopy(header, 0, out, 2, header.size)
        System.arraycopy(pcm, 0, out, 2 + header.size, pcm.size)
        return socket.send(out.toByteString())
    }
    fun ping() { sendJson(JSONObject().put("t", "ping").put("ts", System.currentTimeMillis())) }

    fun close() {
        ws?.cancel()
        ws = null
        connected = false
    }

    companion object { const val TAG = "ServerLink" }
}
