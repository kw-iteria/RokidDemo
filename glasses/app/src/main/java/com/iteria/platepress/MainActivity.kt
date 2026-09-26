package com.iteria.platepress

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.core.content.ContextCompat
import com.iteria.platepress.ui.Hud
import org.json.JSONObject

class MainActivity : ComponentActivity() {
    private lateinit var model: AppModel
    private var camera: CameraStreamer? = null

    private val permissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
        if (granted[Manifest.permission.CAMERA] == true) startCamera()
        if (granted[Manifest.permission.RECORD_AUDIO] == true) model.startListening()
    }

    // Rokid temple button: tap = interrupt the assistant and listen (never mutes),
    // double tap = start / restart the workflow, triple tap = new conversation,
    // long press (when the system lets it through) = microphone mute/unmute.
    // The system only reports tap / double tap / long press, so a triple tap is a double tap followed
    // by a tap within TRIPLE_WINDOW_MS; the double-tap action waits that long to tell them apart.
    private val ui = Handler(Looper.getMainLooper())
    private var pendingDouble: Runnable? = null
    private val gestures = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                ACTION_CLICK -> {
                    val double = pendingDouble
                    if (double != null) { ui.removeCallbacks(double); pendingDouble = null; model.newConversation() }
                    else model.attention()
                }
                ACTION_DOUBLE_CLICK -> {
                    pendingDouble?.let { ui.removeCallbacks(it) }
                    val r = Runnable { pendingDouble = null; model.gesture("restart") }
                    pendingDouble = r
                    ui.postDelayed(r, TRIPLE_WINDOW_MS)
                }
                ACTION_LONG_PRESS -> model.toggleMic()
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        model = AppModel(this)
        model.cameraStatus = {
            val c = camera
            val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
            JSONObject().put("permission", granted).put("status", c?.status ?: if (granted) "not started" else "permission not granted")
                .put("frames", c?.framesSent ?: 0).put("fps", c?.fps ?: 0f).put("error", c?.lastError ?: "")
        }
        model.applyCamera = { j ->
            camera?.let { c ->
                c.extraRotation = j.optInt("rotation", c.extraRotation)
                c.mirror = j.optBoolean("mirror", c.mirror)
                c.setLongEdge(j.optInt("longEdge", c.targetLongEdge))
                c.targetFps = j.optDouble("fps", c.targetFps)
                c.aspect = j.optString("aspect", c.aspect)
            }
            pendingCamera = j
        }
        model.start()
        setContent {
            val state by model.state.collectAsState()
            Hud(
                state = state,
                serverNow = { System.currentTimeMillis() + model.clockOffset() },
                fps = { camera?.fps ?: 0f },
            )
        }
        val needed = listOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO)
            .filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) startCamera()
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) model.startListening()
        if (needed.isNotEmpty()) permissions.launch(needed.toTypedArray())
    }

    private var pendingCamera: JSONObject? = null

    private fun startCamera() {
        if (camera != null) return
        camera = CameraStreamer(this, this) { jpeg, w, h, motion -> model.onFrame(jpeg, w, h, motion) }.also { c ->
            pendingCamera?.let { j ->
                c.extraRotation = j.optInt("rotation", 0); c.mirror = j.optBoolean("mirror", false)
                c.targetLongEdge = j.optInt("longEdge", 480); c.targetFps = j.optDouble("fps", 6.0)
                c.aspect = j.optString("aspect", "native")
            }
            c.scanner = { bmp -> model.scanForPairing(bmp) }
            c.scanWhile = { !model.link.connected }
            c.wanted = { model.link.connected && !model.link.congested() }
            c.start()
        }
    }

    // Keeps the Wi-Fi radio out of power save while Iteria is on screen. Measured without it (Rokid
    // RG-glasses, Android 12, 2.4 GHz): Mac -> glasses round trip 61 ms average, 221 ms worst, because the
    // radio sleeps between beacons; that delays the spoken replies and HUD updates sent to the glasses.
    private val wifiLock by lazy {
        val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as android.net.wifi.WifiManager
        @Suppress("DEPRECATION")
        val mode = if (android.os.Build.VERSION.SDK_INT >= 29) android.net.wifi.WifiManager.WIFI_MODE_FULL_LOW_LATENCY else android.net.wifi.WifiManager.WIFI_MODE_FULL_HIGH_PERF
        wm.createWifiLock(mode, "iteria-low-latency").apply { setReferenceCounted(false) }
    }

    override fun onResume() {
        super.onResume()
        try { wifiLock.acquire() } catch (e: Exception) { android.util.Log.w("MainActivity", "wifi lock: ${e.message}") }
        val filter = IntentFilter().apply {
            addAction(ACTION_CLICK); addAction(ACTION_DOUBLE_CLICK); addAction(ACTION_LONG_PRESS)
            priority = 100
        }
        ContextCompat.registerReceiver(this, gestures, filter, ContextCompat.RECEIVER_EXPORTED)
    }

    override fun onPause() {
        try { unregisterReceiver(gestures) } catch (_: Exception) {}
        try { if (wifiLock.isHeld) wifiLock.release() } catch (_: Exception) {}
        super.onPause()
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean = when (keyCode) {
        KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_DPAD_CENTER -> { model.attention(); true }
        else -> super.onKeyDown(keyCode, event)
    }

    override fun onDestroy() {
        camera?.stop()
        model.close()
        super.onDestroy()
    }

    companion object {
        const val TRIPLE_WINDOW_MS = 450L
        const val ACTION_CLICK = "com.android.action.ACTION_SPRITE_BUTTON_CLICK"
        const val ACTION_DOUBLE_CLICK = "com.android.action.ACTION_SPRITE_BUTTON_DOUBLE_CLICK"
        const val ACTION_LONG_PRESS = "com.android.action.ACTION_SPRITE_BUTTON_LONG_PRESS"
    }
}
