// The plate-press workflow state machine. Pure logic, no I/O: feed it verdicts and time.
import type { Verdict } from './vision.ts';

export type Phase = 'IDLE' | 'SEARCHING' | 'AWAIT_CLOSE' | 'COUNTDOWN' | 'AWAIT_OPEN' | 'COMPLETE';

export interface SessionParams {
  countdown_ms: number;      // press dwell time
  confirmations: number;     // consecutive agreeing verdicts needed for a transition
  settle_ms: number;         // a transition needs agreeing verdicts spanning at least this long (lid at rest)
  min_box_area: number;      // press must cover at least this fraction of the frame to count (else "move closer")
  motion_max: number;        // verdicts on frames with more motion than this do not count toward a streak
  hand_free_close: boolean;  // a CLOSE also needs no hand on the press in the confirming verdicts
  fast_confidence: number;   // a single verdict at/above this confidence is enough
  backdate: boolean;         // start the countdown at the capture time of the first "closed" frame
  auto_restart_ms: number;   // how long the completion tick stays before the run ends and standby returns (0 = stay)
  lost_after_ms: number;     // show a "look at the press" hint after this long without seeing it
}

export const DEFAULT_PARAMS: SessionParams = {
  countdown_ms: 10_000,
  confirmations: 2,
  settle_ms: 250,
  min_box_area: 0.02,
  motion_max: 0.5,        // a head-mounted camera moves a lot; only clearly blurred/moving frames are skipped
  hand_free_close: true,
  fast_confidence: 1.01,   // >1 disables the single-verdict shortcut
  backdate: true,
  auto_restart_ms: 3_000,
  lost_after_ms: 3_000,
};

export interface VerdictEvent {
  verdict: Verdict;
  frame_ts: number;   // server clock when the frame was received
  latency_ms: number;
  model: string;
  seq: number;
  motion?: number;    // 0..1 frame-to-frame motion of the source at that frame
  box_area?: number;  // press size as a fraction of the frame (0 = unknown)
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
  streak: { state: string | null; count: number; span_ms: number; hand_free: number; open_seen: number };
}

