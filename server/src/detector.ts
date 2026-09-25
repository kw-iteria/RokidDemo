// Frame scheduler: keeps up to N model requests in flight against the newest frame,
// optionally racing several models per frame and taking the first valid verdict.
import { classifyFrame, type ClassifyResult, type Verdict } from './vision.ts';
import type { Frame } from './frames.ts';
import { boxArea, cropAround, cropJpeg, uncrop, ZOOM_TRIGGER_AREA, type Crop } from './zoom.ts';

export interface DetectorConfig {
  models: string[];        // 1 model, or several: raced per frame, or primary + fallbacks (mode)
  mode?: 'race' | 'primary';
  maxInflight: number;     // concurrent frame evaluations
  minIntervalMs: number;   // minimum spacing between submissions
  prompt?: string;
  timeoutMs: number;
  refs?: { label: string; jpeg: Buffer }[];
}

export interface VerdictOut {
  verdict: Verdict;      // bbox in full-frame coordinates
  frame: Frame;
  latency_ms: number;
  model: string;
  losers?: string[];
  zoomed?: Crop;         // the crop the model actually looked at, if any
  box_area?: number;     // press size as a fraction of the full frame
  seen_area?: number;    // press size as a fraction of the image the model looked at (crop or full frame)
}

export interface DetectorStats {
  inflight: number;
  decisions_per_s: number;
  p50_ms: number;
  p90_ms: number;
  last_ms: number;
  errors: number;
  submitted: number;
  completed: number;
  per_model: Record<string, { wins: number; p50_ms: number; errors: number }>;
}

/** Minimum spacing between requests to rate-limited APIs (ms), and cool-down after a 429. */
const MODEL_PACE_MS: Record<string, number> = { moondream: 400 };
const COOL_DOWN_MS = 3000;

export class Detector {
  config: DetectorConfig;
  private lastStartByModel = new Map<string, number>();
  private coolDownUntil = new Map<string, number>();
  private latest: Frame | null = null;
  private lastSubmittedSeq = -1;
  private lastSubmittedRecvTs = -1;
  private lastSubmitAt = 0;
  private inflight = 0;
  private timer: NodeJS.Timeout | null = null;
  private latencies: number[] = [];
  private completions: number[] = [];
  private errors = 0;
  private submitted = 0;
  private completed = 0;
  private running = false;
  private perModel = new Map<string, { wins: number; lat: number[]; errors: number }>();
  /** Last known press location (full-frame, normalized) and when it was seen; drives the zoom crop. */
  private lastBox: { box: [number, number, number, number]; at: number } | null = null;
  private zoomMisses = 0;
  zoomEnabled = true;
  onVerdict: (v: VerdictOut) => void = () => {};
  onError: (model: string, error: string) => void = () => {};

  constructor(config: DetectorConfig) {
    this.config = config;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => this.pump(), 40);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  offer(frame: Frame): void {
    this.latest = frame;
    this.pump();
  }

  private pump(): void {
    if (!this.running || !this.latest) return;
    const f = this.latest;
    if (f.header.seq === this.lastSubmittedSeq && f.recv_ts === this.lastSubmittedRecvTs) return; // each frame is judged once
    if (this.inflight >= this.config.maxInflight) return;
    const now = Date.now();
    if (now - this.lastSubmitAt < this.config.minIntervalMs) return;
    this.lastSubmittedSeq = f.header.seq;
    this.lastSubmittedRecvTs = f.recv_ts;
    this.lastSubmitAt = now;
    void this.evaluate(f);
  }

