// The plate-press workflow state machine. Pure logic, no I/O: feed it verdicts and time.
import type { Verdict } from './vision.ts';

export type Phase = 'IDLE' | 'SEARCHING' | 'AWAIT_CLOSE' | 'COUNTDOWN' | 'AWAIT_OPEN' | 'COMPLETE';

export interface SessionParams {
  countdown_ms: number;      // press dwell time
  confirmations: number;     // consecutive agreeing verdicts needed for a transition
  fast_confidence: number;   // a single verdict at/above this confidence is enough
  backdate: boolean;         // start the countdown at the capture time of the first "closed" frame
  auto_restart_ms: number;   // 0 = wait for a tap/restart after COMPLETE
  lost_after_ms: number;     // show a "look at the press" hint after this long without seeing it
}

export const DEFAULT_PARAMS: SessionParams = {
  countdown_ms: 10_000,
  confirmations: 2,
  fast_confidence: 0.9,
  backdate: true,
  auto_restart_ms: 12_000,
  lost_after_ms: 3_000,
};

export interface VerdictEvent {
  verdict: Verdict;
  frame_ts: number;   // server clock when the frame was received
  latency_ms: number;
  model: string;
  seq: number;
}

export interface SessionSnapshot {
  phase: Phase;
  phase_since: number;
  message: string;
  sub: string;
  alarm: boolean;
  countdown: { ends_at: number; started_at: number; duration_ms: number } | null;
  hint: string;
  run: number;
  last_verdict: (Verdict & { age_ms: number; latency_ms: number; model: string }) | null;
  events: { at: number; text: string }[];
}

const TEXT: Record<Phase, { message: string; sub: string }> = {
  IDLE: { message: 'Ready', sub: 'Waiting for camera' },
  SEARCHING: { message: 'Looking for the plate press', sub: 'Look at the press' },
  AWAIT_CLOSE: { message: 'Please close the plate press', sub: '' },
  COUNTDOWN: { message: 'Pressing', sub: 'Keep the press closed' },
  AWAIT_OPEN: { message: 'Open the plate press', sub: 'Press time is over' },
  COMPLETE: { message: 'Plate press motion completed', sub: 'Opened' },
};

export class PressSession {
  phase: Phase = 'IDLE';
  phase_since = Date.now();
  run = 0;
  params: SessionParams;
  private streakState: string | null = null;
  private streakCount = 0;
  private streakFirstTs = 0;
  private lastSeenTs = 0;
  private lastVerdict: VerdictEvent | null = null;
  private lastAcceptedFrameTs = 0;
  private countdown: SessionSnapshot['countdown'] = null;
  private events: { at: number; text: string }[] = [];
  private listeners = new Set<(s: SessionSnapshot, changed: boolean) => void>();

  constructor(params: Partial<SessionParams> = {}) {
    this.params = { ...DEFAULT_PARAMS, ...params };
  }

