'use client';

/**
 * lib/workout-session.ts
 *
 * Agent 15 — WORKOUT SESSION ENGINEER
 *
 * The session orchestrator. Ties together:
 *   camera -> pose -> biomechanics -> rep counter -> form assessment -> metrics
 *
 * Design: this is a plain class, not a React component. The per-frame pipeline
 * runs at 20fps and must not cause re-renders. It accumulates rep-level
 * results, and pushes a *throttled* metrics snapshot to React (max 4Hz) which
 * is plenty for a human-readable UI.
 *
 * The NO-FAKE-DATA rule (spec §26) is enforced here: if data is unavailable,
 * metrics carry `null`/NaN and the UI renders "--". Nothing is ever
 * back-filled with a plausible-looking number.
 */

import type {
  CalibrationCheck,
  CameraView,
  FormLabel,
  FrameFeatures,
  IssueCode,
  PoseFrame,
  RepAssessment,
  SessionMode,
  WorkoutMetrics,
  WorkoutRepRecord,
} from '@ai-pushup-coach/types';
import { extractFrameFeatures, type ExtractContext } from '@ai-pushup-coach/biomechanics';
import { RepCounter, calibrateThresholds } from '@ai-pushup-coach/rep-counter';
import {
  assessRep,
  bestValidStreak,
  mostCommonIssue,
  scoreStatus,
  sessionFormScore,
} from '@ai-pushup-coach/form-engine';
import type { FormModel } from '@ai-pushup-coach/form-engine';

export type SessionPhase = 'idle' | 'calibrating' | 'active' | 'paused' | 'finished';

/**
 * Calibration must see real movement before it will lock thresholds.
 *
 * `MIN` is the minimum evidence; `MAX` bounds the rolling window so that a
 * subject who is still getting into position does not permanently poison the
 * band with stationary frames (~20 s at 15 fps before the oldest sample ages
 * out, which is longer than anyone takes to start).
 */
export const CALIBRATION_MIN_SAMPLES = 60;
export const CALIBRATION_WINDOW_MAX = 300;

/**
 * How often (in frames) the live session re-derives its rep band from the
 * rolling window. 30 frames is ~2 s at 15 fps: often enough to follow fatigue,
 * rare enough that a transient cannot yank the thresholds mid-rep.
 */
export const ADAPTIVE_REFRESH_FRAMES = 30;

export interface LiveRepFeedback {
  repIndex: number;
  label: FormLabel;
  valid: boolean;
  primaryIssue: IssueCode | null;
  components: RepAssessment['components'];
  repScore: number;
  /** Bumped on every rep so the UI can animate on change. */
  nonce: number;
}

export interface SessionSnapshot {
  phase: SessionPhase;
  elapsedSeconds: number;
  metrics: WorkoutMetrics;
  /** Most recent rep, for the feedback panel. */
  lastRep: LiveRepFeedback | null;
  /** Live elbow angle, for the debug/diagnostics readout. */
  liveElbowAngle: number | null;
  repState: string;
  cycleProgress: number;
  pausedReason: 'pose-lost' | 'user' | null;
  view: CameraView;
}

export interface SessionCallbacks {
  onSnapshot: (snapshot: SessionSnapshot) => void;
  onRep: (assessment: RepAssessment) => void;
}

export interface SessionConfig {
  mode: SessionMode;
  view: CameraView;
  model: FormModel | null;
  /** Challenge mode: total session length in seconds. */
  durationLimitSeconds?: number;
  callbacks: SessionCallbacks;
}

/** Push UI updates at most this often. 4Hz is smooth for numbers a human reads. */
const SNAPSHOT_INTERVAL_MS = 250;

export class WorkoutSession {
  private phase: SessionPhase = 'idle';
  private readonly cfg: SessionConfig;

  private readonly counter: RepCounter;
  private readonly extractCtx: ExtractContext = { prevNormalized: null };

  private assessments: RepAssessment[] = [];
  private repRecords: WorkoutRepRecord[] = [];
  private startedAtMs = 0;
  private pausedAccumMs = 0;
  private pauseStartedAtMs: number | null = null;

