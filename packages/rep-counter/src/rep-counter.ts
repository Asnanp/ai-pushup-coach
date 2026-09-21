/**
 * packages/rep-counter/rep-counter.ts
 *
 * Agent 8 — REP COUNTING ENGINE (runtime)
 *
 * TypeScript mirror of ml/src/rep_segmenter.py.
 *
 * The rep counter is DETERMINISTIC GEOMETRY, not ML. That is deliberate: a
 * rep boundary must be reliable and explainable, and a mis-count would
 * invalidate every downstream metric. The ML model only judges form quality.
 *
 * Thresholds come from autorange calibration rather than hardcoded 90/160.
 * See the long comment in ml/src/rep_segmenter.py for the measurement that
 * forced this — a fixed 155deg "up" threshold silently produced ZERO reps for
 * an entire subject whose front-view elbow angle peaked at 136deg.
 */

import type { FrameFeatures, RepEvent, RepState, RepThresholds } from '@ai-pushup-coach/types';

// Autorange fractions — must match ml/src/rep_segmenter.py
export const UP_FRACTION = 0.72;
export const UP_EXIT_FRACTION = 0.66;
export const DOWN_FRACTION = 0.22;
export const DOWN_EXIT_FRACTION = 0.3;

export const UP_ENTER_MIN = 100;
export const UP_ENTER_MAX = 175;
export const DOWN_ENTER_MIN = 40;
export const DOWN_ENTER_MAX = 150;

export const FALLBACK_THRESHOLDS: RepThresholds = {
  upEnter: 150,
  upExit: 143,
  downEnter: 100,
  downExit: 108,
  calibrated: false,
  observedMin: NaN,
  observedMax: NaN,
};

export const MIN_ROM_DEG = 25;
/**
 * Detectable-range floor. Mirrors MIN_DETECTABLE_ROM_DEG in Python.
 *
 * Deliberately lower than MIN_ROM_DEG: a shallow rep is still a rep. The
 * spec is explicit that a bad repetition must be counted as invalid rather
 * than discarded, and depth is precisely what the depth feature grades. If
 * the counter refused shallow reps, the depth score would have nothing to
 * judge and the "invalid rep" path would never fire for shallow form.
 */
export const MIN_DETECTABLE_ROM_DEG = 18;
export const MIN_REP_SECONDS = 0.35;
/** Mirrors Python: p95 of real rep duration is 5.37s, so 6s is the cutoff. */
export const MAX_REP_SECONDS = 6;
export const MIN_FRAMES_TO_CALIBRATE = 15;
export const MEDIAN_FILTER_K = 5;
export const SMOOTH_WINDOW = 9;
export const SMOOTH_MIN_FRAMES = 12;

/**
 * Anatomical plausibility bounds for the elbow angle.
 *
 * MediaPipe occasionally collapses an arm so the wrist landmark sits on the
 * elbow, driving the interior angle toward zero. An 11-14 degree elbow is
 * physically impossible. Measured on the training dataset, 5 of 144 clips had
 * more than 5% such frames, and the worst had 32.8% -- enough to stretch the
 * calibration band to 10-163 degrees and place the down threshold below every
 * real frame, which silently produced zero reps.
 */
export const ELBOW_ANGLE_MIN_PLAUSIBLE = 25;
export const ELBOW_ANGLE_MAX_PLAUSIBLE = 179.5;

