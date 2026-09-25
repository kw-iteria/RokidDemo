# Working notes

## Device facts (Rokid RV101 / "Rokid Glasses")
* Android 12 (API 32), YodaOS-Sprite, low-RAM mode. Camera via CameraX/Camera2; sensor is mounted
  rotated (LabOS notes: 270°), so upright frames come out portrait — the pipeline is aspect-agnostic.
* Display: monochrome **green** micro-LED waveguide, ~480×398 per eye, 23° FOV. Unlit pixels are
  see-through, so the app window is transparent and the HUD is drawn in white; hierarchy is size,
  weight and brightness only, and alerts use motion + sound, never color.
* Temple button broadcasts: `com.android.action.ACTION_SPRITE_BUTTON_CLICK` (tap),
  `_DOUBLE_CLICK`, `_LONG_PRESS`. Fallback key events: ENTER / DPAD_CENTER.

## Model benchmark (1-fps frames of the demo clip, 480 px, structured JSON, no thinking)
Measured from this Mac on 2026-09-24. `strict` = accuracy on unambiguous open/closed frames.

| model | p50 | p90 | strict | notes |
|---|---|---|---|---|
| gemini-3.5-flash-lite | 852 ms | 1.24 s | 100% | fastest Gemini, but the key's quota returns **HTTP 429** after ~17 rapid calls |
| gpt-4.1-nano | 773 ms | 1.37 s | 85% | fast, weaker on the flat closed box |
| gpt-4o-mini | 825 ms | 1.45 s | 85% | best on "partial" frames |
| gpt-5.4-mini | 886 ms | 0.98 s | 100% | tight tail; one 30 s hang seen in a run |
| gpt-4.1-mini | 977 ms | 1.32 s | 100% | zero errors in every run; 96% exact with reference images |
| gpt-5-nano | 987 ms | 1.30 s | 80% | |
| gpt-5.5 | 1.29 s | 1.71 s | 100% | slower, no gain |
| gemini-3.1-flash-lite | 2.0 s | 2.7 s | 100% | slower than 3.5-lite here |
| gemini-3.5-flash / 3.8-flash / 3-flash-preview | 1.3–5.7 s | — | — | 429 rate limits and timeouts at this cadence |
| gemini-robotics-er-2-preview | 2.0 s | 2.4 s | 100% | ignores the JSON response schema sometimes |

Network floor from this Mac: a trivial Gemini call ≈ 0.9–1.2 s, a trivial OpenAI call ≈ 1.2–1.9 s
(TLS ≈ 0.19 s, API TTFB ≈ 0.35–0.7 s), so per-call latency is dominated by the API, not the image.

## Persistent sessions (one WebSocket, per-frame questions)

| model | p50 sequential | p50 with 3 in flight | strict | notes |
|---|---|---|---|---|
| gpt-realtime-mini (OpenAI Realtime) | **388 ms** | 424–515 ms, 5.5–6.8 verdicts/s | 90–95% | out-of-band responses (`conversation: 'none'`) correlated by `metadata`; misreads are "partial" near transitions, which the state machine treats as neutral |
| gpt-realtime-2.1-mini | ~600 ms | — | — | returns empty text with text-only output; not usable as is |
| gemini-*-live / native-audio | — | — | — | reject `responseModalities: TEXT` (audio-first models) |
| gemini-robotics-er-2-streaming-preview | 1.8 s | — | — | too slow |

**Default now:** race `gpt-realtime-mini` + `gpt-4.1-mini`, 4 in flight, ≥150 ms apart. On the
simulated-glasses run: ~500 ms median verdict, 4.4–4.6 verdicts/s, realtime wins 96% of races,
close detected 434–564 ms after the closing frame (and backdated), 0 errors.

## Other ways to cut latency further (not tried here; no keys)
* **Groq** (`groq/meta-llama/llama-4-scout-17b-16e-instruct`, Llama 4 vision on LPUs) and
  **Cerebras** — typically 200–400 ms for a short vision answer; supported via the `vendor/` prefix.
* **Fireworks / Together** (Qwen2.5-VL, Llama 4) — ~400–700 ms, same prefix mechanism.
* **xAI** `grok-4-fast` vision via `xai/…`.
* **Moondream** (tiny VLM): its cloud API answers yes/no "is the lid closed?" questions in
  ~200 ms, and the 2B model runs locally on Apple Silicon in ~150–300 ms — zero network.
* **Local, purpose-built**: a few hundred labelled frames from the real press would train a
  MobileNet/CLIP-probe classifier that answers in <10 ms on the Mac; keep the VLM as a fallback
  or a periodic sanity check. This is the only path to a true "instant" close detection.
* **Anthropic Claude Haiku 4.5** (vision) if a key is available — comparable to gpt-4.1-mini class latency.
* On the glasses side, frame rate/size are already small; the remaining fixed costs are the
  model's time-to-first-token and the round trip to the provider's region.

## Detection hardening (2026-09-24, evening)
* Problem reports from the real glasses: unrelated objects detected as the press; countdown starting
  without a close. Causes: a loose prompt ("white box with a lid"), a single high-confidence verdict
  was enough (gpt-realtime-mini reports 0.9 on nearly everything), and partial/unknown verdicts did
  not break a streak.
* Fixes: strict prompt naming the silver glass box and listing what is NOT the press; six reference
  photos (3 open / 3 closed, phone + glasses perspectives) in every request; strictly consecutive
  confirmations; no single-verdict shortcut; a close needs the box to have been seen open first;
  standby until the workflow is started.
