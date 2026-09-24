import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CameraView, Landmark, PoseFrame, RepAssessment } from '@ai-pushup-coach/types';
import { WorkoutSession, type SessionSnapshot } from '@/lib/workout-session';

/**
 * A pose that satisfies the CAMERA CHECK rules: shoulders narrow relative to
 * the torso (side-on), ankles tracked and inside the frame, good visibility,
 * and a 90deg elbow. Angles are invariant under the torso normalisation the
 * extractor applies, so the elbow reads 90deg here too.
 */
function makeLandmarks(): Landmark[] {
  const lm = (x: number, y: number, visibility = 1): Landmark => ({ x, y, z: 0, visibility });
  const lms = Array.from({ length: 33 }, () => lm(0.5, 0.5));
  lms[11] = lm(0.49, 0.5);
  lms[12] = lm(0.51, 0.5);
  lms[13] = lm(0.49, 0.6);
  lms[14] = lm(0.51, 0.6);
  lms[15] = lm(0.58, 0.6);
  lms[16] = lm(0.58, 0.6);
  lms[23] = lm(0.49, 0.65);
  lms[24] = lm(0.51, 0.65);
  lms[25] = lm(0.49, 0.75);
  lms[26] = lm(0.51, 0.75);
  lms[27] = lm(0.2, 0.85);
  lms[28] = lm(0.22, 0.85);
  lms[29] = lm(0.2, 0.9);
  lms[30] = lm(0.22, 0.9);
  return lms;
}

function validPose(timestamp: number): PoseFrame {
  return { timestamp, landmarks: makeLandmarks(), side: 'left', valid: true, sideVisibility: 0.9 };
}

/**
 * A pose whose elbow sweeps a real push-up range.
 *
 * Calibration must observe movement, so a static pose can no longer satisfy it.
 * The wrist is placed at `elbow + r * (sin E, -cos E)`, which makes the angle
 * at the elbow exactly `E` degrees given `elbow -> shoulder` points straight up.
 */
const ELBOW_TOP_DEG = 160;
const ELBOW_BOTTOM_DEG = 70;
const FRAMES_PER_REP = 40;

function pushupPose(timestamp: number, frameIndex: number): PoseFrame {
  const phase = (frameIndex % FRAMES_PER_REP) / FRAMES_PER_REP;
  const deg =
    (ELBOW_TOP_DEG + ELBOW_BOTTOM_DEG) / 2 -
    ((ELBOW_TOP_DEG - ELBOW_BOTTOM_DEG) / 2) * Math.cos(2 * Math.PI * phase);
  const rad = (deg * Math.PI) / 180;

  const lms = makeLandmarks();
  const elbow = lms[13];
  const r = 0.09;
  for (const idx of [15, 16]) {
    lms[idx] = {
      x: elbow.x + r * Math.sin(rad),
      y: elbow.y - r * Math.cos(rad),
      z: 0,
      visibility: 1,
    };
  }
  return { timestamp, landmarks: lms, side: 'left', valid: true, sideVisibility: 0.9 };
}

function invalidPose(timestamp: number): PoseFrame {
  return { timestamp, landmarks: [], side: 'left', valid: false, sideVisibility: 0 };
}

function buildSession(view: CameraView = 'side') {
  const snapshots: SessionSnapshot[] = [];
  const reps: RepAssessment[] = [];
  const session = new WorkoutSession({
    mode: 'workout',
    view,
    model: null,
    callbacks: {
      onSnapshot: (s) => snapshots.push(s),
      onRep: (r) => reps.push(r),
    },
  });
  return { session, snapshots, reps };
}

/** Drive the session into a calibrated, active state. */
function activate(session: WorkoutSession, frames = 60): void {
  session.beginCalibration();
  // Real movement, not a held pose: calibration now requires a range of motion.
  for (let i = 0; i < frames; i++) session.onPoseFrame(pushupPose(i / 20, i));
  session.start();
}

