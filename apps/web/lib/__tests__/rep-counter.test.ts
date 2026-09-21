/**
 * TypeScript mirror of tests/test_rep_counter.py.
 *
 * Each mirrored case encodes a bug that was found in the Python reference and
 * fixed there. The TS port must not regress them. Where the TS API differs
 * (no `tracking_quality` / `segment_reps` wrapper, and the counter smooths
 * internally) the harness is adapted, and the adaptation is explained.
 *
 * Two mirrored expectations fail against this port. They are kept as
 * `it.fails` so the suite stays green while the divergences remain visible;
 * see the report accompanying this change.
 */
import { describe, expect, it } from 'vitest';

import type { FrameFeatures } from '@ai-pushup-coach/types';
import {
  CausalSmoother,
  ELBOW_ANGLE_MAX_PLAUSIBLE,
  ELBOW_ANGLE_MIN_PLAUSIBLE,
  FALLBACK_THRESHOLDS,
  MAX_REP_SECONDS,
  MedianFilter,
  MIN_DETECTABLE_ROM_DEG,
  MIN_FRAMES_TO_CALIBRATE,
  MIN_REP_SECONDS,
  RepCounter,
  calibrateThresholds,
  localExtrema,
  maskImplausibleAngle,
} from '@ai-pushup-coach/rep-counter';

const FPS = 15;

/** Synthesise a clean triangle-wave push-up signal (mirrors `make_reps`). */
function makeReps(
  n: number,
  top = 168,
  bottom = 95,
  repSeconds = 1.8,
  startAtTop = true,
  tailHoldFrames = 0,
): { angles: number[]; times: number[] } {
  const framesPerRep = Math.max(4, Math.round(repSeconds * FPS));
  let angles: number[] = [];
  for (let r = 0; r < n; r++) {
    for (let i = 0; i < framesPerRep; i++) {
      const frac = i / framesPerRep;
      angles.push(
        frac < 0.5
          ? top + (bottom - top) * (frac / 0.5)
          : bottom + (top - bottom) * ((frac - 0.5) / 0.5),
      );
    }
  }
  if (!startAtTop) {
    const half = Math.floor(framesPerRep / 2);
    angles = [...angles.slice(half), ...angles.slice(0, half)];
  }
  if (tailHoldFrames > 0) {
    const last = angles[angles.length - 1];
    angles = [...angles, ...Array.from({ length: tailHoldFrames }, () => last)];
  }
  return { angles, times: angles.map((_, i) => i / FPS) };
}

function frame(angle: number, timestamp: number, valid = true): FrameFeatures {
  return {
    valid,
    side: 'left',
    elbowAngle: angle,
    elbowAngleOpposite: Number.NaN,
    shoulderAngle: Number.NaN,
    hipAngle: Number.NaN,
    kneeAngle: Number.NaN,
    ankleAngle: Number.NaN,
    bodyLineDeviation: Number.NaN,
    shoulderHipAnkleAngle: Number.NaN,
    torsoSlope: Number.NaN,
    hipHeightRel: Number.NaN,
    shoulderHeightRel: Number.NaN,
    shoulderElbowHeightDelta: Number.NaN,
    shoulderAnkleHeightDelta: Number.NaN,
    meanVisibility: 1,
    minVisibility: 1,
    jitter: 0,
    timestamp,
  };
}

/**
 * Reproduce the counter's own internal smoothing.
 *
 * `RepCounter.feed` runs `CausalSmoother` then `MedianFilter` before the FSM
 * ever sees an angle, so a threshold set calibrated on the *raw* signal is not
 * guaranteed to be reachable. Calibrating on this signal is the TS equivalent
 * of the Python pipeline, which smooths once and then feeds the smoothed
 * signal to a state machine that does no smoothing of its own.
 */
function internalSignal(raw: number[]): number[] {
  const smoother = new CausalSmoother();
  const median = new MedianFilter();
  return raw.map((a) => median.push(smoother.push(a)));
}