/** Blank anatomically impossible samples. Returns the cleaned value or NaN. */
export function maskImplausibleAngle(value: number): number {
  if (!Number.isFinite(value)) return Number.NaN;
  if (value < ELBOW_ANGLE_MIN_PLAUSIBLE || value > ELBOW_ANGLE_MAX_PLAUSIBLE) {
    return Number.NaN;
  }
  return value;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function percentile(values: number[], p: number): number {
  const f = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!f.length) return NaN;
  const i = (f.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? f[lo] : f[lo] + (f[hi] - f[lo]) * (i - lo);
}

/**
 * Causal low-pass filter for the live elbow signal.
 *
 * Implemented as a fixed-size ring buffer rather than the offline boxcar used
 * in Python, because the live app cannot look ahead. The effective response is
 * equivalent for our thresholds.
 */
export class CausalSmoother {
  private buf: number[] = [];

  constructor(private readonly window = SMOOTH_WINDOW) {}

  push(value: number): number {
    if (!Number.isFinite(value)) {
      return this.buf.length ? this.buf[this.buf.length - 1] : Number.NaN;
    }
    this.buf.push(value);
    if (this.buf.length > this.window) this.buf.shift();
    const sum = this.buf.reduce((a, b) => a + b, 0);
    return sum / this.buf.length;
  }

  get filled(): boolean {
    return this.buf.length >= this.window;
  }

  reset(): void {
    this.buf = [];
  }
}

/** Median-of-K spike rejection. */
export class MedianFilter {
  private buf: number[] = [];

  constructor(private readonly k = MEDIAN_FILTER_K) {}

  push(value: number): number {
    this.buf.push(value);
    if (this.buf.length > this.k) this.buf.shift();
    const sorted = [...this.buf].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  reset(): void {
    this.buf = [];
  }
}

/**
 * Find turning points of a movement signal.
 *
 * Mirrors _local_extrema() in Python. Exists to answer "what level does the
 * signal return to?", which is the only reliable way to distinguish a repeated
 * movement from one large excursion. Percentiles cannot do this: a single deep
 * push-up at the end of a clip moves p95 as much as twenty shallow ones.
 *
 * Measured failure this prevents: a clip oscillating 77-124 deg for 246 frames
 * (many clean reps) and then extending to 169 deg once. p95 picked up the 169,
 * pushing upEnter to 139 -- above the 122 the subject actually reached on every
 * real rep -- so the FSM never left READY and the clip scored zero.
 */
export function localExtrema(
  signal: number[],
  minProminenceFrac = 0.15,
): { maxima: number[]; minima: number[] } {
  const vals = signal.filter(Number.isFinite);
  if (vals.length < MIN_FRAMES_TO_CALIBRATE) return { maxima: [], minima: [] };

  const rng = percentile(vals, 0.95) - percentile(vals, 0.05);
  if (!(rng > 0)) return { maxima: [], minima: [] };
  const minProm = Math.max(4, rng * minProminenceFrac);

  const maxima: number[] = [];
  const minima: number[] = [];

  let lastExtremeIdx = 0;
  let direction = 0; // +1 rising, -1 falling, 0 unknown

  for (let i = 1; i < vals.length; i++) {
    const delta = vals[i] - vals[lastExtremeIdx];

    if (direction >= 0 && delta < 0) {
      if (direction > 0) maxima.push(vals[lastExtremeIdx]);
      direction = -1;
      lastExtremeIdx = i;
    } else if (direction <= 0 && delta > 0) {
      if (direction < 0) minima.push(vals[lastExtremeIdx]);
      direction = 1;
      lastExtremeIdx = i;
    } else {
      lastExtremeIdx = i;
    }
  }

  if (maxima.length >= 3 && minima.length >= 3) {
    const medMax = median(maxima);
    const medMin = median(minima);
    if (medMax - medMin < minProm) return { maxima: [], minima: [] };
  }

  return { maxima, minima };
}

function median(values: number[]): number {
  if (!values.length) return Number.NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Derive up/down thresholds from observed elbow-angle samples.
 * Used by the calibration screen before a workout starts.
 *
 * Mirrors calibrate_thresholds() in Python — see that function for the
 * measurements behind each safeguard.
 */
export function calibrateThresholds(samples: number[]): RepThresholds {
  const masked = samples.map(maskImplausibleAngle);
  const valid = masked.filter(Number.isFinite);
  if (valid.length < MIN_FRAMES_TO_CALIBRATE) return { ...FALLBACK_THRESHOLDS };

  // Operating band from oscillation structure, with a percentile fallback.
  const { maxima, minima } = localExtrema(valid);

  let topRef: number;
  let bottomRef: number;
  if (maxima.length >= 2 && minima.length >= 2) {
    topRef = median(maxima);
    bottomRef = median(minima);
  } else {
    topRef = percentile(valid, 0.9);
    bottomRef = percentile(valid, 0.1);
  }

  // Extremes still count, but only where the structure supports them.
  let hi = Math.max(topRef, percentile(valid, 0.9));
  let lo = Math.min(bottomRef, percentile(valid, 0.1));
  let span = hi - lo;

  if (span < MIN_DETECTABLE_ROM_DEG) {
    lo = percentile(valid, 0.05);
    hi = percentile(valid, 0.95);
    span = hi - lo;
  }

  if (!Number.isFinite(span) || span < MIN_DETECTABLE_ROM_DEG) {
    return { ...FALLBACK_THRESHOLDS, observedMin: lo, observedMax: hi };
  }

  let upEnter = clamp(lo + span * UP_FRACTION, UP_ENTER_MIN, UP_ENTER_MAX);
  let upExit = clamp(lo + span * UP_EXIT_FRACTION, upEnter - 12, upEnter - 1);
  let downEnter = clamp(lo + span * DOWN_FRACTION, DOWN_ENTER_MIN, DOWN_ENTER_MAX);
  let downExit = clamp(lo + span * DOWN_EXIT_FRACTION, downEnter + 1, downEnter + 15);

  // ------------------------------------------------------------------
  // Guarantee reachability.
  //
  // Absolute clamps alone are not enough: a threshold the signal can never
  // cross is not conservative, it is a silent zero. Measured failure:
  // good_side_subject_004 sweeps 129-177 deg -- a textbook push-up -- but its
  // minimum never reached the old DOWN_ENTER_MAX of 120, so DOWN was
  // unreachable and the clip produced zero reps.
  // ------------------------------------------------------------------
  const lowFloor = lo + span * 0.1;
  const highCeiling = hi - span * 0.1;

  if (downEnter > lowFloor) downEnter = lowFloor;
  if (upEnter > highCeiling) upEnter = highCeiling;

  downEnter = Math.min(downEnter, upEnter - 0.25 * span);
  downEnter = Math.max(downEnter, lo + 0.02 * span);

  upExit = Math.min(Math.max(downExit, upEnter - 0.18 * span), upEnter - 2);
  downExit = Math.min(
    Math.max(downEnter + 2, downEnter + 0.08 * span),
    upEnter - 0.3 * span,
  );

  // Final safety: thresholds must be strictly ordered or the FSM cannot make
  // progress.
  if (!(downEnter < downExit && downExit < upExit && upExit < upEnter)) {
    downEnter = lo + span * 0.15;
    downExit = lo + span * 0.25;
    upExit = lo + span * 0.65;
    upEnter = lo + span * 0.78;
  }

  return {
    upEnter,
    upExit,
    downEnter,
    downExit,
    calibrated: true,
    observedMin: lo,
    observedMax: hi,
  };
}

export interface RepCounterOptions {
  thresholds?: RepThresholds;
  minRom?: number;
  minRepSeconds?: number;
  maxRepSeconds?: number;
}

/**
 * Finite-state rep segmenter with hysteresis.
 *
 *   READY -> UP -> DESCENDING -> DOWN -> ASCENDING -> UP (+emit rep)
 *
 * Hysteresis (upEnter != upExit, downEnter != downExit) is what prevents a
 * noisy signal from oscillating across a single threshold and double-counting.
 */
export class RepCounter {
  private state: RepState = 'READY';
  private thresholds: RepThresholds;

  private readonly minRom: number;
  private readonly minRepSeconds: number;
  private readonly maxRepSeconds: number;

  private smoother = new CausalSmoother();
  private median = new MedianFilter();

  private frames: FrameFeatures[] = [];
  private repStartTime: number | null = null;
  private repMin = 180;
  private repMax = 0;
  private phaseExtreme = 180;

  /**
   * True until the signal first reaches the top of the movement. While set, the
   * rep window start slides forward with every new high, so a session that
   * opens mid-descent does not report its first rep as lasting the entire
   * preamble.
   */
  private seekingTop = true;
  private peakSoFar = 0;

  private count = 0;
  /** Sessions' completed reps, in order. */
  readonly reps: RepEvent[] = [];

  constructor(opts: RepCounterOptions = {}) {
    this.thresholds = opts.thresholds ?? { ...FALLBACK_THRESHOLDS };
    this.minRom = opts.minRom ?? MIN_DETECTABLE_ROM_DEG;
    this.minRepSeconds = opts.minRepSeconds ?? MIN_REP_SECONDS;
    this.maxRepSeconds = opts.maxRepSeconds ?? MAX_REP_SECONDS;
  }

  getState(): RepState {
    return this.state;
  }

  getThresholds(): Readonly<RepThresholds> {
    return this.thresholds;
  }

  getRepCount(): number {
    return this.count;
  }

  /**
   * The filtered angle the state machine most recently consumed.
   *
   * Exposed so callers can maintain a rolling calibration window from the same
   * signal the FSM sees, rather than re-filtering the raw angle through a
   * second smoother (which would diverge from this one).
   */
  getLastAngle(): number {
    return this.lastAngle;
  }

  /** Progress through the current rep, 0 (top) -> 1 (bottom). */
  getCycleProgress(): number {
    const angle = this.lastAngle;
    if (!Number.isFinite(angle)) return 0;
    const span = this.thresholds.upEnter - this.thresholds.downEnter;
    if (span <= 0) return 0;
    return clamp((this.thresholds.upEnter - angle) / span, 0, 1);
  }

  private lastAngle = Number.NaN;

  setThresholds(t: RepThresholds): void {
    this.thresholds = t;
  }

  reset(): void {
    this.state = 'READY';
    this.smoother.reset();
    this.median.reset();
    this.frames = [];
    this.repStartTime = null;
    this.repMin = 180;
    this.repMax = 0;
    this.phaseExtreme = 180;
    this.seekingTop = true;
    this.peakSoFar = 0;
    this.count = 0;
    this.reps.length = 0;
    this.lastAngle = Number.NaN;
  }

  /**
   * Feed one raw angle through the same mask -> smooth -> median chain the FSM
   * uses, WITHOUT advancing the rep state machine, and return the filtered
   * value.
   *
   * Calibration must measure the signal the state machine will actually see.
   * Collecting raw angles instead produced thresholds that the smoothed signal
   * never reached, so the FSM stayed in READY forever: the same clean 8-rep set
   * scored 0 reps when calibrated on raw angles and 7 when calibrated on this
   * filtered signal. Smoothing compresses the extremes, so a band derived from
   * the raw range sits outside the range the FSM ever observes.
   *
   * Returns NaN when the sample is unusable, so callers can skip it.
   */
  observe(rawAngle: number): number {
    const raw = maskImplausibleAngle(rawAngle);
    if (!Number.isFinite(raw)) return Number.NaN;
    const smoothed = this.smoother.push(raw);
    return this.median.push(smoothed);
  }

  /**
   * Clear filter state.
   *
   * Called when a set begins so the live signal does not inherit the buffer
   * filled while the user was standing still during calibration. Without this
   * the first several frames of a set are damped toward a stale "standing"
   * value, delaying the first descent.
   */
  resetFilters(): void {
    this.smoother.reset();
    this.median.reset();
  }

  /**
   * Feed one frame. Returns the completed RepEvent on the frame that finishes
   * a rep, otherwise null.
   */
  feed(frame: FrameFeatures): RepEvent | null {
    if (!frame.valid) return null;

    // Reject anatomically impossible angles (collapsed-arm tracking errors)
    // before they can reach the smoother or the state machine.
    const raw = maskImplausibleAngle(frame.elbowAngle);
    if (!Number.isFinite(raw)) return null;

    // Smooth then de-spike. Order matters: median first would delay the
    // signal, smoothing first keeps the rep shape.
    const smoothed = this.smoother.push(raw);
    const angle = this.median.push(smoothed);
    if (!Number.isFinite(angle)) return null;
    this.lastAngle = angle;

    const t = frame.timestamp;
    if (this.repStartTime === null) this.repStartTime = t;

    this.frames.push(frame);
    this.repMin = Math.min(this.repMin, angle);
    this.repMax = Math.max(this.repMax, angle);

    // While no genuine top has been seen, slide the window start with every
    // new high so a mid-descent start does not inflate the first rep's duration.
    if (this.seekingTop && angle > this.peakSoFar) {
      this.peakSoFar = angle;
      this.repStartTime = t;
    }

    const emit = this.transition(angle, t);
    return emit;
  }

  private transition(angle: number, t: number): RepEvent | null {
    const th = this.thresholds;

    switch (this.state) {
      case 'READY':
        // Do NOT require the full upEnter here. A session can begin partway
        // through the movement -- if the user starts in the down position,
        // demanding upEnter first would ignore everything until they happened
        // to fully extend. Measured equivalent in the dataset: one clip starts
        // at 121 deg and only reaches upEnter at frame 249 of 266, discarding
        // every rep when READY was strict.
        if (angle >= th.upExit) this.state = 'UP';
        else if (angle <= th.downExit) {
          this.state = 'DOWN';
          this.phaseExtreme = angle;
        }
        break;

      case 'UP':
        if (angle < th.upExit) {
          this.seekingTop = false; // we had a genuine top; descent starts here
          this.state = 'DESCENDING';
        }
        break;

      case 'DESCENDING':
        if (angle <= th.downEnter) {
          this.state = 'DOWN';
          this.phaseExtreme = angle;
        } else if (angle >= th.upEnter) {
          this.state = 'UP'; // wobbled back, no rep
        }
        break;

      case 'DOWN':
        this.phaseExtreme = Math.min(this.phaseExtreme, angle);
        if (angle >= th.downExit) this.state = 'ASCENDING';
        break;

      case 'ASCENDING':
        if (angle >= th.upEnter) {
          const rep = this.completeRep(t);
          this.state = 'UP';
          return rep;
        }
        if (angle <= th.downEnter) this.state = 'DOWN'; // sank again
        break;
    }
    return null;
  }

  private completeRep(endTime: number): RepEvent | null {
    const startTime = this.repStartTime ?? endTime;
    const duration = endTime - startTime;
    const rom = this.repMax - this.repMin;

    const plausible =
      rom >= this.minRom &&
      duration >= this.minRepSeconds &&
      duration <= this.maxRepSeconds;

    let event: RepEvent | null = null;
    if (plausible) {
      this.count++;
      event = {
        index: this.count,
        startTime,
        endTime,
        durationS: duration,
        minElbowAngle: this.repMin,
        maxElbowAngle: this.repMax,
        frames: this.frames.slice(),
      };
      this.reps.push(event);
    }

    // Reset: the top position is the boundary of the next rep.
    this.repStartTime = endTime;
    this.repMin = 180;
    this.repMax = 0;
    this.phaseExtreme = 180;
    this.seekingTop = false;
    this.peakSoFar = 0;
    this.frames = [];
    return event;
  }
}