* Benchmark with six reference photos on 68 labelled frames from all three clips (corrected
  orientation) plus 8 negatives (`bench-results/ext_refs6_run2.log`):

  | model | p50 | strict | exact | false positives | notes |
  |---|---|---|---|---|---|
  | gpt-5.4-mini | 1.1 s | **100%** | 93% | 0/4 on unrelated images (the one "hit" is a crop that still shows part of the lid) | new default primary |
  | gpt-4.1-mini | 0.95 s | 87% | 85% | 1/4 | fallback when the primary fails |
  | gpt-realtime-mini | 0.77 s | 52% | 32% | — | collapses with several reference photos (prose answers, "open" on closed frames); no longer default |

  The new prompt WITHOUT reference photos collapses (4.1-mini says "not visible" on everything), so
  references are mandatory. Detection mode is now "primary + fallback" instead of a race: a race
  returns the fastest model's answer, which was the least accurate one.
* Other vendors tried on the same 76 frames (keys added by the user):

  | model | p50 | strict | notes |
  |---|---|---|---|
  | moondream (cloud `/query`, one-word question) | **0.18–0.26 s** | 83% | fastest by far, but no reference photos possible: calls several open glasses-angle frames "closed" and 4/8 unrelated images "closed"; hard rate limit (burst ~36 requests, then 429; 2.5 req/s is sustainable). Would likely be excellent after a Moondream fine-tune on the open/closed clips. Selectable as "moondream" in the console; the server paces it and falls back on 429. |
  | xai/grok-4.20-0309-non-reasoning | 0.68 s | 35% | reads the images but mostly answers "not visible" with the strict prompt |
  | xai/grok-4.7 | 5–16 s | — | reasoning model, far too slow |
  | groq/qwen/qwen3.8-27b | — | — | rejects multi-image input (0/76) |
  | cerebras/qwen-3.8-27b | — | — | returns empty content for image requests |

* Cost of the accuracy: verdicts take ~1.1 s instead of ~0.45 s, so a close is confirmed about
  1.5–2 s after the lid goes down (the countdown is backdated, so the 10 s is still exact) and the
  completion shows ~1.5 s after the lid opens. If speed matters more than certainty, switch the console
  to "raced" with gpt-realtime-mini and remove all but two reference photos.

## "Countdown before fully closed" fix (2026-09-24, late)
* Added two "not closed yet" reference photos (lid mid-way, hand on it), a `hand_on_press` field,
  and a stricter definition of closed; the state machine now also needs the hand off the press,
  the lid at rest for 700 ms, and still frames (motion score from the glasses / webcam / jpeg-js on
  the server for replays).
* Benchmark on 99 labelled frames from all five clips plus 8 negatives with the eight reference
  photos: gpt-5.4-mini 98% on unambiguous frames (the two misses were "partial", which never
  triggers anything), 0/4 false positives on unrelated images, p50 0.87 s; gpt-4.1-mini dropped to
  74% with this many references and stays only as the error fallback.
* On the demo clip the countdown now starts at the moment the hand leaves the closed lid
  (3 verdicts over ~0.8 s, backdated), not while the lid is still coming down.

## Chat latency (2026-09-25, `tools/bench_chat.ts`, median of 3, streaming)

| model | one-sentence fact (first token / total) | tool call "start workflow" | three tips |
|---|---|---|---|
| groq/qwen/qwen3.8-27b (**default text model**) | 76 / 130 ms | 136 ms, 3/3 correct | 185 ms |
| cerebras/gpt-oss-120b | 236 / 243 ms | 179 ms, 3/3 | 208 ms |
| groq/openai/gpt-oss-120b | 259 / 304 ms | 249 ms, 3/3 | 316 ms |
| groq/openai/gpt-oss-20b | 298 / 318 ms | 205 ms, 3/3 | 155 ms |
| cerebras/qwen-3.8-27b | 299 / 320 ms | 248 ms, 3/3 | 324 ms |
| gpt-4.1-mini (**default vision model**) | 320 / 485 ms | 512 ms, 3/3 | 658 ms |
| xai/grok-4.20 non-reasoning | 439 / 555 ms | 574 ms, 3/3 | 785 ms |
| gpt-4.1-nano | 423 / 622 ms | 526 ms | 604 ms |
| gemini-3.5-flash-lite | 541 / 628 ms | 571 ms | 1.3 s |
| gpt-5.4-mini / 5.4-nano / 4o-mini / 5-nano | 0.65–0.73 s | 0.46–0.66 s | 0.67–1.0 s |
| gemini-3.8-flash | — | — | quota 429 |

Routing: `needsVision()` (words like see / look / camera / frame / open or closed) sends the message
with the live frame plus one open and one closed reference photo to the vision model; everything
else goes to the text model, which also handles tool calls. If the text vendor fails, the vision
model answers. Replies are stripped of markdown because they are spoken on the glasses.

## Spoken replies (2026-09-25)
* Server-side `gpt-4o-mini-tts` (voice "coral", PCM 24 kHz) streamed per sentence while the reply is
  still being generated; the glasses play it through an AudioTrack and the console through Web Audio.
  Measured: first audio chunk ≈ 0.85 s after the question; a 3-sentence answer streams 14 s of audio
  with no gaps. The microphone on the glasses ignores audio while the speaker is busy (+350 ms).
* A new message cancels the current speech (`stop` envelope) and reply.
* Falls back to the device's own text-to-speech when the neural voice is switched off in the console.

## Timing observed on the replay (assets/press_demo_640.mp4)
* press seen → "Please close" in ~1.0 s after the first frame
* lid closed → COUNTDOWN 0.9 s later, countdown backdated by that 0.9 s (ring starts at ~9.1)
* countdown → alert exactly 10 s after the closing frame
* lid opened → COMPLETE ~0.8 s later