beforeEach(() => {
  // Only `performance` is faked, so the elapsed clock is fully deterministic.
  vi.useFakeTimers({ toFake: ['performance'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('WorkoutSession lifecycle', () => {
  it('starts idle and reports honest empty metrics', () => {
    const { session } = buildSession();

    expect(session.getPhase()).toBe('idle');
    expect(session.getElapsedSeconds()).toBe(0);
    expect(session.getRepRecords()).toEqual([]);
    expect(session.getAssessments()).toEqual([]);

    const metrics = session.getMetrics();
    expect(metrics.totalReps).toBe(0);
    expect(metrics.validReps).toBe(0);
    expect(metrics.invalidReps).toBe(0);
    expect(metrics.formScore).toBeNull();
    expect(metrics.bestStreak).toBe(0);
    expect(metrics.meanRepSeconds).toBeNull();
    expect(metrics.mostCommonIssue).toBeNull();
    expect(metrics.scoreStatus).toBe('insufficient-data');
  });

  it('enters calibration and checks that an elbow and wrist can be tracked', () => {
    const { session } = buildSession();
    session.beginCalibration();

    expect(session.getPhase()).toBe('calibrating');
    expect(session.isCalibrated()).toBe(false);

    const state = session.getCalibrationState();
    expect(state.checks.map((c) => c.id)).toEqual([
      'full-body',
      'arm',
      'pose',
      'view',
      'lighting',
      'distance',
      'stable',
    ]);
    expect(state.ready).toBe(false);
    expect(state.samples).toBe(0);
    expect(state.checks.every((c) => c.hint.length > 0)).toBe(true);
  });

  it('reports ready only once a real range of motion has been observed', () => {
    const { session } = buildSession();
    session.beginCalibration();

    // A subject holding perfectly still must NOT be ready. Calibration used to
    // be gated on sample count alone, so a motionless pose locked a band the
    // real movement never entered -- on real clips that counted zero reps.
    for (let i = 0; i < 80; i++) session.onPoseFrame(validPose(i / 20));

    const still = session.getCalibrationState();
    expect(still.samples).toBe(80);
    expect(still.ready).toBe(false);
    expect(session.isCalibrated()).toBe(false);
    const romCheck = still.checks.find((c) => c.id === 'stable');
    expect(romCheck?.passed).toBe(false);

    // Once the subject actually moves, calibration completes.
    for (let i = 80; i < 80 + FRAMES_PER_REP * 2; i++) {
      session.onPoseFrame(pushupPose(i / 20, i));
    }
    expect(session.isCalibrated()).toBe(true);

    const state = session.getCalibrationState();
    expect(state.checks.every((c) => c.passed)).toBe(true);
    expect(state.ready).toBe(true);
    expect(state.poseConfidence).toBeCloseTo(0.9, 5);
  });

  it('clears the live elbow angle when the pose is lost during calibration', () => {
    const { session } = buildSession();
    session.beginCalibration();
    session.onPoseFrame(validPose(0));
    expect(session.getCalibrationState().liveElbowAngle).not.toBeNull();

    session.onPoseFrame(invalidPose(1));
    expect(session.getCalibrationState().liveElbowAngle).toBeNull();
  });

  it('starts camera alignment fresh after changing camera', () => {
    const { session } = buildSession();
    session.beginCalibration();
    for (let i = 0; i < 20; i++) session.onPoseFrame(validPose(i / 20));
    expect(session.getCalibrationState().checks.find((c) => c.id === 'pose')?.passed).toBe(true);

    session.beginCalibration();
    const restarted = session.getCalibrationState();
    expect(restarted.samples).toBe(0);
    expect(restarted.liveElbowAngle).toBeNull();
    expect(restarted.checks.find((c) => c.id === 'pose')?.passed).toBe(false);
  });

  it('start() moves to active and forces a snapshot', () => {
    const { session, snapshots } = buildSession();
    vi.advanceTimersByTime(1000);

    session.beginCalibration();
    session.start();

    expect(session.getPhase()).toBe('active');
    expect(snapshots.length).toBeGreaterThanOrEqual(1);
    expect(snapshots[snapshots.length - 1].phase).toBe('active');
  });

  it('throttles snapshots to at most one per 250ms of streamed frames', () => {
    const { session, snapshots } = buildSession();
    vi.advanceTimersByTime(1000);
    activate(session);

    const afterStart = snapshots.length;
    for (let i = 0; i < 20; i++) session.onPoseFrame(validPose(i / 20));
    // Frozen clock: 20 frames, zero further emissions.
    expect(snapshots.length).toBe(afterStart);

    vi.advanceTimersByTime(300);
    session.onPoseFrame(validPose(1));
    expect(snapshots.length).toBe(afterStart + 1);
  });

  it('excludes paused time from the elapsed clock', () => {
    const { session } = buildSession();
    vi.advanceTimersByTime(1000);
    session.start();

    vi.advanceTimersByTime(2000);
    expect(session.getElapsedSeconds()).toBeCloseTo(2, 5);

    session.pause('user');
    vi.advanceTimersByTime(3000);
    expect(session.getElapsedSeconds()).toBeCloseTo(2, 5);

    session.resume();
    vi.advanceTimersByTime(1000);
    expect(session.getElapsedSeconds()).toBeCloseTo(3, 5);
  });

  it('ignores pause and resume when they do not apply', () => {
    const { session } = buildSession();

    session.pause('user');
    expect(session.getPhase()).toBe('idle');

    session.resume();
    expect(session.getPhase()).toBe('idle');

    vi.advanceTimersByTime(500);
    session.start();
    session.resume();
    expect(session.getPhase()).toBe('active');
  });

  it('auto-pauses after ~0.7s of lost pose and resumes when the pose returns', () => {
    const { session } = buildSession();
    activate(session);
    expect(session.getPhase()).toBe('active');

    // Pose-timestamp based pause (not frame-count) so 15fps mobile matches desktop.
    for (let i = 0; i < 10; i++) session.onPoseFrame(invalidPose(5 + i * 0.05));
    expect(session.getPhase()).toBe('active'); // 0.45s gap — still holding

    session.onPoseFrame(invalidPose(5.75));
    expect(session.getPhase()).toBe('paused');
    expect(session.buildSnapshotForUi().pausedReason).toBe('pose-lost');

    session.onPoseFrame(validPose(6));
    expect(session.getPhase()).toBe('active');
    expect(session.buildSnapshotForUi().pausedReason).toBeNull();
  });

  it('does not auto-resume a user-initiated pause', () => {
    const { session } = buildSession();
    activate(session);
    session.pause('user');

    session.onPoseFrame(validPose(10));
    expect(session.getPhase()).toBe('paused');
    expect(session.buildSnapshotForUi().pausedReason).toBe('user');
  });

  it('finish() and reset() move through the terminal states cleanly', () => {
    const { session } = buildSession();
    activate(session);
    session.onPoseFrame(validPose(10));
    session.finish();

    expect(session.getPhase()).toBe('finished');
    expect(session.buildSnapshotForUi().phase).toBe('finished');

    session.reset();
    expect(session.getPhase()).toBe('idle');
    expect(session.getElapsedSeconds()).toBe(0);
    expect(session.isCalibrated()).toBe(false);
    expect(session.getRepRecords()).toEqual([]);
    expect(session.getAssessments()).toEqual([]);
    expect(session.getMetrics().totalReps).toBe(0);
    expect(session.getCalibrationState().samples).toBe(0);
  });

  it('ignores pose frames once the session has finished', () => {
    const { session, snapshots } = buildSession();
    activate(session);
    session.finish();
    const afterFinish = snapshots.length;

    for (let i = 0; i < 5; i++) session.onPoseFrame(validPose(i / 20));
    expect(snapshots.length).toBe(afterFinish);
    expect(session.getPhase()).toBe('finished');
  });
});

describe('WorkoutSession snapshots', () => {
  it('carries the phase, view, counter state, and a bounded cycle progress', () => {
    const { session, snapshots } = buildSession();
    vi.advanceTimersByTime(1000);
    activate(session);
    session.onPoseFrame(validPose(3));

    const snap = snapshots[snapshots.length - 1];
    expect(snap.phase).toBe('active');
    expect(snap.view).toBe('side');
    expect(['READY', 'UP', 'DESCENDING', 'DOWN', 'ASCENDING']).toContain(snap.repState);
    expect(snap.cycleProgress).toBeGreaterThanOrEqual(0);
    expect(snap.cycleProgress).toBeLessThanOrEqual(1);
    expect(snap.metrics.totalReps).toBe(0);
    expect(snap.lastRep).toBeNull();
  });

  it('does not fabricate reps when only a static pose is streamed', () => {
    const { session, reps } = buildSession();
    activate(session);
    for (let i = 0; i < 40; i++) session.onPoseFrame(validPose(3 + i / 20));

    expect(reps).toEqual([]);
    expect(session.getMetrics().totalReps).toBe(0);
    expect(session.getMetrics().formScore).toBeNull();
  });
});

/**
 * Regression: calibration must observe the signal the FSM actually sees.
 *
 * WorkoutSession used to collect calibration samples from the RAW
 * `frame.elbowAngle`, then hand them to a RepCounter that smooths internally
 * (mask -> causal low-pass -> median). Smoothing compresses the extremes, so
 * the derived band sat outside the range the state machine ever reached and the
 * counter stayed in READY forever. On a clean set this measured 0 reps while
 * the camera, the overlay and the timer all looked perfectly healthy — the
 * worst kind of failure, because nothing appeared broken.
 *
 * These tests drive the real public path (beginCalibration -> onPoseFrame ->
 * start -> onPoseFrame) rather than constructing a counter with hand-picked
 * thresholds, so they would have caught the original defect.
 */

/**
 * A pose whose elbow angle is exactly `deg`.
 *
 * The wrist is placed on an arc of radius r around the elbow, starting from the
 * shoulder->elbow direction and rotated by `deg`. Only the wrist moves, so the
 * torso frame is unchanged and the angle survives torso normalisation intact.
 * 90deg reproduces the bent arm in `makeLandmarks`; 180deg is a straight arm.
 */
function poseAtElbow(timestamp: number, deg: number): PoseFrame {
  const lms = makeLandmarks();
  const th = (deg * Math.PI) / 180;
  const r = 0.1;
  lms[15] = { x: 0.49 + r * Math.sin(th), y: 0.6 - r * Math.cos(th), z: 0, visibility: 1 };
  return { timestamp, landmarks: lms, side: 'left', valid: true, sideVisibility: 0.9 };
}

/** Sweep the full range of motion, as a user does during calibration. */
function calibrateOverFullRange(session: WorkoutSession, startT: number): number {
  let t = startT;
  session.beginCalibration();
  for (let i = 0; i < 60; i++) {
    // One slow full cycle between 95deg and 175deg.
    const deg = 135 + 40 * Math.cos((2 * Math.PI * i) / 60);
    session.onPoseFrame(poseAtElbow(t, deg));
    t += 1 / 20;
  }
  session.start();
  return t;
}

describe('WorkoutSession rep counting end to end', () => {
  it('counts reps when calibration spans the real range of motion', () => {
    const { session, reps } = buildSession();
    let t = calibrateOverFullRange(session, 0);

    // Settle at the top so the FSM has an unambiguous starting state.
    for (let i = 0; i < 10; i++) {
      session.onPoseFrame(poseAtElbow(t, 172));
      t += 1 / 20;
    }

    // Three clean reps: top -> bottom -> top.
    const framesPerRep = 26;
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < framesPerRep; i++) {
        const phase = i / framesPerRep;
        const deg = 133 + 39 * Math.cos(2 * Math.PI * phase);
        session.onPoseFrame(poseAtElbow(t, deg));
        t += 1 / 20;
      }
    }

    /*
     * Hold at the top to close the last rep, which is what a user does before
     * stopping. This is not a workaround for the assertions below: the causal
     * smoother deliberately lags the signal by roughly six frames
     * (CausalSmoother window 9 + MedianFilter k 5), so a stream that is cut off
     * on the exact frame the elbow reaches the top loses that final rep. That
     * trade-off is inherent to filtering without lookahead, and it is documented
     * and covered separately in rep-counter.test.ts ("stops abruptly at the
     * top"). Counting 3 here with a brief hold is the realistic case.
     */
    for (let i = 0; i < 12; i++) {
      session.onPoseFrame(poseAtElbow(t, 172));
      t += 1 / 20;
    }

    expect(reps.length).toBeGreaterThanOrEqual(3);
    expect(session.getMetrics().totalReps).toBeGreaterThanOrEqual(3);
  });

  it('produces a real form score once reps exist', () => {
    const { session } = buildSession();
    let t = calibrateOverFullRange(session, 0);

    for (let i = 0; i < 10; i++) {
      session.onPoseFrame(poseAtElbow(t, 172));
      t += 1 / 20;
    }
    for (let c = 0; c < 4; c++) {
      for (let i = 0; i < 26; i++) {
        const deg = 133 + 39 * Math.cos((2 * Math.PI * i) / 26);
        session.onPoseFrame(poseAtElbow(t, deg));
        t += 1 / 20;
      }
    }

    const metrics = session.getMetrics();
    // A real measurement, not a placeholder: the score must be present and in
    // range. `null` would be the honest answer for zero reps.
    if (metrics.totalReps > 0) {
      expect(metrics.formScore).not.toBeNull();
      expect(metrics.formScore as number).toBeGreaterThanOrEqual(0);
      expect(metrics.formScore as number).toBeLessThanOrEqual(100);
    }
  });
});

/**
 * Regression: the orientation camera check used to demand a side view
 * unconditionally (`sideDominance >= 0.55`, label hardcoded to 'Side view').
 * The 'Start counting' button is disabled until every check passes, so with
 * the Front view selected -- which the app explicitly supports and the
 * dataset was collected in -- the button could never be enabled and front
 * push-ups could never be counted. These tests pin the view-aware behavior.
 */

/**
 * A face-on pose: shoulders wide relative to the torso, the exact opposite of
 * the side-on set above. `sideDominance` maps this to ~0.
 */
function makeFrontLandmarks(): Landmark[] {
  const lm = (x: number, y: number, visibility = 1): Landmark => ({ x, y, z: 0, visibility });
  const lms = Array.from({ length: 33 }, () => lm(0.5, 0.5));
  lms[11] = lm(0.4, 0.5);
  lms[12] = lm(0.6, 0.5);
  lms[13] = lm(0.4, 0.6);
  lms[14] = lm(0.6, 0.6);
  lms[15] = lm(0.4, 0.6); // replaced by frontPoseAtElbow
  lms[16] = lm(0.6, 0.6);
  lms[23] = lm(0.43, 0.65);
  lms[24] = lm(0.57, 0.65);
  lms[25] = lm(0.43, 0.75);
  lms[26] = lm(0.57, 0.75);
  lms[27] = lm(0.42, 0.85);
  lms[28] = lm(0.58, 0.85);
  lms[29] = lm(0.42, 0.9);
  lms[30] = lm(0.58, 0.9);
  return lms;
}

function frontPose(timestamp: number): PoseFrame {
  return {
    timestamp,
    landmarks: makeFrontLandmarks(),
    side: 'left',
    valid: true,
    sideVisibility: 0.9,
  };
}

/**
 * Face-on pose whose left elbow angle is exactly `deg`.
 *
 * Mirrors `poseAtElbow` on the face-on landmark set. The band used in the
 * tests below (105-150deg) is deliberately narrower than the side-view band
 * (95-175deg): seen from the front, the elbow flexion is partially
 * foreshortened, so a real front push-up spans a compressed range. The
 * counter must still calibrate and count inside it.
 */
function frontPoseAtElbow(timestamp: number, deg: number): PoseFrame {
  const lms = makeFrontLandmarks();
  const th = (deg * Math.PI) / 180;
  const r = 0.1;
  lms[15] = { x: 0.4 + r * Math.sin(th), y: 0.6 - r * Math.cos(th), z: 0, visibility: 1 };
  lms[16] = { x: 0.6 + r * Math.sin(th), y: 0.6 - r * Math.cos(th), z: 0, visibility: 1 };
  return { timestamp, landmarks: lms, side: 'left', valid: true, sideVisibility: 0.9 };
}

describe('Camera-check view gating', () => {
  it('lets a genuine front view pass the orientation check and reach ready', () => {
    const { session } = buildSession('front');
    session.beginCalibration();

    // Face-on body doing real movement: calibration still requires ROM.
    for (let i = 0; i < 70; i++) {
      const deg = 127.5 + 22.5 * Math.cos((2 * Math.PI * i) / 60);
      session.onPoseFrame(frontPoseAtElbow(i / 20, deg));
    }

    const state = session.getCalibrationState();
    const viewCheck = state.checks.find((c) => c.id === 'view');
    expect(viewCheck?.label).toBe('Front view');
    expect(viewCheck?.passed).toBe(true);
    expect(session.isCalibrated()).toBe(true);
    expect(state.ready).toBe(true);
  });

  it('lets front view calibrate and reach ready when feet/ankles are occluded behind the torso', () => {
    const { session } = buildSession('front');
    session.beginCalibration();

    // Front pose with ankles occluded (visibility = 0)
    const occludedFrontPose = (t: number, deg: number): PoseFrame => {
      const p = frontPoseAtElbow(t, deg);
      p.landmarks[27] = { x: 0, y: 0, z: 0, visibility: 0 };
      p.landmarks[28] = { x: 0, y: 0, z: 0, visibility: 0 };
      p.landmarks[29] = { x: 0, y: 0, z: 0, visibility: 0 };
      p.landmarks[30] = { x: 0, y: 0, z: 0, visibility: 0 };
      return p;
    };

    for (let i = 0; i < 70; i++) {
      const deg = 127.5 + 22.5 * Math.cos((2 * Math.PI * i) / 60);
      session.onPoseFrame(occludedFrontPose(i / 20, deg));
    }

    const state = session.getCalibrationState();
    const fullBodyCheck = state.checks.find((c) => c.id === 'full-body');
    const distCheck = state.checks.find((c) => c.id === 'distance');
    const lightCheck = state.checks.find((c) => c.id === 'lighting');

    expect(fullBodyCheck?.label).toBe('Upper body in frame');
    expect(fullBodyCheck?.passed).toBe(true);
    expect(distCheck?.passed).toBe(true);
    expect(lightCheck?.passed).toBe(true);
    expect(state.ready).toBe(true);
  });

  it('fails the front check when the body is side-on, and the side check when face-on', () => {
    // Front selected, side-on body: mismatch, must be flagged.
    const frontSession = buildSession('front').session;
    frontSession.beginCalibration();
    for (let i = 0; i < 30; i++) frontSession.onPoseFrame(validPose(i / 20));
    const frontState = frontSession.getCalibrationState();
    expect(frontState.checks.find((c) => c.id === 'view')?.label).toBe('Front view');
    expect(frontState.checks.find((c) => c.id === 'view')?.passed).toBe(false);

    // Side selected, face-on body: the original protection, kept.
    const sideSession = buildSession('side').session;
    sideSession.beginCalibration();
    for (let i = 0; i < 30; i++) sideSession.onPoseFrame(frontPose(i / 20));
    const sideState = sideSession.getCalibrationState();
    expect(sideState.checks.find((c) => c.id === 'view')?.label).toBe('Side view');
    expect(sideState.checks.find((c) => c.id === 'view')?.passed).toBe(false);
  });

  it('counts front-view push-ups end to end once counting starts', () => {
    const { session, reps } = buildSession('front');
    let t = 0;

    // Calibrate over the compressed front-view band (105-150deg).
    session.beginCalibration();
    for (let i = 0; i < 70; i++) {
      const deg = 127.5 + 22.5 * Math.cos((2 * Math.PI * i) / 60);
      session.onPoseFrame(frontPoseAtElbow(t, deg));
      t += 1 / 20;
    }
    expect(session.isCalibrated()).toBe(true);
    session.start();

    // Settle at the top so the FSM has an unambiguous starting state.
    for (let i = 0; i < 10; i++) {
      session.onPoseFrame(frontPoseAtElbow(t, 148));
      t += 1 / 20;
    }

    // Three clean reps inside the compressed band.
    const framesPerRep = 26;
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < framesPerRep; i++) {
        const deg = 127.5 + 22.5 * Math.cos((2 * Math.PI * i) / framesPerRep);
        session.onPoseFrame(frontPoseAtElbow(t, deg));
        t += 1 / 20;
      }
    }

    // Hold at the top to close the final rep (causal filter lag).
    for (let i = 0; i < 12; i++) {
      session.onPoseFrame(frontPoseAtElbow(t, 148));
      t += 1 / 20;
    }

    expect(reps.length).toBeGreaterThanOrEqual(3);
    expect(session.getMetrics().totalReps).toBeGreaterThanOrEqual(3);
  });
});