  private async evaluate(frame: Frame): Promise<void> {
    this.inflight++;
    this.submitted++;
    const t0 = performance.now();
    const ac = new AbortController();
    const models = this.config.models.length ? this.config.models : ['gemini-3.1-flash-lite'];
    // Zoom: if the press was small recently, look at a crop around it (every 4th request sees the full frame to re-acquire).
    let crop: Crop | null = null;
    let jpeg = frame.jpeg;
    if (this.zoomEnabled && this.lastBox && Date.now() - this.lastBox.at < 4000 && boxArea(this.lastBox.box) < ZOOM_TRIGGER_AREA && this.submitted % 4 !== 0) {
      try { crop = cropAround(this.lastBox.box); jpeg = await cropJpeg(frame.jpeg, crop); } catch { crop = null; jpeg = frame.jpeg; }
    }
    try {
      const attempt = async (m: string) => {
        const now = Date.now();
        if ((this.coolDownUntil.get(m) ?? 0) > now) throw new Error(`${m}: cooling down after rate limit`);
        const pace = MODEL_PACE_MS[m.split('/')[0]] ?? 0;
        if (pace) { const wait = (this.lastStartByModel.get(m) ?? 0) + pace - now; if (wait > 0) await new Promise((r) => setTimeout(r, wait)); this.lastStartByModel.set(m, Date.now()); }
        const r = await classifyFrame(m, jpeg, { prompt: this.config.prompt, signal: ac.signal, timeoutMs: this.config.timeoutMs, refs: this.config.refs });
        if (!r.verdict) {
          if (r.error !== 'aborted') { const pm = this.perModel.get(m) ?? { wins: 0, lat: [], errors: 0 }; pm.errors++; this.perModel.set(m, pm); }
          if (/429|too many|quota/i.test(r.error ?? '')) this.coolDownUntil.set(m, Date.now() + COOL_DOWN_MS);
          throw new Error(`${m}: ${r.error ?? 'no verdict'}`);
        }
        return r as ClassifyResult & { verdict: Verdict };
      };
      let winner: ClassifyResult & { verdict: Verdict };
      if ((this.config.mode ?? 'primary') === 'race' || models.length === 1) {
        winner = await Promise.any(models.map(attempt));
      } else {
        // primary + fallbacks: the accurate model answers; a fallback only runs if it fails
        const errors: Error[] = [];
        let found: (ClassifyResult & { verdict: Verdict }) | null = null;
        for (const m of models) {
          try { found = await attempt(m); break; } catch (e) { errors.push(e as Error); }
        }
        if (!found) throw new AggregateError(errors, 'all models failed');
        winner = found;
      }
      { const pm = this.perModel.get(winner.model) ?? { wins: 0, lat: [], errors: 0 }; pm.wins++; pm.lat.push(winner.latency_ms); if (pm.lat.length > 40) pm.lat.shift(); this.perModel.set(winner.model, pm); }
      ac.abort(); // cancel the slower racers
      const latency_ms = performance.now() - t0;
      this.latencies.push(latency_ms);
      if (this.latencies.length > 40) this.latencies.shift();
      this.completed++;
      this.completions.push(Date.now());
      // Map the box back to full-frame coordinates and remember it for the next zoom.
      const v: Verdict = { ...winner.verdict };
      const seenArea = v.press_visible && v.bbox ? boxArea(v.bbox) : 0;
      if (v.press_visible && v.bbox && boxArea(v.bbox) > 0) {
        v.bbox = crop ? uncrop(v.bbox, crop) : v.bbox;
        this.lastBox = { box: v.bbox, at: frame.recv_ts };
        this.zoomMisses = 0;
      } else if (crop) {
        // not found inside the crop: widen next time, forget after a few misses
        if (++this.zoomMisses >= 2) this.lastBox = null;
        v.bbox = undefined;
      } else {
        v.bbox = undefined;
      }
      this.onVerdict({ verdict: v, frame, latency_ms, model: winner.model, losers: models.filter((m) => m !== winner.model), zoomed: crop ?? undefined, box_area: v.bbox ? boxArea(v.bbox) : 0, seen_area: seenArea });
    } catch (e) {
      this.errors++;
      const err = e as AggregateError;
      const msg = (err.errors?.map((x: Error) => x.message).join(' | ')) ?? String(err.message ?? e);
      this.onError(models.join('+'), msg);
    } finally {
      this.inflight--;
    }
  }

  stats(): DetectorStats {
    const now = Date.now();
    this.completions = this.completions.filter((t) => now - t <= 5_000);
    const s = [...this.latencies].sort((a, b) => a - b);
    const q = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0);
    return {
      inflight: this.inflight,
      decisions_per_s: +(this.completions.length / 5).toFixed(2),
      p50_ms: Math.round(q(0.5)),
      p90_ms: Math.round(q(0.9)),
      last_ms: Math.round(this.latencies[this.latencies.length - 1] ?? 0),
      errors: this.errors,
      submitted: this.submitted,
      completed: this.completed,
      per_model: Object.fromEntries([...this.perModel].map(([m, v]) => { const l = [...v.lat].sort((a, b) => a - b); return [m, { wins: v.wins, p50_ms: Math.round(l[Math.floor(l.length / 2)] ?? 0), errors: v.errors }]; })),
    };
  }
}