const TEXT: Record<Phase, { message: string; sub: string }> = {
  IDLE: { message: 'How can I help you?', sub: '' },
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
  /** Recent accepted verdicts (newest last) for window votes. */
  private window: { ts: number; lid: string; hand: boolean; far: boolean }[] = [];
  private farSince = 0;
  private rollbackVotes = 0;
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
    this.rollbackVotes = 0;
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
    this.window = [];
    this.farSince = 0;
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
      this.idle('run finished'); // the run is over; standby until the next "start"
      return;
    }
    this.emit(false);
  }

  /** Feed a model verdict. Out-of-order (older-frame) verdicts are dropped. */
  onVerdict(ev: VerdictEvent): void {
    if (ev.frame_ts < this.lastAcceptedFrameTs - 1500) return; // far too stale: much newer frames were already judged
    this.lastAcceptedFrameTs = Math.max(this.lastAcceptedFrameTs, ev.frame_ts);
    this.lastVerdict = ev;
    const v = ev.verdict;
    if (v.press_visible && v.lid !== 'unknown') this.lastSeenTs = ev.frame_ts;

    // Window vote: a transition needs a clean run of agreeing verdicts over `settle_ms`, with no
    // contradicting verdict in that window. Frames where the camera moved a lot are ignored, and
    // frames where the press is tiny (far away) never confirm anything.
    const moving = (ev.motion ?? 0) > this.params.motion_max;
    const far = ev.box_area !== undefined && ev.box_area > 0 && ev.box_area < this.params.min_box_area;
    if (v.press_visible && v.lid !== 'unknown' && far) this.farSince = this.farSince || ev.frame_ts; else if (v.press_visible && !far) this.farSince = 0;
    const lid = !v.press_visible ? 'none' : v.lid;
    if (!(moving && v.press_visible)) {
      this.window.push({ ts: ev.frame_ts, lid, hand: Boolean(v.hand_on_press), far });
      this.window.sort((a, b) => a.ts - b.ts);
      const keepFrom = Math.max(ev.frame_ts, this.lastAcceptedFrameTs) - Math.max(this.params.settle_ms, 1500) * 2;
      this.window = this.window.filter((w) => w.ts >= keepFrom);
      if (lid === 'open' && !far) this.openSeen++;
    }
    const visibleState = v.press_visible && v.confidence >= 0.5 ? 'visible' : 'none';
    if (this.visibleStreakState === visibleState) this.visibleStreakCount++;
    else { this.visibleStreakState = visibleState; this.visibleStreakCount = 1; }

    /**
     * Look back `span` ms (longer than the settle time): every verdict in that span must be `state`
     * (or a harmless partial/none minority), the oldest agreeing one must be at least `settle` ms old,
     * and none of them may have seen the press tiny.
     */
    const vote = (state: 'open' | 'closed', settle: number) => {
      const span = settle + 500; // contradiction lookback: a little longer than the settle time
      const now = Math.max(ev.frame_ts, this.lastAcceptedFrameTs);
      const from = now - span;
      const recent = this.window.filter((w) => w.ts >= from && w.lid !== 'none'); // "not seen" neither agrees nor contradicts
      const agree = recent.filter((w) => w.lid === state);
      const contradict = recent.filter((w) => w.lid === (state === 'open' ? 'closed' : 'open'));
      const anyFar = agree.some((w) => w.far);
      const firstAgree = agree[0]?.ts ?? 0;
      const handFree = agree.length > 0 && agree.slice(-this.params.confirmations).every((w) => !w.hand);
      const ok = agree.length >= this.params.confirmations && contradict.length === 0 && !anyFar && agree.length >= recent.length * 0.6 && now - firstAgree >= settle;
      return { ok, count: agree.length, firstTs: firstAgree, handFree };
    };
    // keep the old streak fields roughly meaningful for the diagnostics line
    if (this.streakState === lid) { this.streakCount++; this.streakLastTs = ev.frame_ts; } else { this.streakState = lid; this.streakCount = 1; this.streakFirstTs = ev.frame_ts; this.streakLastTs = ev.frame_ts; this.handFreeCount = 0; }
    if (v.hand_on_press) this.handFreeCount = 0; else { if (this.handFreeCount === 0) this.handFreeSince = ev.frame_ts; this.handFreeCount++; }

    switch (this.phase) {
      case 'SEARCHING':
        if (this.visibleStreakState === 'visible' && this.visibleStreakCount >= this.params.confirmations) this.setPhase('AWAIT_CLOSE', ev.frame_ts);
        break;
      case 'AWAIT_CLOSE': {
        const c = vote('closed', this.params.settle_ms);
        const longClosed = vote('closed', 2500);
        if (c.ok && (this.openSeen >= this.params.confirmations || longClosed.ok) && (c.handFree || !this.params.hand_free_close || longClosed.ok)) {
          const started_at = this.params.backdate ? c.firstTs : Date.now();
          this.countdown = { started_at, ends_at: started_at + this.params.countdown_ms, duration_ms: this.params.countdown_ms };
          this.log(`closed detected: ${c.count} agreeing verdicts over ${ev.frame_ts - c.firstTs} ms, none contradicting (model latency ${Math.round(ev.latency_ms)} ms, backdated ${Date.now() - started_at} ms)`);
          this.setPhase('COUNTDOWN', started_at);
        }
        break;
      }
      case 'COUNTDOWN': {
        // Safety net for the fast local path: if within the first 3 s the (slower, more accurate) verdicts
        // say the press is open twice, the close was a misread: cancel the countdown.
        if (this.countdown && ev.frame_ts - this.countdown.started_at < 3000 && ev.model.startsWith('gpt') && lid === 'open' && v.confidence >= 0.8) {
          this.rollbackVotes++;
          if (this.rollbackVotes >= 2) {
            this.rollbackVotes = 0;
            this.countdown = null;
            this.log('countdown cancelled: the press was not closed');
            this.setPhase('AWAIT_CLOSE', ev.frame_ts);
          }
        }
        break;
      }
      case 'AWAIT_OPEN': {
        const o = vote('open', this.params.settle_ms);
        if (o.ok) {
          this.log(`open detected: ${o.count} agreeing verdicts over ${ev.frame_ts - o.firstTs} ms (model latency ${Math.round(ev.latency_ms)} ms)`);
          this.setPhase('COMPLETE', ev.frame_ts);
        }
        break;
      }
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
    else if ((this.phase === 'AWAIT_CLOSE' || this.phase === 'AWAIT_OPEN') && this.farSince && now - this.farSince > 1500) hint = 'Move closer to the press';
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
      streak: { state: this.streakState, count: this.streakCount, span_ms: this.streakLastTs - this.streakFirstTs, hand_free: this.handFreeCount, open_seen: this.openSeen },
    };
  }
}
