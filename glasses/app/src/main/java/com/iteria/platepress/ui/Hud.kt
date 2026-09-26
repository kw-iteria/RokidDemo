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
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipRect
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
import kotlin.math.exp
import kotlin.math.min
import kotlin.math.sin

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
    // The per-frame clock lives inside CountdownDial, so only the dial redraws at display rate.

    BoxWithConstraints(Modifier.fillMaxSize()) {
        val u = min(maxWidth.value, maxHeight.value).dp
        when (state.phase) {
            "SEARCHING" -> Reticle(u)
            "AWAIT_OPEN" -> AlarmFrame(u)
        }
        Box(Modifier.align(Alignment.TopEnd).padding(top = u * 0.045f, end = u * 0.045f).size(u * 0.27f)) {
            when (state.phase) {
                "COUNTDOWN" -> CountdownDial(state, serverNow, u)
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
    val chatFresh = state.chatText.isNotBlank() && System.currentTimeMillis() - state.chatAt < 12_000
    val heardFresh = state.heardText.isNotBlank() && System.currentTimeMillis() - state.heardAt < 6_000
    Column(modifier.fillMaxWidth().padding(bottom = u * 0.11f), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Bottom) {
        if (heardFresh && (state.thinking || state.chatStreaming.isNotEmpty())) {
            Line("\u201c${state.heardText}\u201d", u, 0.036f, color = Dim, weight = FontWeight.Normal)
            Spacer(Modifier.height(u * 0.012f))
        }
        when {
            state.speaking -> ListeningRobot(u)
            state.chatStreaming.isNotEmpty() -> Row(verticalAlignment = Alignment.Bottom) { Robot(u, size = u * 0.1f); Spacer(Modifier.width(u * 0.02f)); Bubble(state.chatStreaming, u) }
            state.thinking -> Row(verticalAlignment = Alignment.CenterVertically) { Robot(u, thinking = true, size = u * 0.1f); Spacer(Modifier.width(u * 0.02f)); ThinkingBubble(u) }
            chatFresh -> Row(verticalAlignment = Alignment.Bottom) { Robot(u, size = u * 0.1f); Spacer(Modifier.width(u * 0.02f)); Bubble(state.chatText, u) }
        }
        Spacer(Modifier.height(u * 0.02f))
        when (state.phase) {
            "CONNECTING" -> when {
                state.connected -> Line("Connected", u, 0.045f, color = Dim, weight = FontWeight.Normal)
                state.pairing.isNotBlank() -> BreathingLine(state.pairing, u, 0.045f, floor = 0.5f)
                else -> {
                    BreathingLine("Look at the code on the Iteria screen", u, 0.045f, floor = 0.4f)
                    Line("a hand's span away, or click it to make it bigger", u, 0.032f, color = Faint, weight = FontWeight.Normal)
                }
            }
            "IDLE" -> {
                val busy = state.speaking || state.thinking || state.chatStreaming.isNotEmpty() || chatFresh
                if (!busy) Robot(u, listening = state.listening)
                if (!state.cameraLive) Line("waiting for camera", u, 0.032f, color = Faint, weight = FontWeight.Normal)
            }
            "COUNTDOWN" -> Line(state.sub, u, 0.042f, color = Dim, weight = FontWeight.Normal)
            "AWAIT_OPEN" -> {
                PulsingLine(state.message, u, 0.062f)
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

/*
 * The animated lines own their animation, so it only runs while that line is on screen and its value
 * is read when drawing (a layer alpha), not in composition. Before, the alarm pulse and the pairing
 * breathe ran in Subtitle for every phase and re-laid the text out on every display frame; the HUD
 * spent ~29 ms per frame (31% janky, gfxinfo) on a device already at 94 °C.
 */
@Composable
private fun PulsingLine(text: String, u: Dp, scale: Float) {
    val pulse by rememberInfiniteTransition(label = "alarm").animateFloat(1f, 0.25f, infiniteRepeatable(tween(450, easing = LinearEasing), RepeatMode.Reverse), label = "a")
    Line(text, u, scale, weight = FontWeight.SemiBold, modifier = Modifier.graphicsLayer { alpha = 0.55f + 0.45f * pulse })
}

@Composable
private fun BreathingLine(text: String, u: Dp, scale: Float, floor: Float) {
    val breathe by rememberInfiniteTransition(label = "breathe").animateFloat(0.35f, 1f, infiniteRepeatable(tween(1400), RepeatMode.Reverse), label = "b")
    Line(text, u, scale, color = Ink, weight = FontWeight.Normal, modifier = Modifier.graphicsLayer { alpha = floor + 0.5f * breathe })
}

/**
 * The robot mascot: a helmet-shaped head with a face plate, two oval eyes, ear tabs and an antenna.
 * Eyes blink now and then and glance sideways while thinking; the antenna ball is filled while the
 * microphone is on. The face plate is drawn black, which is see-through on the waveguide.
 */
@Composable
private fun Robot(u: Dp, thinking: Boolean = false, size: Dp = u * 0.18f, listening: Boolean = true) {
    val blink by rememberInfiniteTransition(label = "blink").animateFloat(0f, 1f, infiniteRepeatable(tween(3600, easing = LinearEasing)), label = "b")
    val glance by rememberInfiniteTransition(label = "glance").animateFloat(-1f, 1f, infiniteRepeatable(tween(1100, easing = LinearEasing), RepeatMode.Reverse), label = "g")
    val bob by rememberInfiniteTransition(label = "bob").animateFloat(0f, 1f, infiniteRepeatable(tween(1700, easing = LinearEasing), RepeatMode.Reverse), label = "o")
    Canvas(Modifier.size(size)) {
        val w = this.size.width; val h = this.size.height
        val dy = (bob - 0.5f) * h * 0.035f
        val plate = Color.Black
        // antenna
        drawLine(Ink, Offset(w * 0.5f, h * 0.2f + dy), Offset(w * 0.5f, h * 0.09f + dy), w * 0.045f, StrokeCap.Round)
        if (listening) drawCircle(Ink, radius = w * 0.06f, center = Offset(w * 0.5f, h * 0.075f + dy))
        else drawCircle(Ink, radius = w * 0.06f, center = Offset(w * 0.5f, h * 0.075f + dy), style = Stroke(w * 0.025f))
        // cap and helmet
        drawRoundRect(Ink, topLeft = Offset(w * 0.37f, h * 0.17f + dy), size = Size(w * 0.26f, h * 0.1f), cornerRadius = CornerRadius(w * 0.035f))
        drawRoundRect(Ink, topLeft = Offset(w * 0.1f, h * 0.23f + dy), size = Size(w * 0.8f, h * 0.66f), cornerRadius = CornerRadius(w * 0.3f, h * 0.3f))
        // ear tabs
        drawRoundRect(Ink, topLeft = Offset(w * 0.0f, h * 0.45f + dy), size = Size(w * 0.11f, h * 0.24f), cornerRadius = CornerRadius(w * 0.035f))
        drawRoundRect(Ink, topLeft = Offset(w * 0.89f, h * 0.45f + dy), size = Size(w * 0.11f, h * 0.24f), cornerRadius = CornerRadius(w * 0.035f))
        // face plate (see-through on the glasses)
        drawRoundRect(plate, topLeft = Offset(w * 0.19f, h * 0.33f + dy), size = Size(w * 0.62f, h * 0.45f), cornerRadius = CornerRadius(w * 0.24f, h * 0.26f))
        // eyes: vertical ovals; a quick blink once per cycle; glance sideways while thinking
        val closed = blink > 0.94f
        val ex = if (thinking) glance * w * 0.035f else 0f
        val eyeW = w * 0.09f
        val eyeH = if (closed) h * 0.025f else h * 0.16f
        for (cx in listOf(w * 0.4f, w * 0.6f)) {
            drawOval(Ink, topLeft = Offset(cx - eyeW / 2 + ex, h * 0.555f - eyeH / 2 + dy), size = Size(eyeW, eyeH))
        }
    }
}

/**
 * Shown while the wearer is talking: a sound-wave packet sweeps left to right through the robot.
 * The wave is drawn behind the helmet and again inside the see-through face plate, so it reads as
 * passing *through* the robot's face.
 */
@Composable
private fun ListeningRobot(u: Dp) {
    val t by rememberInfiniteTransition(label = "wave").animateFloat(0f, 1f, infiniteRepeatable(tween(1300, easing = LinearEasing)), label = "w")
    val robot = u * 0.16f
    Box(Modifier.width(robot * 3.4f).height(robot), contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) { soundWave(t, alpha = 0.55f) }
        Robot(u, size = robot)
        Canvas(Modifier.fillMaxSize()) {
            // the robot's face plate, in this wider canvas (see Robot: x 0.19..0.81, y 0.33..0.78 of its size)
            val side = size.height
            val left = (size.width - side) / 2f
            clipRect(left + side * 0.21f, side * 0.35f, left + side * 0.79f, side * 0.76f) { soundWave(t, alpha = 1f) }
        }
    }
}

/** A travelling wave packet across the canvas, centred on the robot's eye line; it fades out away
 *  from the packet so only the moving wave is visible (no resting line through the face). */
private fun DrawScope.soundWave(t: Float, alpha: Float) {
    val w = size.width
    val h = size.height
    val cy = h * 0.555f
    val centre = -0.25f * w + t * 1.5f * w      // packet position sweeps from off-left to off-right
    val sigma = w * 0.16f
    val k = (2f * Math.PI / (h * 0.42f)).toFloat()
    val stroke = h * 0.035f
    val steps = 120
    var px = 0f
    var py = cy
    for (i in 0..steps) {
        val x = w * i / steps
        val env = exp(-((x - centre) / sigma).let { it * it })
        val y = cy + env * h * 0.2f * sin(k * x - t * 18f)
        if (i > 0 && env > 0.02f) drawLine(Ink.copy(alpha = alpha * minOf(1f, env * 1.6f)), Offset(px, py), Offset(x, y), stroke, StrokeCap.Round)
        px = x; py = y
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
            Canvas(Modifier.size(u * 0.022f)) {
                val d = kotlin.math.abs(((phase - i + 3f) % 3f) - 1.5f)   // 0 = lit, 1.5 = dim (read while drawing: no recomposition per frame)
                drawCircle(Ink.copy(alpha = (1f - d / 1.5f).coerceIn(0.15f, 1f)))
            }
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
private fun CountdownDial(state: HudState, serverNow: () -> Long, u: Dp) {
    var now by remember { mutableLongStateOf(serverNow()) }
    LaunchedEffect(Unit) { while (true) withFrameMillis { now = serverNow() } }
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
