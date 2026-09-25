package com.iteria.platepress.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.border
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
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.geometry.CornerRadius
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
 * The glasses HUD. The Rokid waveguide is monochrome green and unlit pixels are see-through, so
 * everything is white on a transparent window. Nothing sits in the middle of the view: the
 * countdown / check mark live in the top-right corner, instructions run as a subtitle along the
 * bottom, and the assistant's replies appear as a card just above them. `u` = shorter screen edge.
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
            "SEARCHING" -> Reticle(u)
            "AWAIT_OPEN" -> AlarmFrame(u)
        }
        Box(Modifier.align(Alignment.TopEnd).padding(top = u * 0.045f, end = u * 0.045f).size(u * 0.27f)) {
            when (state.phase) {
                "COUNTDOWN" -> CountdownDial(state, now, u)
                "COMPLETE" -> CheckMark(state, u)
            }
        }
        Subtitle(state, u, Modifier.align(Alignment.BottomCenter))
        Foot(state, fps(), u, Modifier.align(Alignment.BottomCenter))
    }
}

@Composable
private fun sp(size: Dp): TextUnit = with(LocalDensity.current) { size.toSp() }

@Composable
private fun Line(text: String, u: Dp, scale: Float, color: Color = Ink, weight: FontWeight = FontWeight.Medium, modifier: Modifier = Modifier) {
    Text(
        text = text,
        color = color,
        style = TextStyle(fontSize = sp(u * scale), fontWeight = weight, lineHeight = sp(u * scale * 1.2f), textAlign = TextAlign.Center),
        modifier = modifier.padding(horizontal = u * 0.05f),
    )
}

/** Instruction line(s) along the bottom; the assistant's latest reply floats just above while fresh. */
@Composable
private fun Subtitle(state: HudState, u: Dp, modifier: Modifier) {
    val pulse by rememberInfiniteTransition(label = "alarm").animateFloat(1f, 0.25f, infiniteRepeatable(tween(450, easing = LinearEasing), RepeatMode.Reverse), label = "a")
    val breathe by rememberInfiniteTransition(label = "breathe").animateFloat(0.35f, 1f, infiniteRepeatable(tween(1400), RepeatMode.Reverse), label = "b")
    val chatFresh = state.chatText.isNotBlank() && System.currentTimeMillis() - state.chatAt < 12_000
    val heardFresh = state.heardText.isNotBlank() && System.currentTimeMillis() - state.heardAt < 6_000
    Column(modifier.fillMaxWidth().padding(bottom = u * 0.11f), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Bottom) {
        if (heardFresh && (state.thinking || state.chatStreaming.isNotEmpty())) {
            Line("\u201c${state.heardText}\u201d", u, 0.036f, color = Dim, weight = FontWeight.Normal)
            Spacer(Modifier.height(u * 0.012f))
        }
        when {
            state.speaking -> Row(verticalAlignment = Alignment.CenterVertically) { Robot(u, size = u * 0.1f); Spacer(Modifier.width(u * 0.02f)); Line("Listening…", u, 0.04f, color = Dim.copy(alpha = 0.3f + 0.6f * breathe), weight = FontWeight.Normal) }
            state.chatStreaming.isNotEmpty() -> Row(verticalAlignment = Alignment.Bottom) { Robot(u, size = u * 0.1f); Spacer(Modifier.width(u * 0.02f)); Bubble(state.chatStreaming, u) }
            state.thinking -> Row(verticalAlignment = Alignment.CenterVertically) { Robot(u, thinking = true, size = u * 0.1f); Spacer(Modifier.width(u * 0.02f)); ThinkingBubble(u) }
            chatFresh -> Row(verticalAlignment = Alignment.Bottom) { Robot(u, size = u * 0.1f); Spacer(Modifier.width(u * 0.02f)); Bubble(state.chatText, u) }
        }
        Spacer(Modifier.height(u * 0.02f))
        when (state.phase) {
            "CONNECTING" -> {
                Line(if (state.connected) "Connected" else "Looking for the Iteria server on this network", u, 0.045f, color = Dim.copy(alpha = 0.4f + 0.5f * breathe), weight = FontWeight.Normal)
                if (state.host.isNotBlank()) Line(state.host, u, 0.032f, color = Faint, weight = FontWeight.Normal)
            }
            "IDLE" -> {
                val busy = state.speaking || state.thinking || state.chatStreaming.isNotEmpty() || chatFresh
                if (!busy) Robot(u, listening = state.listening)
                if (!state.cameraLive) Line("waiting for camera", u, 0.032f, color = Faint, weight = FontWeight.Normal)
            }
            "COUNTDOWN" -> Line(state.sub, u, 0.042f, color = Dim, weight = FontWeight.Normal)
            "AWAIT_OPEN" -> {
                Line(state.message, u, 0.062f, weight = FontWeight.SemiBold, modifier = Modifier.graphicsLayer { alpha = 0.55f + 0.45f * pulse })
                Line(state.hint.ifBlank { state.sub }, u, 0.036f, color = Dim, weight = FontWeight.Normal)
            }
            "COMPLETE" -> {
                Line(state.sub, u, 0.06f, weight = FontWeight.SemiBold)
                Line(state.message, u, 0.038f, color = Dim, weight = FontWeight.Normal)
            }
            else -> {
                Line(state.message, u, 0.056f)
                Line(state.hint.ifBlank { state.sub }, u, 0.036f, color = Dim, weight = FontWeight.Normal)
            }
        }
    }
}