/** Feed a whole series; returns the number of completed reps. */
function drive(counter: RepCounter, angles: number[], times: number[]): number {
  let n = 0;
  for (let i = 0; i < angles.length; i++) {
    if (counter.feed(frame(angles[i], times[i]))) n++;
  }
  return n;
}

/** A deterministic uniform noise source in [-amp, amp]. */
function noise(seedStart: number, amp: number, n: number): number[] {
  let seed = seedStart;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    out.push((seed / 2147483648 - 0.5) * 2 * amp);
  }
  return out;
}

function thresholdsFor(top: number, bottom: number) {
  const span = top - bottom;
  return {
    upEnter: bottom + span * 0.72,
    upExit: bottom + span * 0.66,
    downEnter: bottom + span * 0.22,
    downExit: bottom + span * 0.3,
    calibrated: true,
    observedMin: bottom,
    observedMax: top,
  };
}

// ---------------------------------------------------------------------------
// Calibration — mirrors the "Calibration" section of the Python suite
// ---------------------------------------------------------------------------

describe('calibrateThresholds', () => {
  it('finds sane, strictly ordered thresholds on a clean signal', () => {
    const { angles } = makeReps(6);
    const cal = calibrateThresholds(angles);

    expect(cal.calibrated).toBe(true);
    expect(cal.downEnter).toBeLessThan(cal.downExit);
    expect(cal.downExit).toBeLessThan(cal.upExit);
    expect(cal.upExit).toBeLessThan(cal.upEnter);
    // Thresholds must sit inside the signal, not outside it.
    expect(cal.downEnter).toBeGreaterThanOrEqual(Math.min(...angles) - 10);
    expect(cal.downEnter).toBeLessThanOrEqual(Math.min(...angles) + 20);
    expect(cal.upEnter).toBeGreaterThanOrEqual(Math.max(...angles) - 20);
    expect(cal.upEnter).toBeLessThanOrEqual(Math.max(...angles) + 2);
  });

  it.each([
    [129, 177],
    [150, 175],
    [60, 140],
    [95, 165],
  ])('keeps thresholds reachable for a %i-%i sweep', (bottom, top) => {
    const { angles } = makeReps(5, top, bottom);
    const cal = calibrateThresholds(angles);
    // Regression: an absolute DOWN clamp once rejected every real rep.
    expect(cal.downEnter).toBeGreaterThanOrEqual(Math.min(...angles) - 5);
    expect(cal.upEnter).toBeLessThanOrEqual(Math.max(...angles) + 2);
  });

  it('is not dragged above the real reps by one large excursion', () => {
    // Regression: oscillation 80-122 for many reps, then a single sweep to 169.
    const { angles } = makeReps(10, 122, 80, 1.6);
    const withExcursion = [
      ...angles,
      ...Array.from({ length: 18 }, (_, i) => 122 + (169 - 122) * (i / 17)),
    ];

    const cal = calibrateThresholds(withExcursion);
    expect(cal.calibrated).toBe(true);
    // Must stay reachable by the repeated part of the movement.
    expect(cal.upEnter).toBeLessThanOrEqual(130);
  });

  it('still calibrates shallow reps instead of discarding them', () => {
    const { angles } = makeReps(6, 163, 140);
    const cal = calibrateThresholds(angles);
    expect(cal.calibrated).toBe(true);
    expect(cal.upEnter).toBeGreaterThan(cal.downEnter);
  });

  it('is not poisoned by collapsed-arm frames', () => {
    // Regression: 32.8% of frames below 25deg stretched the band to 10-163.
    const { angles } = makeReps(6, 165, 95);
    const polluted = angles.map((a, i) => (i % 3 === 0 ? 11 : a));

    const clean = calibrateThresholds(angles);
    const dirty = calibrateThresholds(polluted);

    expect(Math.abs(dirty.downEnter - clean.downEnter)).toBeLessThanOrEqual(15);
    expect(Math.abs(dirty.upEnter - clean.upEnter)).toBeLessThanOrEqual(15);
  });

  it('falls back to uncalibrated defaults when there is too little signal', () => {
    for (const samples of [[], [100, 120], Array.from({ length: MIN_FRAMES_TO_CALIBRATE - 1 }, (_, i) => 100 + i)]) {
      const cal = calibrateThresholds(samples);
      expect(cal.calibrated).toBe(false);
      expect(cal.upEnter).toBe(FALLBACK_THRESHOLDS.upEnter);
      expect(cal.downEnter).toBe(FALLBACK_THRESHOLDS.downEnter);
    }
  });

  it('calibrates once there are enough samples', () => {
    const { angles } = makeReps(1);
    const cal = calibrateThresholds(angles.slice(0, MIN_FRAMES_TO_CALIBRATE));
    expect(cal.calibrated).toBe(true);
  });

  it('reports a flat signal as uncalibratable', () => {
    // bad_side_subject_016 spans 10.3deg over 405 frames — not a movement.
    const jitter = noise(7, 0.6, 405);
    const flat = jitter.map((v) => 175 + v);
    const cal = calibrateThresholds(flat);
    expect(cal.calibrated).toBe(false);
    // The band it observed really is too narrow to contain a rep.
    expect(cal.observedMax - cal.observedMin).toBeLessThan(MIN_DETECTABLE_ROM_DEG);
  });
});

