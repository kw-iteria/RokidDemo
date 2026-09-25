# PlatePress — a Rokid glasses guide for the plate-press motion

Look at the press through Rokid RV101 glasses. The glasses stream what you see to a small
server on your Mac, a vision model reads the state of the press, and both the glasses HUD and a
desktop console walk you through the motion:

0. **Standby** — say (or type) "start plate press workflow" to the assistant. Nothing is detected until then.
1. **Looking for the plate press** — the camera finds the silver glass box.
2. **Please close the plate press** — once the lid is seen closed (after having been seen open), a 10 s
   countdown ring runs in the top-right corner, backdated to the frame where the lid closed.
3. **Open the plate press** — after 10 s, a pulsing frame and beeps until the lid is seen open.
4. **Plate press motion completed** — check mark, done. It returns to standby after 12 s.

**Talking to the assistant.** The console has a chat panel with a microphone button; on the glasses,
tap the temple button, speak, and the reply is shown and read aloud. The assistant sees the live
frame and the workflow state, and can start/stop the workflow, change the press time, pick models,
or save the current view as a reference photo. Double-tap the temple button to start or restart
without talking.

```
Rokid glasses (Kotlin/Compose)  ──JPEG frames over WebSocket──▶  server (Node, no build step)  ──▶  Gemini / OpenAI vision
        ▲  HUD state (JSON)                                          │
        └────────────────────────────────────────────────────────────┤
                                                       desktop console (browser) ◀──┘  live view · verdicts · latency · controls
```

## Run it

```bash
# 1. keys in .env (GEMINI_API_KEY / OPENAI_API_KEY), then
npm install
npm start                      # http://localhost:8787  — the console; glasses discover this Mac by UDP beacon

# 2. glasses (same WiFi as the Mac; adb over USB or WiFi)
tools/install_glasses.sh       # builds the APK, installs, grants camera, launches
```

No glasses at hand? In the console press **Replay demo clip** (the phone video in `assets/`) or
**Use this computer's camera** — both act exactly like the glasses.

## Layout

| Path | What |
|---|---|
| `server/src/main.ts` | HTTP + WebSocket hub, source arbitration (glasses / webcam / replay), UDP beacon |
| `server/src/session.ts` | the workflow state machine (SEARCHING → AWAIT_CLOSE → COUNTDOWN → AWAIT_OPEN → COMPLETE) |
| `server/src/detector.ts` | frame scheduler: several requests in flight, optional model race, stale-verdict dropping |
| `server/src/vision.ts` | one-frame structured classification (Gemini `generateContent`, OpenAI Responses, OpenAI Realtime, OpenAI-compatible vendors) |
| `server/src/agent.ts` | the chat assistant: sees the frame + state, calls workflow tools; speech-to-text for push-to-talk |
| `server/refs/` | reference photos of the press, open and closed; every model request carries them |
| `server/web/` | desktop console (vanilla HTML/CSS/JS) with a live mirror of the glasses HUD |
| `glasses/` | Android app for the Rokid glasses (CameraX → JPEG → WebSocket; Compose HUD; beeps + TTS; temple gestures) |
| `tools/bench.ts` | latency + accuracy benchmark of candidate models on frames of the demo clip |

## Detection

The vision model is told that the press is one specific object and is shown reference photos of it
(open and closed, from the phone clip and from the glasses clips) with every frame, so hands, laptops,
papers and other boxes are not mistaken for it. State changes need two strictly consecutive agreeing
verdicts, a close is only accepted after the box was seen open in that run (or after a long unbroken
closed streak if it was closed from the start), and the workflow only runs after you start it.
Capture new reference photos of the real press from the console ("Capture open/closed from live view")
or by telling the assistant "use this as the closed reference".

## Latency design

* Frames leave the glasses at ~6 fps, 480 px long edge, JPEG q60 (~25 KB). LAN transit is a few ms.
* The server keeps up to 3 model requests in flight, spaced ≥250 ms, always on the newest frame,
  and drops verdicts that arrive out of order. Effective decision rate ≈ 3–4 per second.
* **Persistent session**: `gpt-realtime-mini` runs over one long-lived OpenAI Realtime WebSocket
  (`server/src/realtime.ts`); every frame is an out-of-band response, so there is no per-request
  TLS/HTTP overhead. ~400 ms median per verdict here, versus ~750–900 ms for the request path.
* Optional **race**: each frame goes to two models; the first valid verdict wins, the other is
  cancelled. Default pair: `gpt-realtime-mini` + `gpt-4.1-mini` (the HTTP model only covers the tail).
* Other vendors with OpenAI-compatible endpoints work by prefixing the model name
  (`groq/…`, `fireworks/…`, `together/…`, `xai/…`, `cerebras/…`, `openrouter/…`, `ollama/…`) and
  putting the matching `*_API_KEY` in `.env` — see `COMPAT_ENDPOINTS` in `server/src/vision.ts`.
* Transitions need `confirmations` agreeing verdicts (default 2), or one verdict at ≥0.9 confidence.
* The countdown deadline is `first closed frame + 10 s`; the glasses animate it locally from a
  server-clock offset, so the ring is smooth and nothing waits on the network.

## Benchmark

`npm run bench -- --frames all` (also `--refs` for few-shot reference images, `--width 320`), and
`node tools/bench_live.ts --frames all --concurrency 3` for the persistent-session APIs.
Results land in `bench-results/` and show up as badges in the console's model picker.
Findings from this machine are in the last section of `NOTES.md`.
