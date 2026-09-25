package com.iteria.platepress

import android.content.Context
import android.net.wifi.WifiManager
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetSocketAddress

/** Listens for the server's UDP beacon so nobody has to type an IP address on the glasses. */
class Discovery(context: Context) {
    private val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
    private val lock = wifi.createMulticastLock("platepress-discovery").apply { setReferenceCounted(false) }

    /** Blocks up to [timeoutMs]; returns (host, port) of the first beacon heard, or null. */
    fun listen(timeoutMs: Int): Pair<String, Int>? {
        try { lock.acquire() } catch (_: Exception) {}
        var socket: DatagramSocket? = null
        try {
            socket = DatagramSocket(null).apply {
                reuseAddress = true
                broadcast = true
                soTimeout = timeoutMs
                bind(InetSocketAddress(PORT))
            }
            val buf = ByteArray(2048)
            val deadline = System.currentTimeMillis() + timeoutMs
            while (System.currentTimeMillis() < deadline) {
                val packet = DatagramPacket(buf, buf.size)
                socket.receive(packet)
                val json = JSONObject(String(packet.data, 0, packet.length))
                if (json.optString("t") == "platepress") {
                    val host = packet.address.hostAddress ?: continue
                    return host to json.optInt("port", BuildConfig.SERVER_PORT)
                }
            }
        } catch (_: Exception) {
            // timeout or socket error: caller retries
        } finally {
            socket?.close()
            try { lock.release() } catch (_: Exception) {}
        }
        return null
    }

    companion object { const val PORT = 47474 }
}
