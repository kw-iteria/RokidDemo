# Iteria Agent — Rokid glasses assistant and plate-press guide

Look at the press through Rokid RV101 glasses. The glasses stream what you see to a small
server on your Mac, a vision model reads the state of the press, and both the glasses HUD and a
desktop console walk you through the motion:

0. **Standby** — say (or type) "start plate press workflow" to the assistant. Nothing is detected until then.
1. **Looking for the plate press** — the camera finds the silver glass box.
2. **Please close the plate press** — once the lid is seen closed (after having been seen open), a 10 s
   countdown ring runs in the top-right corner, backdated to the frame where the lid closed.
3. **Open the plate press** — after 10 s, a pulsing frame and beeps until the lid is seen open.
4. **Plate press motion completed** — check mark, done. It returns to standby after 12 s.

**Talking to the assistant.** The console has a chat panel with a microphone button; on the glasses
(the app is called **Iteria**) the microphone is always on: just speak, like a regular chat. A
shimmering bubble appears the moment your words are captured, the reply streams in, and it is
spoken by a natural neural voice (OpenAI text-to-speech, streamed sentence by sentence from the
server to the glasses and the console, so speech starts about a second after you finish talking).
Pick the voice and speed in the console. Tap the temple button to mute or unmute the microphone.
It is a general chatbot that also runs the workflow: start/stop it, change the press time, pick
models, save the current view as a reference photo, or just ask anything. Double-tap the temple
button to start or restart without talking. "Start / stop the workflow" in any wording (even
"play press") is handled deterministically, without waiting for a model.

Two chat models, chosen per message: plain conversation and commands go to a fast text model
(default `groq/qwen/qwen3.8-27b`, ~0.2–0.5 s per reply including tool calls); questions about
what the camera sees go to a vision model (default `gpt-4.1-mini`, ~0.8–1 s) with the live frame
and reference photos attached. Replies stream token by token to the console. Both are selectable
in the console; `tools/bench_chat.ts` measures every vendor.

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

How open/closed is decided, frame by frame:

1. The glasses send a 480 px JPEG about six times a second, each tagged with a motion score
   (how much the picture changed since the previous frame).
2. Up to four frames are in flight at once. Each goes to the primary vision model
   (`gpt-5.4-mini`, fallback `gpt-4.1-mini`) with a strict description of the press, eight reference
   photos of this exact box (open, closed, and "not closed yet" with the lid mid-way), and a JSON
   schema. The answer is `press_visible`, `lid` (open / closed / partial / unknown),
   `hand_on_press`, `confidence`. "Closed" is defined as lid flat, no gap, no tilt, nothing touching it;
   anything else is "partial".
3. The state machine only counts strictly consecutive identical verdicts on still frames
   (motion below a threshold). A close needs, in this order: the box seen open earlier in the run,
   `confirmations` closed verdicts in a row, the hand off the press for those verdicts, and the lid
   at rest for `settle_ms` (700 ms). The countdown is then backdated to the first hand-free closed
   frame, so the 10 s still runs from the real closing moment.
4. Opening needs `confirmations` open verdicts in a row; partial/moving frames never count.

Capture new reference photos of the real press from the console ("Capture open/closed from live view")
or by telling the assistant "use this as the closed reference". Verdicts for every frame are visible
in the console badge (lid, hand, moving, confidence, latency).

## Local classifier (fast path)

`server/model/press_head.json` is a small softmax head on CLIP ViT-B/32 image embeddings
(transformers.js, runs on the Mac's CPU, ~50 ms per frame; the CLIP weights download once on first
start). In the default "local" engine every frame is classified locally and drives the state machine;
the cloud model looks at ~2 frames per second as a verifier: it tracks the press location for the
zoom, its verdicts also count in the vote, and a fresh contradicting cloud verdict vetoes local ones.
Result on the clips: the countdown starts 0.1–0.3 s after the lid is down.

Retrain after collecting new clips (frames + cloud bounding boxes → crops → embeddings → head):

```bash
node tools/bench.ts --frames all --refs --negatives bench-results/negatives \
  --extra open=bench-results/frames_open,closed=bench-results/frames_closed,open=bench-results/frames_open2,closed=bench-results/frames_closed2 \
  --models gpt-5.4-mini --dump bench-results/bboxes_gpt54.json
npm run train:local        # prints leave-one-clip-out accuracy, writes server/model/press_head.json
```

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
  `moondream` uses Moondream's own query API (`MOONDREAM_API_KEY`). Measured results for all of
  them are in `NOTES.md`; the default stays `gpt-5.4-mini` because it was the only one that read
  every unambiguous frame correctly.
* Transitions need `confirmations` agreeing verdicts (default 2), or one verdict at ≥0.9 confidence.
* The countdown deadline is `first closed frame + 10 s`; the glasses animate it locally from a
  server-clock offset, so the ring is smooth and nothing waits on the network.

## Benchmark

`npm run bench -- --frames all` (also `--refs` for few-shot reference images, `--width 320`), and
`node tools/bench_live.ts --frames all --concurrency 3` for the persistent-session APIs.
Results land in `bench-results/` and show up as badges in the console's model picker.
Findings from this machine are in the last section of `NOTES.md`.
