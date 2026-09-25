package com.iteria.platepress.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameMillis
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathMeasure
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import com.iteria.platepress.HudState
import kotlin.math.min

/*
 * The glasses HUD. The Rokid waveguide is monochrome green and unlit pixels are see-through,
 * so everything is drawn in white on a transparent window and hierarchy comes from size,
 * weight and brightness only. Sizes are relative to the shorter screen edge (`u`).
 */
private val Ink = Color.White
private val Dim = Color.White.copy(alpha = 0.45f)
private val Faint = Color.White.copy(alpha = 0.16f)

@Composable
fun Hud(state: HudState, serverNow: () -> Long, fps: () -> Float) {
    var now by remember { mutableLongStateOf(serverNow()) }
    LaunchedEffect(Unit) { while (true) withFrameMillis { now = serverNow() } }

    BoxWithConstraints(Modifier.fillMaxSize()) {
        val u = min(maxWidth.value, maxHeight.value).dp
        when (state.phase) {
            "CONNECTING", "IDLE" -> Connecting(state, u)
            "SEARCHING" -> Searching(state, u)
            "COUNTDOWN" -> Countdown(state, now, u)
            "AWAIT_OPEN" -> Alarm(state, u)
            "COMPLETE" -> Complete(state, u)
            else -> Instruction(state.message, state.hint.ifBlank { state.sub }, u)
        }
        Foot(state, fps(), u, Modifier.align(Alignment.BottomCenter))
    }
}

@Composable
private fun sp(size: Dp): TextUnit = with(LocalDensity.current) { size.toSp() }

@Composable
private fun Message(text: String, u: Dp, scale: Float = 0.075f, color: Color = Ink, weight: FontWeight = FontWeight.Medium, modifier: Modifier = Modifier) {
    Text(
        text = text,
        color = color,
        style = TextStyle(fontSize = sp(u * scale), fontWeight = weight, lineHeight = sp(u * scale * 1.18f), textAlign = TextAlign.Center),
        modifier = modifier.padding(horizontal = u * 0.06f),
    )
}

@Composable
private fun Instruction(message: String, sub: String, u: Dp) {
    Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Message(message, u)
        Spacer(Modifier.height(u * 0.03f))
        Message(sub, u, scale = 0.04f, color = Dim, weight = FontWeight.Normal)
    }
}

@Composable
private fun Connecting(state: HudState, u: Dp) {
    val breathe by rememberInfiniteTransition(label = "breathe").animateFloat(0.35f, 1f, infiniteRepeatable(tween(1400), RepeatMode.Reverse), label = "a")
    Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Message(if (state.connected) "Waiting for camera" else "Looking for PlatePress on this network", u, scale = 0.05f, color = Dim.copy(alpha = 0.45f * breathe + 0.3f), weight = FontWeight.Normal)
        if (state.host.isNotBlank()) {
            Spacer(Modifier.height(u * 0.02f))
            Message(state.host, u, scale = 0.035f, color = Faint, weight = FontWeight.Normal)
        }
    }
}

@Composable
private fun Searching(state: HudState, u: Dp) {
    val breathe by rememberInfiniteTransition(label = "reticle").animateFloat(0.3f, 1f, infiniteRepeatable(tween(1200), RepeatMode.Reverse), label = "a")
    Box(Modifier.fillMaxSize()) {
        Canvas(Modifier.fillMaxSize().padding(u * 0.12f).graphicsLayer { alpha = breathe }) {
            val len = size.minDimension * 0.12f
            val w = size.minDimension * 0.008f
            val c = Dim
            fun corner(x: Float, y: Float, dx: Float, dy: Float) {
                drawLine(c, Offset(x, y), Offset(x + dx * len, y), w, StrokeCap.Round)
                drawLine(c, Offset(x, y), Offset(x, y + dy * len), w, StrokeCap.Round)
            }
            corner(0f, 0f, 1f, 1f); corner(size.width, 0f, -1f, 1f)
            corner(0f, size.height, 1f, -1f); corner(size.width, size.height, -1f, -1f)
        }
        Instruction(state.message, state.sub, u)
    }
}