/** A small friendly robot: round head, two blinking eyes, antenna. Eyes glance around while thinking. */
@Composable
private fun Robot(u: Dp, thinking: Boolean = false, size: Dp = u * 0.16f, listening: Boolean = true) {
    val blink by rememberInfiniteTransition(label = "blink").animateFloat(0f, 1f, infiniteRepeatable(tween(3400, easing = LinearEasing)), label = "b")
    val glance by rememberInfiniteTransition(label = "glance").animateFloat(-1f, 1f, infiniteRepeatable(tween(1100, easing = LinearEasing), RepeatMode.Reverse), label = "g")
    val bob by rememberInfiniteTransition(label = "bob").animateFloat(0f, 1f, infiniteRepeatable(tween(1600, easing = LinearEasing), RepeatMode.Reverse), label = "o")
    Canvas(Modifier.size(size)) {
        val w = this.size.width; val h = this.size.height
        val stroke = w * 0.06f
        val dy = (bob - 0.5f) * h * 0.04f
        // antenna
        drawLine(Ink, Offset(w * 0.5f, h * 0.22f + dy), Offset(w * 0.5f, h * 0.08f + dy), stroke, StrokeCap.Round)
        if (listening) drawCircle(Ink, radius = w * 0.06f, center = Offset(w * 0.5f, h * 0.07f + dy))
        else drawCircle(Ink, radius = w * 0.06f, center = Offset(w * 0.5f, h * 0.07f + dy), style = Stroke(stroke * 0.6f))
        // head
        drawRoundRect(Ink, topLeft = Offset(w * 0.14f, h * 0.22f + dy), size = Size(w * 0.72f, h * 0.62f), cornerRadius = CornerRadius(w * 0.2f), style = Stroke(stroke))
        // ears
        drawRoundRect(Ink, topLeft = Offset(w * 0.02f, h * 0.44f + dy), size = Size(w * 0.1f, h * 0.2f), cornerRadius = CornerRadius(w * 0.04f))
        drawRoundRect(Ink, topLeft = Offset(w * 0.88f, h * 0.44f + dy), size = Size(w * 0.1f, h * 0.2f), cornerRadius = CornerRadius(w * 0.04f))
        // eyes: blink briefly once per cycle; glance sideways while thinking
        val closed = blink > 0.93f
        val ex = if (thinking) glance * w * 0.04f else 0f
        val eyeY = h * 0.48f + dy
        for (cx in listOf(w * 0.36f, w * 0.64f)) {
            if (closed) drawLine(Ink, Offset(cx - w * 0.07f + ex, eyeY), Offset(cx + w * 0.07f + ex, eyeY), stroke, StrokeCap.Round)
            else drawCircle(Ink, radius = w * 0.075f, center = Offset(cx + ex, eyeY))
        }
        // smile
        drawArc(Ink, startAngle = 20f, sweepAngle = 140f, useCenter = false, topLeft = Offset(w * 0.36f, h * 0.5f + dy), size = Size(w * 0.28f, h * 0.22f), style = Stroke(stroke, cap = StrokeCap.Round))
    }
}

@Composable
private fun Bubble(text: String, u: Dp) {
    Text(
        text = text,
        color = Ink,
        maxLines = 5,
        style = TextStyle(fontSize = sp(u * 0.042f), lineHeight = sp(u * 0.052f), textAlign = TextAlign.Center),
        modifier = Modifier
            .padding(horizontal = u * 0.06f)
            .border(1.dp, Dim, RoundedCornerShape(u * 0.025f))
            .padding(horizontal = u * 0.035f, vertical = u * 0.018f),
    )
}

/** Three dots that shimmer in sequence while the assistant is working. */
@Composable
private fun ThinkingBubble(u: Dp) {
    val phase by rememberInfiniteTransition(label = "dots").animateFloat(0f, 3f, infiniteRepeatable(tween(900, easing = LinearEasing)), label = "p")
    Row(
        Modifier.border(1.dp, Dim, RoundedCornerShape(u * 0.025f)).padding(horizontal = u * 0.045f, vertical = u * 0.03f),
        horizontalArrangement = Arrangement.spacedBy(u * 0.022f),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        for (i in 0 until 3) {
            val d = kotlin.math.abs(((phase - i + 3f) % 3f) - 1.5f)   // 0 = lit, 1.5 = dim
            val a = (1f - d / 1.5f).coerceIn(0.15f, 1f)
            Canvas(Modifier.size(u * 0.022f)) { drawCircle(Ink.copy(alpha = a)) }
        }
    }
}