  private lastSnapshotAt = 0;
  private lastRep: LiveRepFeedback | null = null;
  private repNonce = 0;

  private calibrationSamples: number[] = [];
  private calibrationComplete = false;
  /** True once the collected samples actually contain a usable range of motion. */
  private calibrationHasRom = false;

  /** Rolling window of post-filter angles, used to keep the band current. */
  private adaptiveSamples: number[] = [];
  private framesSinceRefresh = 0;

  /**
   * Rolling log of calibration observations. Exists purely to drive the
   * CAMERA CHECK panel; cleared once the session starts.
   */
  private calibrationFrameLog: CalibrationObservation[] = [];

  private liveElbowAngle: number | null = null;
  private pausedReason: 'pose-lost' | 'user' | null = null;

  /** Consecutive invalid pose frames — used to auto-pause on pose loss. */
  private lostFrames = 0;
  private static readonly LOST_FRAMES_TO_PAUSE = 12; // ~0.6s at 20fps

  constructor(cfg: SessionConfig) {
    this.cfg = cfg;
    this.counter = new RepCounter();
  }

  getPhase(): SessionPhase {
    return this.phase;
  }

  getMetrics(): WorkoutMetrics {
    return this.computeMetrics();
  }

  getRepRecords(): WorkoutRepRecord[] {
    return this.repRecords;
  }

  getAssessments(): RepAssessment[] {
    return this.assessments;
  }