@Composable
private fun Countdown(state: HudState, now: Long, u: Dp) {
    val remaining = (state.countdownEndsAt - now).coerceIn(0L, state.countdownDurationMs)
    val frac = remaining.toFloat() / state.countdownDurationMs.toFloat()
    val seconds = ((remaining + 999) / 1000).toInt()
    Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Box(Modifier.size(u * 0.62f), contentAlignment = Alignment.Center) {
            Canvas(Modifier.fillMaxSize()) {
                val stroke = size.minDimension * 0.035f
                val inset = stroke / 2
                val arcSize = Size(size.width - stroke, size.height - stroke)
                drawArc(Faint, 0f, 360f, false, Offset(inset, inset), arcSize, style = Stroke(stroke))
                drawArc(Ink, -90f, 360f * frac, false, Offset(inset, inset), arcSize, style = Stroke(stroke, cap = StrokeCap.Round))
            }
            Text(
                text = seconds.toString(),
                color = Ink,
                style = TextStyle(fontSize = sp(u * 0.30f), fontWeight = FontWeight.Light, letterSpacing = (-0.02).em),
            )
        }
        Spacer(Modifier.height(u * 0.035f))
        Message(state.sub, u, scale = 0.042f, color = Dim, weight = FontWeight.Normal)
    }
}

@Composable
private fun Alarm(state: HudState, u: Dp) {
    val pulse by rememberInfiniteTransition(label = "alarm").animateFloat(1f, 0.2f, infiniteRepeatable(tween(450, easing = LinearEasing), RepeatMode.Reverse), label = "a")
    Box(Modifier.fillMaxSize()) {
        Canvas(Modifier.fillMaxSize().padding(u * 0.04f).graphicsLayer { alpha = pulse }) {
            drawRoundRect(Ink, style = Stroke(size.minDimension * 0.012f), cornerRadius = androidx.compose.ui.geometry.CornerRadius(size.minDimension * 0.05f))
        }
        Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
            Message(state.message, u, scale = 0.085f, weight = FontWeight.SemiBold, modifier = Modifier.graphicsLayer { alpha = 0.55f + 0.45f * pulse })
            Spacer(Modifier.height(u * 0.03f))
            Message(state.hint.ifBlank { state.sub }, u, scale = 0.04f, color = Dim, weight = FontWeight.Normal)
        }
    }
}

@Composable
private fun Complete(state: HudState, u: Dp) {
    val progress = remember { Animatable(0f) }
    LaunchedEffect(state.run) { progress.snapTo(0f); progress.animateTo(1f, tween(650)) }
    Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Canvas(Modifier.size(u * 0.2f)) {
            val path = Path().apply {
                moveTo(size.width * 0.16f, size.height * 0.54f)
                lineTo(size.width * 0.42f, size.height * 0.78f)
                lineTo(size.width * 0.86f, size.height * 0.26f)
            }
            val measure = PathMeasure().apply { setPath(path, false) }
            val partial = Path()
            measure.getSegment(0f, measure.length * progress.value, partial, true)
            drawPath(partial, Ink, style = Stroke(size.minDimension * 0.09f, cap = StrokeCap.Round, join = StrokeJoin.Round))
        }
        Spacer(Modifier.height(u * 0.04f))
        Message(state.sub, u, scale = 0.09f, weight = FontWeight.SemiBold)
        Spacer(Modifier.height(u * 0.015f))
        Message(state.message, u, scale = 0.045f, color = Dim, weight = FontWeight.Normal)
    }
}

@Composable
private fun Foot(state: HudState, fps: Float, u: Dp, modifier: Modifier) {
    Row(
        modifier.fillMaxWidth().padding(horizontal = u * 0.045f, vertical = u * 0.03f),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val left = when {
            !state.connected -> ""
            state.lastLid.isBlank() -> ""
            !state.lastVisible -> "press not seen"
            else -> "press ${state.lastLid} · ${"%.1f".format(state.lastLatencyMs / 1000f)} s"
        }
        Text(left, color = Dim, style = TextStyle(fontSize = sp(u * 0.034f)))
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (!state.voice) {
                Text("muted", color = Faint, style = TextStyle(fontSize = sp(u * 0.034f)))
                Spacer(Modifier.width(u * 0.02f))
            }
            Canvas(Modifier.size(u * 0.022f)) { drawCircle(if (state.connected) Ink else Faint) }
            Spacer(Modifier.width(u * 0.015f))
            Text(if (state.connected) "${"%.0f".format(fps)} fps" else "offline", color = Dim, style = TextStyle(fontSize = sp(u * 0.034f)))
        }
    }
}