  onChange(fn: (s: SessionSnapshot, changed: boolean) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private log(text: string): void {
    this.events.push({ at: Date.now(), text });
    if (this.events.length > 60) this.events.shift();
  }

  private setPhase(p: Phase, now = Date.now()): void {
    if (p === this.phase) return;
    this.log(`${this.phase} → ${p}`);
    this.phase = p;
    this.phase_since = now;
    this.streakState = null;
    this.streakCount = 0;
    if (p !== 'COUNTDOWN') this.countdown = null;
    this.emit(true);
  }

  private emit(changed: boolean): void {
    const snap = this.snapshot();
    for (const l of this.listeners) l(snap, changed);
  }

  /** Start (or restart) a run: camera frames are flowing, go look for the press. */
  start(): void {
    this.run++;
    this.countdown = null;
    this.lastAcceptedFrameTs = 0;
    this.log(`run ${this.run} started`);
    this.phase = 'IDLE';
    this.setPhase('SEARCHING');
  }

  /** Camera went away: drop back to IDLE (a new run starts when frames return). */
  idle(): void {
    if (this.phase === 'IDLE') return;
    this.countdown = null;
    this.log('camera lost');
    this.setPhase('IDLE');
  }

  /** Called by the host at ~10 Hz so time-based transitions fire promptly. */
  tick(now = Date.now()): void {
    if (this.phase === 'COUNTDOWN' && this.countdown && now >= this.countdown.ends_at) {
      this.setPhase('AWAIT_OPEN', now);
      return;
    }
    if (this.phase === 'COMPLETE' && this.params.auto_restart_ms > 0 && now - this.phase_since >= this.params.auto_restart_ms) {
      this.start();
      return;
    }
    this.emit(false);
  }

  /** Feed a model verdict. Out-of-order (older-frame) verdicts are dropped. */
  onVerdict(ev: VerdictEvent): void {
    if (ev.frame_ts < this.lastAcceptedFrameTs) return; // stale: a newer frame was already judged
    this.lastAcceptedFrameTs = ev.frame_ts;
    this.lastVerdict = ev;
    const v = ev.verdict;
    if (v.press_visible && v.lid !== 'unknown') this.lastSeenTs = ev.frame_ts;

    // Streak tracking of the lid state (unknown/partial neither extend nor break an open/closed streak).
    const s = v.press_visible ? v.lid : 'unknown';
    if (s === 'open' || s === 'closed') {
      if (this.streakState === s) this.streakCount++;
      else { this.streakState = s; this.streakCount = 1; this.streakFirstTs = ev.frame_ts; }
    }
    const confirmed = (state: 'open' | 'closed') =>
      this.streakState === state && (this.streakCount >= this.params.confirmations || (this.streakCount >= 1 && v.confidence >= this.params.fast_confidence));

    switch (this.phase) {
      case 'SEARCHING':
        if (v.press_visible && v.confidence >= 0.5) this.setPhase('AWAIT_CLOSE', ev.frame_ts);
        break;
      case 'AWAIT_CLOSE':
        if (confirmed('closed')) {
          const started_at = this.params.backdate ? this.streakFirstTs : Date.now();
          this.countdown = { started_at, ends_at: started_at + this.params.countdown_ms, duration_ms: this.params.countdown_ms };
          this.log(`closed detected (model latency ${Math.round(ev.latency_ms)} ms, backdated ${Date.now() - started_at} ms)`);
          this.setPhase('COUNTDOWN', started_at);
        }
        break;
      case 'AWAIT_OPEN':
        if (confirmed('open')) {
          this.log(`open detected (model latency ${Math.round(ev.latency_ms)} ms)`);
          this.setPhase('COMPLETE', ev.frame_ts);
        }
        break;
      default:
        break;
    }
    this.emit(false);
  }

  /** Temple tap on the glasses / button on the desktop. */
  gesture(name: string): void {
    if (name === 'tap' || name === 'restart') {
      if (this.phase === 'COMPLETE' || this.phase === 'IDLE') this.start();
      else if (name === 'restart') this.start();
    }
  }

  setParams(p: Partial<SessionParams>): void {
    this.params = { ...this.params, ...p };
    this.emit(true);
  }

  snapshot(now = Date.now()): SessionSnapshot {
    const t = TEXT[this.phase];
    let hint = '';
    if ((this.phase === 'AWAIT_CLOSE' || this.phase === 'AWAIT_OPEN') && this.lastSeenTs && now - this.lastSeenTs > this.params.lost_after_ms) hint = 'Look at the press';
    const lv = this.lastVerdict;
    return {
      phase: this.phase,
      phase_since: this.phase_since,
      message: t.message,
      sub: t.sub,
      alarm: this.phase === 'AWAIT_OPEN',
      countdown: this.countdown,
      hint,
      run: this.run,
      last_verdict: lv ? { ...lv.verdict, age_ms: now - lv.frame_ts, latency_ms: Math.round(lv.latency_ms), model: lv.model } : null,
      events: this.events.slice(-12),
    };
  }
}
