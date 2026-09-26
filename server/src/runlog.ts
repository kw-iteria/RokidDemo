// Every workflow run is written to data/runs/<start time>_run<N>.json while it happens: all verdicts
// (with the workflow's waiting reason at that moment), every phase change and, at the end, a summary of
// how far the workflow lagged behind the camera label. A slow countdown can then be explained from the
// file instead of from memory (the in-process verdict buffer only holds the last ~40 s).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface RunVerdict {
  at: number; latency_ms: number; model: string; phase: string;
  lid: string; press_visible: boolean; confidence: number; hand: boolean; motion: number; box_area: number; why: string;
}
interface PhaseChange { at: number; since: number; from: string; to: string; note: string }
interface Lag {
  to: string; at: number; wanted: string; first_frame: number | null; label_shown: number | null;
  gap_after_label_ms: number | null; gap_after_frame_ms: number | null; verdicts_waited: number; reasons: Record<string, number>;
}
interface RunRecord {
  run: number; started_at: number; ended_at: number | null; context: unknown;
  phases: PhaseChange[]; verdicts: RunVerdict[]; lags: Lag[];
}

const CONFIDENT = 0.8;

export class RunRecorder {
  private cur: RunRecord | null = null;
  private file = '';
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;

  private readonly dir: string;
  private readonly context: () => unknown;

  constructor(dir: string, context: () => unknown) { // no parameter properties: Node's type stripping rejects them
    this.dir = dir; this.context = context;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  /** A phase change from the session; opens a record when the run number is new, closes it on IDLE. */
  phase(run: number, from: string, to: string, at: number, since: number, note: string): void {
    if (this.cur && this.cur.run !== run) this.end(at);
    if (!this.cur && to !== 'IDLE') this.begin(run, at);
    if (!this.cur) return;
    this.cur.phases.push({ at, since, from, to, note });
    if (to === 'COUNTDOWN' || to === 'COMPLETE') this.cur.lags.push(this.lag(to, at));
    if (to === 'IDLE') this.end(at); else this.save();
  }

  verdict(v: RunVerdict): void {
    if (!this.cur) return;
    this.cur.verdicts.push(v);
    this.dirty = true;
    if (!this.timer) { this.timer = setTimeout(() => { this.timer = null; if (this.dirty) this.save(); }, 2000); this.timer.unref(); }
  }

  /** Summaries of the recorded runs, newest first (for /api/runs). */
  list(limit = 20): unknown[] {
    return readdirSync(this.dir).filter((f) => f.endsWith('.json')).sort().reverse().slice(0, limit).map((f) => {
      try {
        const r = JSON.parse(readFileSync(resolve(this.dir, f), 'utf8')) as RunRecord;
        return { file: f, run: r.run, started_at: r.started_at, ended_at: r.ended_at, verdicts: r.verdicts.length, phases: r.phases.map((p) => `${p.to}@${p.at - r.started_at}`), lags: r.lags };
      } catch { return { file: f, error: 'unreadable' }; }
    });
  }

  /** Synchronous final write (process exit). */
  close(): void { if (this.cur) { this.cur.ended_at = Date.now(); try { writeFileSync(this.file, JSON.stringify(this.cur)); } catch { /* best effort */ } this.cur = null; } }

  private begin(run: number, at: number): void {
    const d = new Date(at); // local time in the file name, like the console shows it
    const two = (n: number) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}-${two(d.getMinutes())}-${two(d.getSeconds())}`;
    this.file = resolve(this.dir, `${stamp}_run${run}.json`);
    this.cur = { run, started_at: at, ended_at: null, context: this.context(), phases: [], verdicts: [], lags: [] };
  }

  private end(at: number): void {
    if (!this.cur) return;
    this.cur.ended_at = at;
    this.save();
    this.cur = null;
  }

  /** How long the workflow took to act after the label first showed the wanted state (since the previous phase change). */
  private lag(to: string, at: number): Lag {
    const r = this.cur!;
    const wanted = to === 'COUNTDOWN' ? 'closed' : 'open';
    const prev = r.phases.length > 1 ? r.phases[r.phases.length - 2].at : r.started_at;
    const seen = r.verdicts.filter((v) => v.at >= prev - 1500 && v.at <= at && v.press_visible && v.lid === wanted && v.confidence >= CONFIDENT);
    const first = seen[0];
    const reasons: Record<string, number> = {};
    for (const v of seen) if (v.why) reasons[v.why] = (reasons[v.why] ?? 0) + 1;
    const shown = first ? first.at + first.latency_ms : null;
    return {
      to, at, wanted,
      first_frame: first?.at ?? null, label_shown: shown,
      gap_after_label_ms: shown === null ? null : at - shown,
      gap_after_frame_ms: first ? at - first.at : null,
      verdicts_waited: seen.filter((v) => v.at + v.latency_ms < at).length,
      reasons,
    };
  }

  private save(): void {
    if (!this.cur) return;
    this.dirty = false;
    writeFile(this.file, JSON.stringify(this.cur)).catch(() => { /* best effort; the next change retries */ });
  }
}