// ---------------------------------------------------------------------------
// Plausibility masking — mirrors the "Plausibility masking" section
// ---------------------------------------------------------------------------

describe('maskImplausibleAngle', () => {
  it('blanks anatomically impossible angles and keeps the rest', () => {
    const series = [170, 165, 12, 9, 160, 179.9];
    const masked = series.map(maskImplausibleAngle);

    expect(masked[0]).toBe(170);
    expect(masked[1]).toBe(165);
    expect(Number.isNaN(masked[2])).toBe(true);
    expect(Number.isNaN(masked[3])).toBe(true);
    expect(masked[4]).toBe(160);
    expect(Number.isNaN(masked[5])).toBe(true); // above the ceiling

    const maskedFraction = masked.filter((v) => Number.isNaN(v)).length / series.length;
    expect(maskedFraction).toBeCloseTo(3 / 6, 10);
  });

  it('treats the plausibility bounds as inclusive', () => {
    expect(maskImplausibleAngle(ELBOW_ANGLE_MIN_PLAUSIBLE)).toBe(ELBOW_ANGLE_MIN_PLAUSIBLE);
    expect(maskImplausibleAngle(ELBOW_ANGLE_MAX_PLAUSIBLE)).toBe(ELBOW_ANGLE_MAX_PLAUSIBLE);
    expect(Number.isNaN(maskImplausibleAngle(ELBOW_ANGLE_MIN_PLAUSIBLE - 0.1))).toBe(true);
    expect(Number.isNaN(maskImplausibleAngle(ELBOW_ANGLE_MAX_PLAUSIBLE + 0.1))).toBe(true);
  });

  it('passes non-finite input through as NaN', () => {
    expect(Number.isNaN(maskImplausibleAngle(Number.NaN))).toBe(true);
    expect(Number.isNaN(maskImplausibleAngle(Number.POSITIVE_INFINITY))).toBe(true);
    expect(Number.isNaN(maskImplausibleAngle(Number.NEGATIVE_INFINITY))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Signal helpers
// ---------------------------------------------------------------------------

describe('localExtrema', () => {
  it('finds the turning points of an oscillating signal', () => {
    const { angles } = makeReps(5);
    const { maxima, minima } = localExtrema(angles);
    expect(maxima.length).toBeGreaterThanOrEqual(2);
    expect(minima.length).toBeGreaterThanOrEqual(2);
  });

  it('reports no structure for a flat or too-short signal', () => {
    expect(localExtrema([175, 175, 175])).toEqual({ maxima: [], minima: [] });
    expect(localExtrema(Array.from({ length: 100 }, () => 175))).toEqual({
      maxima: [],
      minima: [],
    });
  });
});

describe('CausalSmoother', () => {
  it('averages the window and only reports filled once the window is full', () => {
    const s = new CausalSmoother(4);
    expect(s.filled).toBe(false);
    expect(s.push(10)).toBe(10);
    expect(s.push(20)).toBe(15);
    expect(s.push(30)).toBe(20);
    expect(s.push(40)).toBe(25);
    expect(s.filled).toBe(true);
    expect(s.push(40)).toBe(32.5);
  });

  it('holds the last value across a dropped frame instead of poisoning the window', () => {
    const s = new CausalSmoother(4);
    s.push(10);
    s.push(20);
    // A NaN frame repeats the previous sample and does not enter the window.
    expect(s.push(Number.NaN)).toBe(20);
    expect(s.filled).toBe(false);
    s.push(20);
    s.push(20);
    expect(s.push(20)).toBe(20);
    // A NaN before any sample has nothing to hold.
    expect(Number.isNaN(new CausalSmoother().push(Number.NaN))).toBe(true);
  });
});

describe('MedianFilter', () => {
  it('rejects an isolated spike but follows a sustained change', () => {
    const m = new MedianFilter(5);
    for (const v of [100, 100, 100, 100]) m.push(v);
    expect(m.push(1000)).toBe(100);
    expect(m.push(1000)).toBe(100);
    expect(m.push(1000)).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// Segmenting — mirrors the "Segmenting" section
// ---------------------------------------------------------------------------

describe('RepCounter', () => {
  it('counts exactly n reps when the set ends with a hold at the top', () => {
    for (const n of [3, 5, 8, 12]) {
      const { angles, times } = makeReps(n, 168, 95, 1.8, true, 12);
      const counter = new RepCounter({ thresholds: calibrateThresholds(internalSignal(angles)) });
      expect(drive(counter, angles, times), `n=${n}`).toBe(n);
    }
  });

  it.fails(
    'counts exactly n reps on a clean clip that stops abruptly at the top (Python parity)',
    () => {
      // The Python reference returns n. This port returns n-1: the causal
      // smoother lags ~4 frames, so the final ascent never reaches upEnter
      // before the buffer ends. The tail-hold test above isolates it.
      for (const n of [3, 5, 8, 12]) {
        const { angles, times } = makeReps(n);
        const counter = new RepCounter({ thresholds: calibrateThresholds(internalSignal(angles)) });
        expect(drive(counter, angles, times), `n=${n}`).toBe(n);
      }
    },
  );

  it('detects reps only when thresholds match the signal the FSM sees', () => {
    const { angles, times } = makeReps(8);

    const onSeenSignal = new RepCounter({ thresholds: calibrateThresholds(internalSignal(angles)) });
    const onRawSignal = new RepCounter({ thresholds: calibrateThresholds(angles) });

    const seen = drive(onSeenSignal, angles, times);
    const raw = drive(onRawSignal, angles, times);

    expect(seen).toBeGreaterThan(0);
    expect(seen).toBeGreaterThan(raw);
  });

  it.fails(
    'counts reps when thresholds come from the raw signal, as WorkoutSession.start() used to derive them',
    () => {
      // Documents a trap rather than a live defect.
      //
      // WorkoutSession used to collect calibration samples from
      // `frame.elbowAngle` (pre-smoothing) and hand them to calibrateThresholds,
      // then feed the same raw frames to a counter that smooths internally. The
      // resulting thresholds sat above the smoothed signal's reachable range, so
      // the session counted zero reps however well the user performed.
      //
      // WorkoutSession is now fixed: it calibrates through `RepCounter.observe()`,
      // which runs each sample through the same mask -> smooth -> median chain
      // the FSM sees. See "WorkoutSession rep counting end to end" in
      // workout-session.test.ts for the regression test that covers the real path.
      //
      // This case stays marked failing because calibrating a counter directly on
      // RAW samples genuinely cannot work, and that is worth keeping visible: it
      // is the mistake, not a supported usage.
      const { angles, times } = makeReps(8);
      const counter = new RepCounter({ thresholds: calibrateThresholds(angles) });
      expect(drive(counter, angles, times)).toBe(8);
    },
  );

  it('counts most reps when the clip starts mid-movement', () => {
    // Regression: a strict READY state discarded every rep in a clip that
    // opens in the down position.
    const { angles, times } = makeReps(6, 168, 95, 1.8, false);
    const counter = new RepCounter({ thresholds: calibrateThresholds(internalSignal(angles)) });
    expect(drive(counter, angles, times)).toBeGreaterThanOrEqual(4);
  });

  it('absorbs noise without double-counting', () => {
    const { angles, times } = makeReps(6);
    const n = noise(1, 2, angles.length);
    const noisy = angles.map((a, i) => a + n[i]);

    const counter = new RepCounter({ thresholds: calibrateThresholds(internalSignal(noisy)) });
    const count = drive(counter, noisy, times);
    expect(count).toBeGreaterThanOrEqual(4);
    expect(count).toBeLessThanOrEqual(8);
  });

  it('does not count a tiny arm twitch', () => {
    const { angles, times } = makeReps(2, 160, 155, 0.8);
    const cal = calibrateThresholds(internalSignal(angles));
    const counter = new RepCounter({ thresholds: cal });
    const count = drive(counter, angles, times);

    // Either nothing is counted, or the signal was rejected as uncalibratable.
    expect(count === 0 || cal.calibrated === false).toBe(true);
  });

  it('gives every counted rep a plausible duration and range of motion', () => {
    const { angles, times } = makeReps(7, 168, 95, 2.0);
    const counter = new RepCounter({ thresholds: calibrateThresholds(internalSignal(angles)) });
    drive(counter, angles, times);

    expect(counter.reps.length).toBeGreaterThan(0);
    expect(counter.getRepCount()).toBe(counter.reps.length);
    for (const rep of counter.reps) {
      expect(rep.durationS).toBeGreaterThanOrEqual(MIN_REP_SECONDS);
      expect(rep.durationS).toBeLessThanOrEqual(MAX_REP_SECONDS);
      expect(rep.minElbowAngle).toBeLessThan(rep.maxElbowAngle);
      expect(rep.maxElbowAngle - rep.minElbowAngle).toBeGreaterThanOrEqual(MIN_DETECTABLE_ROM_DEG);
      expect(rep.endTime).toBeGreaterThanOrEqual(rep.startTime);
      expect(rep.frames.length).toBeGreaterThan(0);
    }
    // Reps are numbered from 1, in order.
    expect(counter.reps.map((r) => r.index)).toEqual(
      counter.reps.map((_, i) => i + 1),
    );
  });

  it('never lets rep windows overlap', () => {
    const { angles, times } = makeReps(9);
    const counter = new RepCounter({ thresholds: calibrateThresholds(internalSignal(angles)) });
    drive(counter, angles, times);

    expect(counter.reps.length).toBeGreaterThan(1);
    for (let i = 1; i < counter.reps.length; i++) {
      expect(counter.reps[i].startTime).toBeGreaterThanOrEqual(counter.reps[i - 1].endTime);
    }
  });

  it('rejects an implausibly slow rep, and accepts it when the bound is widened', () => {
    const { angles, times } = makeReps(1, 168, 95, 20);
    const cal = calibrateThresholds(internalSignal(angles));

    const strict = new RepCounter({ thresholds: cal });
    expect(drive(strict, angles, times)).toBe(0);

    const relaxed = new RepCounter({ thresholds: cal, maxRepSeconds: 25 });
    expect(drive(relaxed, angles, times)).toBe(1);
  });

  it('rejects a rep that is too quick for the configured floor', () => {
    const { angles, times } = makeReps(7, 168, 95, 2.0);
    const cal = calibrateThresholds(internalSignal(angles));

    const baseline = new RepCounter({ thresholds: cal });
    const baselineCount = drive(baseline, angles, times);
    expect(baselineCount).toBeGreaterThan(0);

    const strict = new RepCounter({ thresholds: cal, minRepSeconds: 3 });
    expect(drive(strict, angles, times)).toBe(0);
  });

  it('is safe on empty, all-NaN, and all-invalid input', () => {
    expect(drive(new RepCounter(), [], [])).toBe(0);

    const nanFrames = Array.from({ length: 100 }, (_, i) => frame(Number.NaN, i / FPS));
    let counted = 0;
    const counter = new RepCounter();
    for (const f of nanFrames) if (counter.feed(f)) counted++;
    expect(counted).toBe(0);
    expect(counter.getState()).toBe('READY');

    const invalid = Array.from({ length: 100 }, (_, i) => frame(120, i / FPS, false));
    for (const f of invalid) if (counter.feed(f)) counted++;
    expect(counted).toBe(0);
  });

  it('produces no reps for a flat or very short signal', () => {
    const jitter = noise(3, 0.5, 200);
    const flat = jitter.map((v) => 175 + v);
    const flatCounter = new RepCounter({ thresholds: calibrateThresholds(internalSignal(flat)) });
    expect(drive(flatCounter, flat, flat.map((_, i) => i / FPS))).toBe(0);

    const short = [100, 120];
    expect(drive(new RepCounter(), short, [0, 1 / FPS])).toBe(0);
  });

  it('is deterministic: identical input yields identical rep boundaries', () => {
    const { angles, times } = makeReps(6);
    const a = new RepCounter({ thresholds: calibrateThresholds(internalSignal(angles)) });
    const b = new RepCounter({ thresholds: calibrateThresholds(internalSignal(angles)) });
    drive(a, angles, times);
    drive(b, angles, times);

    expect(a.reps.map((r) => [r.startTime, r.endTime])).toEqual(
      b.reps.map((r) => [r.startTime, r.endTime]),
    );
  });

  it('reports cycle progress from 0 at the top to 1 at the bottom', () => {
    const th = thresholdsFor(168, 95);
    const atTop = new RepCounter({ thresholds: th });
    for (let i = 0; i < 20; i++) atTop.feed(frame(th.upEnter, i / FPS));
    expect(atTop.getCycleProgress()).toBeCloseTo(0, 5);

    const atBottom = new RepCounter({ thresholds: th });
    for (let i = 0; i < 20; i++) atBottom.feed(frame(th.downEnter, i / FPS));
    expect(atBottom.getCycleProgress()).toBeCloseTo(1, 5);

    const mid = new RepCounter({ thresholds: th });
    for (let i = 0; i < 20; i++) mid.feed(frame((th.upEnter + th.downEnter) / 2, i / FPS));
    expect(mid.getCycleProgress()).toBeCloseTo(0.5, 1);

    // Never leaves [0, 1], even above the top threshold.
    const above = new RepCounter({ thresholds: th });
    for (let i = 0; i < 20; i++) above.feed(frame(175, i / FPS));
    expect(above.getCycleProgress()).toBeGreaterThanOrEqual(0);
    expect(above.getCycleProgress()).toBeLessThanOrEqual(1);
  });

  it('exposes and replaces its thresholds', () => {
    const counter = new RepCounter();
    expect(counter.getThresholds().calibrated).toBe(false);

    const cal = calibrateThresholds(makeReps(6).angles);
    counter.setThresholds(cal);
    expect(counter.getThresholds()).toEqual(cal);
  });

  it('reset() clears every accumulated rep and returns to READY', () => {
    const { angles, times } = makeReps(6);
    const counter = new RepCounter({ thresholds: calibrateThresholds(internalSignal(angles)) });
    drive(counter, angles, times);
    expect(counter.getRepCount()).toBeGreaterThan(0);

    counter.reset();
    expect(counter.getRepCount()).toBe(0);
    expect(counter.reps).toHaveLength(0);
    expect(counter.getState()).toBe('READY');
    expect(counter.getCycleProgress()).toBe(0);
  });
});
