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

Default: race `gpt-4.1-mini` + `gpt-5.4-mini` (≈750 ms median end to end in the replay test,
3.3 decisions/s with 3 in flight, 0 errors over 112 calls). Gemini stays selectable in the console
for keys with a paid quota.

## Timing observed on the replay (assets/press_demo_640.mp4)
* press seen → "Please close" in ~1.0 s after the first frame
* lid closed → COUNTDOWN 0.9 s later, countdown backdated by that 0.9 s (ring starts at ~9.1)
* countdown → alert exactly 10 s after the closing frame
* lid opened → COMPLETE ~0.8 s later
