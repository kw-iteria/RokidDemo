// Frame scheduler: keeps up to N model requests in flight against the newest frame,
// optionally racing several models per frame and taking the first valid verdict.
import { classifyFrame, type ClassifyResult, type Verdict } from './vision.ts';
import type { Frame } from './frames.ts';
import { boxArea, cropAround, cropJpeg, uncrop, ZOOM_TRIGGER_AREA, type Crop } from './zoom.ts';
import { classifyLocal, localAvailable } from './local.ts';

export interface DetectorConfig {
  models: string[];        // cloud models: raced per frame, primary + fallbacks, or (mode 'local') the verifier
  mode?: 'race' | 'primary' | 'local';
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
  local?: { count: number; vetoed: number; p50_ms: number };
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
  /** Local mode: the cloud verifier's latest opinion, used to veto contradicting local verdicts and to track the box. */
  private verifier: { lid: string; at: number } | null = null;
  private localBusy = false;
  private lastVerifierSubmit = 0;
  private verifierInflight = 0;
  localStats = { count: 0, vetoed: 0, p50_ms: 0, lat: [] as number[] };
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
    const now = Date.now();
    if (this.config.mode === 'local' && localAvailable()) {
      if (this.localBusy) return;
      this.lastSubmittedSeq = f.header.seq;
      this.lastSubmittedRecvTs = f.recv_ts;
      this.lastSubmitAt = now;
      void this.evaluateLocal(f);
      // the cloud verifier looks at ~2 frames per second
      if (this.verifierInflight < 2 && now - this.lastVerifierSubmit >= 450) { this.lastVerifierSubmit = now; void this.evaluate(f, true); }
      return;
    }
    if (this.inflight >= this.config.maxInflight) return;
    if (now - this.lastSubmitAt < this.config.minIntervalMs) return;
    this.lastSubmittedSeq = f.header.seq;
    this.lastSubmittedRecvTs = f.recv_ts;
    this.lastSubmitAt = now;
    void this.evaluate(f);
  }

  /** Local classifier on the frame (or its zoom crop): fast verdicts that drive the state machine. */
  private async evaluateLocal(frame: Frame): Promise<void> {
    this.localBusy = true;
    const t0 = performance.now();
    try {
      let crop: Crop | null = null;
      let jpeg = frame.jpeg;
      if (this.zoomEnabled && this.lastBox && Date.now() - this.lastBox.at < 4000 && boxArea(this.lastBox.box) < ZOOM_TRIGGER_AREA) {
        try { crop = cropAround(this.lastBox.box); jpeg = await cropJpeg(frame.jpeg, crop); } catch { crop = null; jpeg = frame.jpeg; }
      }
      const r = await classifyLocal(jpeg);
      const v: Verdict = { ...r.verdict };
      // veto: a fresh contradicting opinion from the cloud verifier makes this verdict "uncertain"
      const fresh = this.verifier && frame.recv_ts - this.verifier.at < 3000;
      let vetoed = false;
      if (fresh && v.press_visible && (v.lid === 'open' || v.lid === 'closed') && (this.verifier!.lid === 'open' || this.verifier!.lid === 'closed') && this.verifier!.lid !== v.lid) { v.lid = 'partial'; vetoed = true; }
      if (fresh && this.verifier!.lid === 'none' && v.press_visible && !crop) { v.press_visible = false; v.lid = 'unknown'; vetoed = true; }
      const latency_ms = performance.now() - t0;
      this.localStats.count++; if (vetoed) this.localStats.vetoed++;
      this.localStats.lat.push(latency_ms); if (this.localStats.lat.length > 40) this.localStats.lat.shift();
      const sorted = [...this.localStats.lat].sort((a, b) => a - b); this.localStats.p50_ms = Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0);
      this.completed++; this.completions.push(Date.now());
      this.onVerdict({ verdict: v, frame, latency_ms, model: vetoed ? 'local/clip (vetoed)' : 'local/clip', zoomed: crop ?? undefined, box_area: this.lastBox ? boxArea(this.lastBox.box) : 0, seen_area: crop ? 0.3 : (this.lastBox ? boxArea(this.lastBox.box) : 0) });
    } catch (e) {
      this.errors++;
      this.onError('local/clip', (e as Error).message);
    } finally {
      this.localBusy = false;
      this.pump();
    }
  }

  private async evaluate(frame: Frame, asVerifier = false): Promise<void> {
    this.inflight++;
    if (asVerifier) this.verifierInflight++;
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
      if (asVerifier) {
        this.verifier = { lid: !v.press_visible ? 'none' : v.confidence >= 0.8 ? v.lid : 'unsure', at: frame.recv_ts };
        this.onVerifier?.({ verdict: v, frame, latency_ms, model: winner.model, zoomed: crop ?? undefined, box_area: v.bbox ? boxArea(v.bbox) : 0, seen_area: seenArea });
        return;
      }
      this.onVerdict({ verdict: v, frame, latency_ms, model: winner.model, losers: models.filter((m) => m !== winner.model), zoomed: crop ?? undefined, box_area: v.bbox ? boxArea(v.bbox) : 0, seen_area: seenArea });
    } catch (e) {
      this.errors++;
      const err = e as AggregateError;
      const msg = (err.errors?.map((x: Error) => x.message).join(' | ')) ?? String(err.message ?? e);
      this.onError(models.join('+'), msg);
    } finally {
      this.inflight--;
      if (asVerifier) this.verifierInflight--;
    }
  }

  /** Verifier verdicts (local mode) for dashboards; they do not drive the state machine. */
  onVerifier: ((v: VerdictOut) => void) | null = null;

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
      local: this.config.mode === 'local' ? { count: this.localStats.count, vetoed: this.localStats.vetoed, p50_ms: this.localStats.p50_ms } : undefined,
    };
  }
}
