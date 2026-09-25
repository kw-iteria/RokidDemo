package com.iteria.platepress

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Bundle
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
    }

    // Rokid temple button: tap = talk to the assistant, double tap = start / restart the workflow,
    // long press (when the system lets it through) = spoken prompts on/off.
    private val gestures = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                ACTION_CLICK -> model.talk()
                ACTION_DOUBLE_CLICK -> model.gesture("restart")
                ACTION_LONG_PRESS -> model.toggleVoice()
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
                c.targetLongEdge = j.optInt("longEdge", c.targetLongEdge)
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
            c.start()
        }
    }

    override fun onResume() {
        super.onResume()
        val filter = IntentFilter().apply {
            addAction(ACTION_CLICK); addAction(ACTION_DOUBLE_CLICK); addAction(ACTION_LONG_PRESS)
            priority = 100
        }
        ContextCompat.registerReceiver(this, gestures, filter, ContextCompat.RECEIVER_EXPORTED)
    }

    override fun onPause() {
        try { unregisterReceiver(gestures) } catch (_: Exception) {}
        super.onPause()
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean = when (keyCode) {
        KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_DPAD_CENTER -> { model.talk(); true }
        else -> super.onKeyDown(keyCode, event)
    }

    override fun onDestroy() {
        camera?.stop()
        model.close()
        super.onDestroy()
    }

    companion object {
        const val ACTION_CLICK = "com.android.action.ACTION_SPRITE_BUTTON_CLICK"
        const val ACTION_DOUBLE_CLICK = "com.android.action.ACTION_SPRITE_BUTTON_DOUBLE_CLICK"
        const val ACTION_LONG_PRESS = "com.android.action.ACTION_SPRITE_BUTTON_LONG_PRESS"
    }
}
