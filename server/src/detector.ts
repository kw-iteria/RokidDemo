// Frame scheduler: keeps up to N model requests in flight against the newest frame,
// optionally racing several models per frame and taking the first valid verdict.
import { classifyFrame, type ClassifyResult, type Verdict } from './vision.ts';
import type { Frame } from './frames.ts';

export interface DetectorConfig {
  models: string[];        // 1 model, or several to race per frame
  maxInflight: number;     // concurrent frame evaluations
  minIntervalMs: number;   // minimum spacing between submissions
  prompt?: string;
  timeoutMs: number;
  refs?: { label: string; jpeg: Buffer }[];
}

export interface VerdictOut {
  verdict: Verdict;
  frame: Frame;
  latency_ms: number;
  model: string;
  losers?: string[];
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

export class Detector {
  config: DetectorConfig;
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
    try {
      const attempts = models.map((m) =>
        classifyFrame(m, frame.jpeg, { prompt: this.config.prompt, signal: ac.signal, timeoutMs: this.config.timeoutMs, refs: this.config.refs }).then((r) => {
          if (!r.verdict) {
            if (r.error !== 'aborted') { const pm = this.perModel.get(m) ?? { wins: 0, lat: [], errors: 0 }; pm.errors++; this.perModel.set(m, pm); }
            throw new Error(`${m}: ${r.error ?? 'no verdict'}`);
          }
          return r as ClassifyResult & { verdict: Verdict };
        }),
      );
      const winner = await Promise.any(attempts);
      { const pm = this.perModel.get(winner.model) ?? { wins: 0, lat: [], errors: 0 }; pm.wins++; pm.lat.push(winner.latency_ms); if (pm.lat.length > 40) pm.lat.shift(); this.perModel.set(winner.model, pm); }
      ac.abort(); // cancel the slower racers
      const latency_ms = performance.now() - t0;
      this.latencies.push(latency_ms);
      if (this.latencies.length > 40) this.latencies.shift();
      this.completed++;
      this.completions.push(Date.now());
      this.onVerdict({ verdict: winner.verdict, frame, latency_ms, model: winner.model, losers: models.filter((m) => m !== winner.model) });
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
