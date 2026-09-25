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

class MainActivity : ComponentActivity() {
    private lateinit var model: AppModel
    private var camera: CameraStreamer? = null

    private val cameraPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) startCamera()
    }

    // Rokid temple button: tap = restart after completion, long press = restart now, double tap = voice on/off.
    private val gestures = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                ACTION_CLICK -> model.gesture("tap")
                ACTION_LONG_PRESS -> model.gesture("restart")
                ACTION_DOUBLE_CLICK -> model.toggleVoice()
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        model = AppModel(this)
        model.start()
        setContent {
            val state by model.state.collectAsState()
            Hud(
                state = state,
                serverNow = { System.currentTimeMillis() + model.clockOffset() },
                fps = { camera?.fps ?: 0f },
            )
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) startCamera()
        else cameraPermission.launch(Manifest.permission.CAMERA)
    }

    private fun startCamera() {
        if (camera != null) return
        camera = CameraStreamer(this, this) { jpeg, w, h -> model.onFrame(jpeg, w, h) }.also { it.start() }
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
        KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_DPAD_CENTER -> { model.gesture("tap"); true }
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
