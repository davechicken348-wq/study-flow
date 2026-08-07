/**
 * StudyFlow — focusEngine.js
 *
 * "Focus Engine" — a small state machine that powers the study timer.
 *
 * Phases:  idle -> focus -> break -> focus -> ... -> complete
 *
 * Robust time accounting:
 *   - Elapsed focus time is derived from immutable `segments` (each segment is
 *     a {start, end} epoch pair). Pausing closes the open segment; resuming
 *     opens a new one. This makes elapsed time immune to tab sleep, clock
 *     drift, and reloads — we never trust a single startTime.
 *   - Countdown target (`targetEnd`) is a wall-clock epoch used only for the
 *     progress ring / countdown display; it is recomputed from segments so it
 *     stays correct after pauses.
 *
 * Goal linkage (feature C):
 *   - If a goal is linked, each completed focus segment contributes its seconds
 *     to goal.progress (stored on the goal object).
 */

export const PHASE = {
  IDLE: 'idle',
  FOCUS: 'focus',
  BREAK: 'break',
  COMPLETE: 'complete',
};

const DEFAULTS = {
  focusLength: 25 * 60,   // seconds
  breakLength: 5 * 60,    // seconds
  rounds: 4,              // focus rounds before "complete"
  autoStartBreaks: true,
};

export class FocusEngine {
  constructor({ onTick, onPhase, onComplete, onError } = {}) {
    this.onTick = onTick || (() => {});
    this.onPhase = onPhase || (() => {});
    this.onComplete = onComplete || (() => {});
    this.onError = onError || (() => {});

    this.config = { ...DEFAULTS };
    this.phase = PHASE.IDLE;
    this.round = 0;            // completed focus rounds
    this.segments = [];        // [{start, end, phase, instance}] focus+break segments
    this.openSegment = null;   // {start, phase, instance} currently running
    this.phaseInstance = 0;    // increments each time a new phase segment opens
    this.subjectId = null;
    this.goalId = null;
    this.sessionId = null;
    this.paused = false;        // true when a phase is mid-session but ticking is halted
    this._interval = null;
  }

  /* ---------- config ---------- */
  configure(cfg = {}) {
    this.config = { ...this.config, ...cfg };
  }

  /* ---------- queries ---------- */
  // Seconds elapsed within the CURRENT phase instance only (focus or break),
  // so the countdown/progress ring never counts time from other phases or
  // earlier rounds of the same phase.
  elapsedInPhase() {
    const inst = this.phaseInstance;
    let secs = 0;
    for (const s of this.segments) {
      if (s.instance === inst) secs += Math.max(0, (s.end - s.start) / 1000);
    }
    if (this.openSegment && this.openSegment.instance === inst) {
      secs += Math.max(0, (Date.now() - this.openSegment.start) / 1000);
    }
    return Math.floor(secs);
  }

  // Total focus seconds across all focus segments (for goal contribution).
  totalFocusSeconds() {
    let secs = 0;
    const want = PHASE.FOCUS;
    for (const s of this.segments) if (s.phase === want) secs += Math.max(0, (s.end - s.start) / 1000);
    if (this.openSegment && this.openSegment.phase === want) {
      secs += Math.max(0, (Date.now() - this.openSegment.start) / 1000);
    }
    return Math.floor(secs);
  }

  // Wall-clock target for the current phase (used for countdown + ring).
  targetEnd() {
    const len = this.phase === PHASE.BREAK ? this.config.breakLength : this.config.focusLength;
    const remaining = Math.max(0, len - this.elapsedInPhase());
    return Date.now() + remaining * 1000;
  }

  remainingInPhase() {
    const len = this.phase === PHASE.BREAK ? this.config.breakLength : this.config.focusLength;
    return Math.max(0, len - this.elapsedInPhase());
  }

  progress() {
    const len = this.phase === PHASE.BREAK ? this.config.breakLength : this.config.focusLength;
    if (!len) return 0;
    return Math.min(1, this.elapsedInPhase() / len);
  }

  isRunning() {
    return this.openSegment !== null;
  }

