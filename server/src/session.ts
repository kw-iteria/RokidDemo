// The plate-press workflow state machine. Pure logic, no I/O: feed it verdicts and time.
import type { Verdict } from './vision.ts';

export type Phase = 'IDLE' | 'SEARCHING' | 'AWAIT_CLOSE' | 'COUNTDOWN' | 'AWAIT_OPEN' | 'COMPLETE';

export interface SessionParams {
  countdown_ms: number;      // press dwell time
  confirmations: number;     // consecutive agreeing verdicts needed for a transition
  settle_ms: number;         // a CLOSE also needs the closed streak to span at least this long (lid at rest)
  motion_max: number;        // verdicts on frames with more motion than this do not count toward a streak
  hand_free_close: boolean;  // a CLOSE also needs no hand on the press in the confirming verdicts
  fast_confidence: number;   // a single verdict at/above this confidence is enough
  backdate: boolean;         // start the countdown at the capture time of the first "closed" frame
  auto_restart_ms: number;   // 0 = wait for a tap/restart after COMPLETE
  lost_after_ms: number;     // show a "look at the press" hint after this long without seeing it
}

export const DEFAULT_PARAMS: SessionParams = {
  countdown_ms: 10_000,
  confirmations: 2,
  settle_ms: 700,
  motion_max: 0.25,
  hand_free_close: true,
  fast_confidence: 1.01,   // >1 disables the single-verdict shortcut
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
  motion?: number;    // 0..1 frame-to-frame motion of the source at that frame
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
  IDLE: { message: 'Ready', sub: 'Say "start plate press workflow"' },
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
  private streakLastTs = 0;
  private handFreeSince = 0;   // first frame of the current run of hand-free verdicts inside the streak
  private handFreeCount = 0;
  private openSeen = 0;      // open verdicts seen this run (a close is only accepted after the box was seen open)
  private visibleStreakState: string | null = null;
  private visibleStreakCount = 0;
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
    this.lastAcceptedFrameTs = Date.now(); // verdicts for frames captured before this run are ignored
    this.lastVerdict = null;
    this.lastSeenTs = 0;
    this.openSeen = 0;
    this.log(`run ${this.run} started`);
    this.phase = 'IDLE';
    this.setPhase('SEARCHING');
  }

  /** Back to standby (camera lost, workflow stopped, or completion hold elapsed). */
  idle(reason = 'standby'): void {
    if (this.phase === 'IDLE') return;
    this.countdown = null;
    this.log(reason);
    this.setPhase('IDLE');
  }

  /** Called by the host at ~10 Hz so time-based transitions fire promptly. */
  tick(now = Date.now()): void {
    if (this.phase === 'COUNTDOWN' && this.countdown && now >= this.countdown.ends_at) {
      this.setPhase('AWAIT_OPEN', now);
      return;
    }
    if (this.phase === 'COMPLETE' && this.params.auto_restart_ms > 0 && now - this.phase_since >= this.params.auto_restart_ms) {
      this.idle(); // back to standby; the next "start" (chat, tap, button) begins a new run
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

    // Streak tracking: only strictly consecutive identical verdicts count. Anything else
    // (partial, unknown, not visible, the other state) restarts the streak.
    const moving = (ev.motion ?? 0) > this.params.motion_max;
    const s = !v.press_visible ? 'unknown' : moving && v.lid !== 'unknown' ? 'moving' : v.lid;
    const visibleState = v.press_visible && v.confidence >= 0.5 ? 'visible' : 'none';
    if (this.streakState === s) { this.streakCount++; this.streakLastTs = ev.frame_ts; }
    else { this.streakState = s; this.streakCount = 1; this.streakFirstTs = ev.frame_ts; this.streakLastTs = ev.frame_ts; this.handFreeCount = 0; }
    if (v.hand_on_press) this.handFreeCount = 0;
    else { if (this.handFreeCount === 0) this.handFreeSince = ev.frame_ts; this.handFreeCount++; }
    if (v.press_visible && v.lid === 'open') this.openSeen++;
    if (this.visibleStreakState === visibleState) this.visibleStreakCount++;
    else { this.visibleStreakState = visibleState; this.visibleStreakCount = 1; }
    const confirmed = (state: 'open' | 'closed') =>
      this.streakState === state && (this.streakCount >= this.params.confirmations || (this.streakCount >= 1 && v.confidence >= this.params.fast_confidence));

    switch (this.phase) {
      case 'SEARCHING':
        if (this.visibleStreakState === 'visible' && this.visibleStreakCount >= this.params.confirmations) this.setPhase('AWAIT_CLOSE', ev.frame_ts);
        break;
      case 'AWAIT_CLOSE':
        // A close counts only after the box was seen open in this run (the closing is observed), or,
        // if it was already closed from the start, after a long unbroken closed streak.
        if (
          confirmed('closed') &&
          (this.openSeen >= this.params.confirmations || this.streakCount >= this.params.confirmations * 3) &&
          (!this.params.hand_free_close || this.handFreeCount >= this.params.confirmations) &&   // operator has let go
          this.streakLastTs - (this.params.hand_free_close ? this.handFreeSince : this.streakFirstTs) >= this.params.settle_ms   // lid at rest
        ) {
          const restSince = this.params.hand_free_close ? this.handFreeSince : this.streakFirstTs;
          const started_at = this.params.backdate ? restSince : Date.now();
          this.countdown = { started_at, ends_at: started_at + this.params.countdown_ms, duration_ms: this.params.countdown_ms };
          this.log(`closed detected after ${this.streakCount} verdicts over ${this.streakLastTs - this.streakFirstTs} ms (model latency ${Math.round(ev.latency_ms)} ms, backdated ${Date.now() - started_at} ms)`);
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

  /** Temple double-tap on the glasses / button on the desktop: start, or restart a run in progress. */
  gesture(name: string): void {
    if (name === 'tap') { if (this.phase === 'COMPLETE' || this.phase === 'IDLE') this.start(); }
    else if (name === 'restart' || name === 'start') this.start();
    else if (name === 'stop') this.idle('stopped');
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
