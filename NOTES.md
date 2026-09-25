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
* Cost of the accuracy: verdicts take ~1.1 s instead of ~0.45 s, so a close is confirmed about
  1.5–2 s after the lid goes down (the countdown is backdated, so the 10 s is still exact) and the
  completion shows ~1.5 s after the lid opens. If speed matters more than certainty, switch the console
  to "raced" with gpt-realtime-mini and remove all but two reference photos.

## Timing observed on the replay (assets/press_demo_640.mp4)
* press seen → "Please close" in ~1.0 s after the first frame
* lid closed → COUNTDOWN 0.9 s later, countdown backdated by that 0.9 s (ring starts at ~9.1)
* countdown → alert exactly 10 s after the closing frame
* lid opened → COMPLETE ~0.8 s later