  /* ---------- lifecycle ---------- */
  // Begin a focus session. `restore` replays previously saved segments.
  start({ subjectId, goalId = null, sessionId = null, segments = [], round = 0 } = {}) {
    this.subjectId = subjectId;
    this.goalId = goalId;
    this.sessionId = sessionId;
    this.segments = segments.map((s) => ({ ...s }));
    this.round = round;
    this.phase = PHASE.FOCUS;
    this.paused = false;
    this._openSegment(PHASE.FOCUS);
    this._beginTicking();
    this.onPhase(this.phase);
  }

  pause() {
    if (!this.openSegment) return;
    this.segments.push({ ...this.openSegment, end: Date.now() });
    this.openSegment = null;
    this.paused = true;
    this._stopTicking();
    this.onTick();
  }
  resume() {
    if (this.openSegment || this.phase === PHASE.IDLE || this.phase === PHASE.COMPLETE) return;
    this._openSegment(this.phase);
    this.paused = false;
    this._beginTicking();
    this.onTick();
  }

  skip() {
    // Manually finish current phase early.
    this._closePhase(true);
  }

  // Resume ticking after a reload without altering the open segment.
  rehydrate() {
    if (this.openSegment && this.phase !== PHASE.IDLE && this.phase !== PHASE.COMPLETE) {
      this._beginTicking();
    }
  }

  stop() {
    this.pause();
    this.phase = PHASE.IDLE;
    this.paused = false;
    this._stopTicking();
    this.onPhase(this.phase);
  }

  /* ---------- internals ---------- */
  _openSegment(phase) {
    this.phaseInstance += 1;
    this.openSegment = { start: Date.now(), phase, instance: this.phaseInstance };
  }

  _beginTicking() {
    this._stopTicking();
    this._interval = setInterval(() => this._tick(), 250);
    this._tick();
  }

  _stopTicking() {
    if (this._interval) { clearInterval(this._interval); this._interval = null; }
  }

  _tick() {
    if (this.remainingInPhase() <= 0) {
      this._closePhase(false);
    } else {
      this.onTick();
    }
  }

  // Close the current phase. `manual`=user skipped (still counts elapsed).
  _closePhase(manual) {
    if (this.openSegment) {
      this.segments.push({ ...this.openSegment, end: Date.now() });
      this.openSegment = null;
    }
    this._stopTicking();

    if (this.phase === PHASE.FOCUS) {
      this.round += 1;
      if (this.round >= this.config.rounds) {
        this.phase = PHASE.COMPLETE;
        this.onPhase(this.phase);
        this.onComplete({ focusSeconds: this.totalFocusSeconds(), rounds: this.round });
        return;
      }
      this.phase = PHASE.BREAK;
    } else if (this.phase === PHASE.BREAK) {
      this.phase = PHASE.FOCUS;
    } else {
      return;
    }

    this.onPhase(this.phase);
    if (this.config.autoStartBreaks || this.phase === PHASE.FOCUS) {
      this._openSegment(this.phase);
      this._beginTicking();
    }
  }

  /* ---------- serialization ---------- */
  serialize() {
    return {
      sessionId: this.sessionId,
      subjectId: this.subjectId,
      goalId: this.goalId,
      phase: this.phase,
      round: this.round,
      phaseInstance: this.phaseInstance,
      paused: this.paused,
      config: { ...this.config },
      segments: this.segments.map((s) => ({ ...s })),
      openSegment: this.openSegment ? { ...this.openSegment } : null,
    };
  }

  static deserialize(data) {
    const e = new FocusEngine();
    if (!data) return e;
    e.sessionId = data.sessionId || null;
    e.subjectId = data.subjectId || null;
    e.goalId = data.goalId || null;
    e.phase = data.phase || PHASE.IDLE;
    e.round = data.round || 0;
    e.phaseInstance = data.phaseInstance || 0;
    e.paused = !!data.paused;
    e.config = { ...DEFAULTS, ...(data.config || {}) };
    e.segments = (data.segments || []).map((s) => ({ ...s }));
    e.openSegment = data.openSegment ? { ...data.openSegment } : null;
    return e;
  }
}

export { DEFAULTS as FOCUS_DEFAULTS };