  getElapsedSeconds(): number {
    if (this.startedAtMs === 0) return 0;
    const now = performance.now();
    const paused = this.pausedAccumMs + (this.pauseStartedAtMs ? now - this.pauseStartedAtMs : 0);
    return Math.max(0, (now - this.startedAtMs - paused) / 1000);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Calibration phase: collect elbow samples so the rep thresholds can be
   * derived from this person's actual range of motion rather than hardcoded
   * constants. This is what makes the counter work across body types and
   * camera views (see the note in rep-counter.ts).
   */
  beginCalibration(): void {
    this.phase = 'calibrating';
    this.calibrationSamples = [];
    this.calibrationComplete = false;
    this.calibrationHasRom = false;
    this.adaptiveSamples = [];
    this.framesSinceRefresh = 0;
  }

  /** Whether enough signal has been seen to calibrate. */
  isCalibrated(): boolean {
    return this.calibrationComplete;
  }

  /**
   * Live calibration picture for the CAMERA CHECK panel.
   *
   * Every check is derived from real landmark evidence. The panel re-polls
   * this at 5Hz rather than us pushing per-frame updates into React.
   */
  getCalibrationState(): {
    checks: CalibrationCheck[];
    samples: number;
    liveElbowAngle: number | null;
    ready: boolean;
    poseConfidence: number;
  } {
    const frames = this.calibrationFrameLog;
    const recent = frames.slice(-30);
    const validFrames = recent.filter((f) => f.valid);

    // --- Full body visible: ankles must be tracked and inside the frame ---
    // Push-up form depends on the ankles, so a frame cut at the ankles is
    // useless even when the shoulders track perfectly (POSE_SCHEMA.md §8).
    const bodyVisible =
      validFrames.length >= 5 &&
      recent.slice(-10).every((f) => f.anklesVisible);

    // --- Pose detected: enough valid frames recently ---
    const poseDetected = validFrames.length >= 10;

    // --- View: is the person oriented usefully? ---
    const viewScore = mean(recent.map((f) => f.sideDominance));
    const viewOk = viewScore >= 0.55;

    // --- Lighting / confidence: mean landmark visibility ---
    const conf = mean(recent.map((f) => f.sideVisibility));
    const lightingOk = conf >= 0.6;

    // --- Distance: torso must span a reasonable fraction of the frame ---
    const span = mean(recent.map((f) => f.bodySpanRatio));
    const distanceOk = span >= 0.12 && span <= 0.75;

    // --- Range of motion: calibration needs to SEE MOVEMENT, not stillness. ---
    //
    // A count-gated check here would pass while the subject stands motionless,
    // then lock a band the real push-ups never enter. The gate is the
    // `calibrated` flag from the same function the counter will use.
    const stable = this.calibrationHasRom;

    const checks: CalibrationCheck[] = [
      {
        id: 'full-body',
        label: 'Full body in frame',
        passed: bodyVisible,
        hint: 'Move further from the camera so your feet are visible.',
      },
      {
        id: 'pose',
        label: 'Pose detected',
        passed: poseDetected,
        hint: 'Step into the frame and hold a push-up position.',
      },
      {
        id: 'view',
        label: 'Side view',
        passed: viewOk,
        hint: 'Turn sideways to the camera for the most accurate analysis.',
      },
      {
        id: 'lighting',
        label: 'Lighting',
        passed: lightingOk,
        hint: 'Add light or avoid strong backlighting behind you.',
      },
      {
        id: 'distance',
        label: 'Distance',
        passed: distanceOk,
        hint: 'Adjust your distance — you are too close or too far.',
      },
      {
        id: 'stable',
        label: 'Range of motion detected',
        passed: stable,
        hint: stable
          ? `Movement range captured from ${this.calibrationSamples.length} samples.`
          : 'Do two or three slow practice push-ups so the rep counter can learn your range.',
      },
    ];

    return {
      checks,
      samples: this.calibrationSamples.length,
      liveElbowAngle: this.liveElbowAngle,
      ready: checks.every((c) => c.passed),
      poseConfidence: conf,
    };
  }

  start(): void {
    if (this.calibrationSamples.length > 0) {
      const thresholds = calibrateThresholds(this.calibrationSamples);
      this.counter.setThresholds(thresholds);
    }
    /*
     * Drop the filter history accumulated while the user was setting up.
     * Calibration samples were pushed through the counter's filters, so
     * without this the first frames of the set would be damped toward a stale
     * "standing still" value. The FSM's tolerant READY state handles the brief
     * re-fill transient that follows.
     */
    this.counter.resetFilters();
    this.phase = 'active';
    this.startedAtMs = performance.now();
    this.pausedAccumMs = 0;
    this.pauseStartedAtMs = null;
    this.pausedReason = null;
    this.emit(true);
  }

  pause(reason: 'pose-lost' | 'user'): void {
    if (this.phase !== 'active') return;
    this.phase = 'paused';
    this.pausedReason = reason;
    this.pauseStartedAtMs = performance.now();
    this.emit(true);
  }

  resume(): void {
    if (this.phase !== 'paused') return;
    if (this.pauseStartedAtMs !== null) {
      this.pausedAccumMs += performance.now() - this.pauseStartedAtMs;
      this.pauseStartedAtMs = null;
    }
    this.pausedReason = null;
    this.phase = 'active';
    this.lostFrames = 0;
    this.emit(true);
  }

  finish(): void {
    this.phase = 'finished';
    this.emit(true);
  }

  reset(): void {
    this.phase = 'idle';
    this.counter.reset();
    this.assessments = [];
    this.repRecords = [];
    this.startedAtMs = 0;
    this.pausedAccumMs = 0;
    this.pauseStartedAtMs = null;
    this.lastRep = null;
    this.liveElbowAngle = null;
    this.pausedReason = null;
    this.lostFrames = 0;
    this.calibrationSamples = [];
    this.calibrationComplete = false;
    this.calibrationHasRom = false;
    this.adaptiveSamples = [];
    this.framesSinceRefresh = 0;
    this.extractCtx.prevNormalized = null;
  }

  // -------------------------------------------------------------------------
  // Per-frame pipeline
  // -------------------------------------------------------------------------

  /**
   * Feed one pose frame. Called from the pose rAF loop — keep it fast and
   * allocation-light.
   */
  onPoseFrame(pose: PoseFrame): void {
    const features = extractFrameFeatures(pose, this.extractCtx);
    this.processFrame(features, pose);

    // Snapshot must happen even when nothing is counted, so the timer and
    // "pose lost" states still update in the UI.
    this.maybeEmit();
  }

  private processFrame(frame: FrameFeatures, pose?: PoseFrame): void {
    if (this.phase === 'calibrating') {
      if (frame.valid && Number.isFinite(frame.elbowAngle)) {
        /*
         * Calibrate on the FILTERED signal, not the raw angle.
         *
         * The rep counter smooths every sample (mask -> causal low-pass ->
         * median) before its state machine sees it, and smoothing compresses
         * the extremes. A band derived from raw angles therefore sits outside
         * the range the FSM ever observes, leaving its thresholds unreachable:
         * the same clean 8-rep set counted 0 reps from raw samples and 7 from
         * filtered ones. `observe()` runs a sample through that same chain
         * without advancing the state machine.
         */
        const filtered = this.counter.observe(frame.elbowAngle);
        if (Number.isFinite(filtered)) {
          this.calibrationSamples.push(filtered);

          // Bound the buffer so early "standing still" frames cannot pin the
          // band forever. Once the subject actually moves, the stale samples
          // age out and the range of motion becomes visible.
          if (this.calibrationSamples.length > CALIBRATION_WINDOW_MAX) {
            this.calibrationSamples.splice(
              0,
              this.calibrationSamples.length - CALIBRATION_WINDOW_MAX,
            );
          }

          // Completing on sample COUNT alone is the bug this replaced. The UI
          // tells the user to hold still, so a count-gated calibration happily
          // locks thresholds from a near-constant elbow angle -- and then the
          // FSM has a band the real movement never enters. Measured on real
          // clips: three of six counted ZERO reps. Requiring a genuine range
          // of motion (the `calibrated` flag) fixes all three.
          if (this.calibrationSamples.length >= CALIBRATION_MIN_SAMPLES) {
            this.calibrationHasRom = calibrateThresholds(
              this.calibrationSamples,
            ).calibrated;
            this.calibrationComplete = this.calibrationHasRom;
          }
        }
      }

      // Record an observation for the CAMERA CHECK panel.
      this.calibrationFrameLog.push(buildObservation(frame, pose));
      if (this.calibrationFrameLog.length > 60) this.calibrationFrameLog.shift();

      this.liveElbowAngle = frame.valid ? frame.elbowAngle : null;
      return;
    }

    if (this.phase !== 'active' && this.phase !== 'paused') return;

    // --- pose-loss auto-pause ---
    if (!frame.valid) {
      this.lostFrames++;
      this.liveElbowAngle = null;
      if (
        this.lostFrames >= WorkoutSession.LOST_FRAMES_TO_PAUSE &&
        this.phase === 'active'
      ) {
        this.pause('pose-lost');
      }
      return;
    }

    if (this.lostFrames > 0 && this.phase === 'paused' && this.pausedReason === 'pose-lost') {
      // Pose recovered — resume automatically so the user is not stuck.
      this.lostFrames = 0;
      this.resume();
    }
    this.lostFrames = 0;

    this.liveElbowAngle = frame.elbowAngle;

    if (this.phase !== 'active') return;

    const rep = this.counter.feed(frame);
    this.refreshThresholdsAdaptively();
    if (rep) {
      this.handleCompletedRep(rep.frames);
    }
  }

  /**
   * Keep the rep band tracking the user's CURRENT range of motion.
   *
   * A band locked from the first few reps goes stale: people start deep and
   * fade shallow as they tire, and once the thresholds sit outside the range
   * the signal actually visits the FSM goes silent. Measured on real clips,
   * locking the band counted 27 of 67 reps and produced ZERO on three of six
   * clips; re-calibrating from a rolling window counted 55 of 67 and never
   * zero. See tests/replay_runner.mjs.
   *
   * Thresholds are only swapped at a stable point in the cycle (READY/UP).
   * Refreshing mid-descent could move a threshold past the current angle and
   * either drop the rep or double-count it.
   */
  private refreshThresholdsAdaptively(): void {
    const angle = this.counter.getLastAngle();
    if (!Number.isFinite(angle)) return;

    this.adaptiveSamples.push(angle);
    if (this.adaptiveSamples.length > CALIBRATION_WINDOW_MAX) {
      this.adaptiveSamples.splice(
        0,
        this.adaptiveSamples.length - CALIBRATION_WINDOW_MAX,
      );
    }

    if (++this.framesSinceRefresh < ADAPTIVE_REFRESH_FRAMES) return;
    this.framesSinceRefresh = 0;

    const state = this.counter.getState();
    if (state !== 'READY' && state !== 'UP') return;

    const next = calibrateThresholds(this.adaptiveSamples);
    if (next.calibrated) this.counter.setThresholds(next);
  }

  private handleCompletedRep(frames: FrameFeatures[]): void {
    const index = this.assessments.length + 1;

    const assessment = assessRep(
      {
        repIndex: index,
        frames,
        view: this.cfg.view,
        totalFramesInWindow: frames.length,
      },
      {
        model: this.cfg.model,
        decisionThreshold: this.cfg.model?.getThreshold() ?? 0.5,
      },
    );

    this.assessments.push(assessment);

    const last = frames[frames.length - 1];
    const first = frames[0];
    const duration = last && first ? last.timestamp - first.timestamp : NaN;

    const record: WorkoutRepRecord = {
      repNumber: index,
      valid: assessment.valid,
      formProbability: assessment.goodProbability,
      formLabel: assessment.label,
      depthScore: assessment.components.depth,
      alignmentScore: assessment.components.alignment,
      tempoScore: assessment.components.tempo,
      consistencyScore: assessment.components.consistency,
      repScore: assessment.repScore,
      detectedIssue: assessment.primaryIssue,
      repDurationSeconds: duration,
      minElbowAngleDeg: minElbow(frames),
      bodyLineDeviationMax: maxAbsBodyLine(frames),
    };
    this.repRecords.push(record);

    this.repNonce++;
    this.lastRep = {
      repIndex: index,
      label: assessment.label,
      valid: assessment.valid,
      primaryIssue: assessment.primaryIssue,
      components: assessment.components,
      repScore: assessment.repScore,
      nonce: this.repNonce,
    };

    this.cfg.callbacks.onRep(assessment);
    this.emit(true);
  }

  // -------------------------------------------------------------------------
  // Metrics
  // -------------------------------------------------------------------------

  private computeMetrics(): WorkoutMetrics {
    const total = this.assessments.length;
    const valid = this.assessments.filter((a) => a.valid).length;
    const invalid = total - valid;

    const durations = this.repRecords
      .map((r) => r.repDurationSeconds)
      .filter((d) => Number.isFinite(d) && d > 0);
    const meanRep =
      durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : null;

    return {
      totalReps: total,
      validReps: valid,
      invalidReps: invalid,
      formScore: sessionFormScore(this.assessments),
      bestStreak: bestValidStreak(this.assessments),
      meanRepSeconds: meanRep,
      mostCommonIssue: mostCommonIssue(this.assessments),
      scoreStatus: scoreStatus(total),
    };
  }

  private buildSnapshot(): SessionSnapshot {
    return {
      phase: this.phase,
      elapsedSeconds: this.getElapsedSeconds(),
      metrics: this.computeMetrics(),
      lastRep: this.lastRep,
      liveElbowAngle: this.liveElbowAngle,
      repState: this.counter.getState(),
      cycleProgress: this.counter.getCycleProgress(),
      pausedReason: this.pausedReason,
      view: this.cfg.view,
    };
  }

  /** Throttled emit. */
  private maybeEmit(): void {
    const now = performance.now();
    if (now - this.lastSnapshotAt < SNAPSHOT_INTERVAL_MS) return;
    this.emit();
  }

  private emit(force = false): void {
    if (!force) {
      const now = performance.now();
      if (now - this.lastSnapshotAt < SNAPSHOT_INTERVAL_MS) return;
    }
    this.lastSnapshotAt = performance.now();
    this.cfg.callbacks.onSnapshot(this.buildSnapshot());
  }

  /** Force a snapshot (e.g. on phase change). */
  flush(): void {
    this.emit(true);
  }

  /** Snapshot accessor for the UI when a session ends. */
  buildSnapshotForUi(): SessionSnapshot {
    return this.buildSnapshot();
  }
}

function minElbow(frames: FrameFeatures[]): number {
  let m = Infinity;
  for (const f of frames) if (Number.isFinite(f.elbowAngle)) m = Math.min(m, f.elbowAngle);
  return Number.isFinite(m) ? m : NaN;
}

function maxAbsBodyLine(frames: FrameFeatures[]): number {
  let m = 0;
  for (const f of frames) {
    if (Number.isFinite(f.bodyLineDeviation)) {
      m = Math.max(m, Math.abs(f.bodyLineDeviation));
    }
  }
  return m;
}

// ---------------------------------------------------------------------------
// Calibration observations
// ---------------------------------------------------------------------------

interface CalibrationObservation {
  valid: boolean;
  sideVisibility: number;
  /** True when both ankles are tracked and not clipped at the frame edge. */
  anklesVisible: boolean;
  /**
   * How much one side dominates the other. High value = a clean side view;
   * low value = the person faces the camera (both sides equally visible).
   */
  sideDominance: number;
  /** Body span as a fraction of the frame, used to judge distance. */
  bodySpanRatio: number;
}

function buildObservation(frame: FrameFeatures, pose?: PoseFrame): CalibrationObservation {
  if (!pose || !pose.valid || pose.landmarks.length < 33) {
    return {
      valid: false,
      sideVisibility: 0,
      anklesVisible: false,
      sideDominance: 0,
      bodySpanRatio: 0,
    };
  }

  const lms = pose.landmarks;
  const L_ANKLE = 27;
  const R_ANKLE = 28;
  const L_SHOULDER = 11;
  const R_SHOULDER = 12;
  const L_HIP = 23;
  const R_HIP = 24;

  const ankleL = lms[L_ANKLE];
  const ankleR = lms[R_ANKLE];

  // Feet must be tracked AND not clipped at the bottom/edges of the frame.
  // A leg cut off at the ankle makes alignment unmeasurable.
  const anklesVisible =
    !!ankleL &&
    !!ankleR &&
    ankleL.visibility > 0.5 &&
    ankleR.visibility > 0.5 &&
    ankleL.y < 0.98 &&
    ankleR.y < 0.98 &&
    ankleL.x > 0.02 &&
    ankleR.x > 0.02 &&
    ankleL.x < 0.98 &&
    ankleR.x < 0.98;

  // Side dominance from shoulder-width vs torso-length. In side view the
  // shoulders overlap so apparent width collapses relative to body length.
  const shMid = {
    x: ((lms[L_SHOULDER]?.x ?? 0) + (lms[R_SHOULDER]?.x ?? 0)) / 2,
    y: ((lms[L_SHOULDER]?.y ?? 0) + (lms[R_SHOULDER]?.y ?? 0)) / 2,
  };
  const hipMid = {
    x: ((lms[L_HIP]?.x ?? 0) + (lms[R_HIP]?.x ?? 0)) / 2,
    y: ((lms[L_HIP]?.y ?? 0) + (lms[R_HIP]?.y ?? 0)) / 2,
  };
  const torsoLen = Math.hypot(shMid.x - hipMid.x, shMid.y - hipMid.y) || 1e-6;
  const shoulderWidth = Math.hypot(
    (lms[L_SHOULDER]?.x ?? 0) - (lms[R_SHOULDER]?.x ?? 0),
    (lms[L_SHOULDER]?.y ?? 0) - (lms[R_SHOULDER]?.y ?? 0),
  );
  const widthRatio = shoulderWidth / torsoLen;
  // Map widthRatio ~0.5 (side-on) to 1.0 dominance, ~1.2 (face-on) to 0.0.
  const sideDominance = clamp01((1.2 - widthRatio) / 0.7);

  const spanX = Math.abs((lms[L_ANKLE]?.x ?? 0) - shMid.x);
  const spanY = Math.abs((lms[L_ANKLE]?.y ?? 0) - shMid.y);
  const bodySpanRatio = Math.hypot(spanX, spanY);

  return {
    valid: frame.valid,
    sideVisibility: pose.sideVisibility,
    anklesVisible,
    sideDominance,
    bodySpanRatio,
  };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function mean(values: number[]): number {
  const f = values.filter((v) => Number.isFinite(v));
  if (f.length === 0) return 0;
  return f.reduce((a, b) => a + b, 0) / f.length;
}
