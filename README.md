# PlatePress — a Rokid glasses guide for the plate-press motion

Look at the press through Rokid RV101 glasses. The glasses stream what you see to a small
server on your Mac, a vision model reads the state of the press, and both the glasses HUD and a
desktop console walk you through the motion:

1. **Looking for the plate press** — the camera finds the press.
2. **Please close the plate press** — the moment the lid is seen closed, a 10 s countdown ring starts
   (backdated to the frame where the lid closed, so model latency does not eat into the 10 s).
3. **Open the plate press** — after 10 s, a pulsing alert and beeps until the lid is seen open.
4. **Plate press motion completed** — check mark, done. Tap the temple button to run again.

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
| `server/src/vision.ts` | one-frame structured classification over raw REST (Gemini `generateContent`, OpenAI Responses) |
| `server/web/` | desktop console (vanilla HTML/CSS/JS) with a live mirror of the glasses HUD |
| `glasses/` | Android app for the Rokid glasses (CameraX → JPEG → WebSocket; Compose HUD; beeps + TTS; temple gestures) |
| `tools/bench.ts` | latency + accuracy benchmark of candidate models on frames of the demo clip |

## Latency design

* Frames leave the glasses at ~6 fps, 480 px long edge, JPEG q60 (~25 KB). LAN transit is a few ms.
* The server keeps up to 3 model requests in flight, spaced ≥250 ms, always on the newest frame,
  and drops verdicts that arrive out of order. Effective decision rate ≈ 3–4 per second.
* Optional **race**: each frame goes to two models; the first valid verdict wins, the other is aborted.
  The default pair (`gpt-4.1-mini` + `gpt-5.4-mini`) measured ~750 ms median in this network.
* Transitions need `confirmations` agreeing verdicts (default 2), or one verdict at ≥0.9 confidence.
* The countdown deadline is `first closed frame + 10 s`; the glasses animate it locally from a
  server-clock offset, so the ring is smooth and nothing waits on the network.

## Benchmark

`npm run bench -- --frames all` (also `--refs` for few-shot reference images, `--width 320`).
Results land in `bench-results/` and show up as badges in the console's model picker.
Findings from this machine are in the last section of `NOTES.md`.