@Composable
private fun Reticle(u: Dp) {
    val breathe by rememberInfiniteTransition(label = "reticle").animateFloat(0.3f, 1f, infiniteRepeatable(tween(1200), RepeatMode.Reverse), label = "a")
    Canvas(Modifier.fillMaxSize().padding(u * 0.07f).graphicsLayer { alpha = breathe }) {
        val len = size.minDimension * 0.1f
        val w = size.minDimension * 0.007f
        fun corner(x: Float, y: Float, dx: Float, dy: Float) {
            drawLine(Dim, Offset(x, y), Offset(x + dx * len, y), w, StrokeCap.Round)
            drawLine(Dim, Offset(x, y), Offset(x, y + dy * len), w, StrokeCap.Round)
        }
        corner(0f, 0f, 1f, 1f); corner(size.width, 0f, -1f, 1f)
        corner(0f, size.height, 1f, -1f); corner(size.width, size.height, -1f, -1f)
    }
}

@Composable
private fun AlarmFrame(u: Dp) {
    val pulse by rememberInfiniteTransition(label = "frame").animateFloat(1f, 0.2f, infiniteRepeatable(tween(450, easing = LinearEasing), RepeatMode.Reverse), label = "a")
    Canvas(Modifier.fillMaxSize().padding(u * 0.03f).graphicsLayer { alpha = pulse }) {
        drawRoundRect(Ink, style = Stroke(size.minDimension * 0.012f), cornerRadius = CornerRadius(size.minDimension * 0.05f))
    }
}

/** Small ring with the remaining seconds, in the top-right corner. */
@Composable
private fun CountdownDial(state: HudState, now: Long, u: Dp) {
    val remaining = (state.countdownEndsAt - now).coerceIn(0L, state.countdownDurationMs)
    val frac = remaining.toFloat() / state.countdownDurationMs.toFloat()
    val seconds = ((remaining + 999) / 1000).toInt()
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) {
            val stroke = size.minDimension * 0.075f
            val inset = stroke / 2
            val arcSize = Size(size.width - stroke, size.height - stroke)
            drawArc(Faint, 0f, 360f, false, Offset(inset, inset), arcSize, style = Stroke(stroke))
            drawArc(Ink, -90f, 360f * frac, false, Offset(inset, inset), arcSize, style = Stroke(stroke, cap = StrokeCap.Round))
        }
        Text(
            text = seconds.toString(),
            color = Ink,
            style = TextStyle(fontSize = sp(u * 0.11f), fontWeight = FontWeight.Light, letterSpacing = (-0.02).em),
        )
    }
}

@Composable
private fun CheckMark(state: HudState, u: Dp) {
    val progress = remember { Animatable(0f) }
    LaunchedEffect(state.run) { progress.snapTo(0f); progress.animateTo(1f, tween(650)) }
    Canvas(Modifier.fillMaxSize().padding(u * 0.03f)) {
        val path = Path().apply {
            moveTo(size.width * 0.16f, size.height * 0.54f)
            lineTo(size.width * 0.42f, size.height * 0.78f)
            lineTo(size.width * 0.86f, size.height * 0.26f)
        }
        val measure = PathMeasure().apply { setPath(path, false) }
        val partial = Path()
        measure.getSegment(0f, measure.length * progress.value, partial, true)
        drawPath(partial, Ink, style = Stroke(size.minDimension * 0.1f, cap = StrokeCap.Round, join = StrokeJoin.Round))
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
            state.phase == "IDLE" || state.lastLid.isBlank() -> ""
            !state.lastVisible -> "press not seen"
            else -> "press ${state.lastLid} · ${"%.1f".format(state.lastLatencyMs / 1000f)} s"
        }
        Text(left, color = Dim, style = TextStyle(fontSize = sp(u * 0.032f)))
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (!state.voice) {
                Text("silent", color = Faint, style = TextStyle(fontSize = sp(u * 0.032f)))
                Spacer(Modifier.width(u * 0.02f))
            }
            Text(if (state.listening) "mic" else "mic off", color = if (state.listening) Dim else Faint, style = TextStyle(fontSize = sp(u * 0.032f)))
            Spacer(Modifier.width(u * 0.02f))
            Canvas(Modifier.size(u * 0.02f)) { drawCircle(if (state.connected) Ink else Faint) }
            Spacer(Modifier.width(u * 0.015f))
            Text(if (state.connected) "${"%.0f".format(fps)} fps" else "offline", color = Dim, style = TextStyle(fontSize = sp(u * 0.032f)))
        }
    }
}
