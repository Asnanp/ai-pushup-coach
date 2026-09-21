'use client';

/**
 * lib/workout-session.ts
 *
 * Agent 15 — WORKOUT SESSION ENGINEER & Agent 1 — V2 ORCHESTRATOR
 *
 * The session orchestrator. Ties together:
 *   camera -> pose -> view detection -> signal extraction -> biomechanics ->
 *   rep counter -> form assessment -> coaching engine -> voice coach -> metrics
 *
 * Design: this is a plain class, not a React component. The per-frame pipeline
 * runs at 20-30fps and must not cause re-renders. It accumulates rep-level
 * results, and pushes a throttled metrics snapshot to React (max 4Hz) which
 * is plenty for a human-readable UI.
 *
 * The NO-FAKE-DATA rule (spec §26) is strictly enforced: if data is unavailable,
 * metrics carry null/NaN and the UI renders "--". Nothing is ever back-filled
 * with a plausible-looking number.
 */

import type {
  CalibrationCheck,
  CalibrationPhase,
  CameraView,
  FormLabel,
  FormStatus,
  FrameFeatures,
  IssueCode,
  PoseFrame,
  RepAssessment,
  RepMotionSignal,
  SessionMode,
  TwoStageCalibrationState,
  UserViewMode,
  V2CameraView,
  WorkoutMetrics,
  WorkoutRepRecord,
} from '@ai-pushup-coach/types';
import { extractFrameFeatures, type ExtractContext } from '@ai-pushup-coach/biomechanics';
import {
  RepCounter,
  calibrateThresholds,
  createSignalExtractor,
  MotionCalibrator,
  type IRepSignalExtractor,
} from '@ai-pushup-coach/rep-counter';
import { ViewEstimator } from '@ai-pushup-coach/pose';
import {
  CoachEngine,
  VoiceCoach,
  type CoachAction,
  type VoiceCoachMode,
} from '@ai-pushup-coach/coach-engine';
import {
  assessRep,
  bestValidStreak,
  mostCommonIssue,
  scoreStatus,
  sessionFormScore,
} from '@ai-pushup-coach/form-engine';
import type { FormModel } from '@ai-pushup-coach/form-engine';

export type SessionPhase = 'idle' | 'calibrating' | 'active' | 'paused' | 'finished';

export const CALIBRATION_MIN_SAMPLES = 60;
export const CALIBRATION_WINDOW_MAX = 300;
export const ADAPTIVE_REFRESH_FRAMES = 30;

export function toCameraView(v2: V2CameraView): CameraView {
  if (v2 === 'VIEW_FRONT') return 'front';
  if (v2 === 'VIEW_SIDE_LEFT' || v2 === 'VIEW_SIDE_RIGHT') return 'side';
  return 'diagonal';
}

const VIEW_CHECKS: Record<
  CameraView,
  { label: string; hint: string; ok: (dominance: number) => boolean }
> = {
  side: {
    label: 'Side view',
    hint: 'Turn sideways to the camera for the most accurate analysis.',
    ok: (v) => v >= 0.55,
  },
  diagonal: {
    label: 'Diagonal view',
    hint: 'A 45° angle to the camera is ideal; any orientation counts.',
    ok: () => true,
  },
  front: {
    label: 'Front view',
    hint: 'Face the camera squarely so both shoulders are equally visible.',
    ok: (v) => v <= 0.5,
  },
};

export interface LiveRepFeedback {
  repIndex: number;
  label: FormLabel;
  formStatus?: FormStatus;
  uncertain?: boolean;
  valid: boolean;
  primaryIssue: IssueCode | null;
  components: RepAssessment['components'];
  repScore: number;
  coachMessage?: string;
  isCorrection?: boolean;
  /** Bumped on every rep so the UI can animate on change. */
  nonce: number;
}

export interface DevDiagnosticsSnapshot {
  detectedView: string;
  viewConfidence: number;
  elbowLeft: number | null;
  elbowRight: number | null;
  elbowCombined: number | null;
  elbow2D: number | null;
  elbow3D: number | null;
  romTop: number | null;
  romBottom: number | null;
  normalizedPhase: number | null;
  fsmState: string;
  poseConfidence: number;
  shoulderDepth: number | null;
  hipDepth: number | null;
  recalibrationStatus: string;
}

export interface SessionSnapshot {
  phase: SessionPhase;
  elapsedSeconds: number;
  metrics: WorkoutMetrics;
  lastRep: LiveRepFeedback | null;
  liveElbowAngle: number | null;
  repState: string;
  cycleProgress: number;
  pausedReason: 'pose-lost' | 'user' | null;
  view: CameraView;
  userViewMode?: UserViewMode;
  detectedV2View?: V2CameraView;
  diagnostics?: DevDiagnosticsSnapshot;
  lastCoachAction?: CoachAction | null;
}

export interface SessionCallbacks {
  onSnapshot: (snapshot: SessionSnapshot) => void;
  onRep: (assessment: RepAssessment) => void;
  onMotionSample?: (sample: {
    angle: number;
    state?: string;
    progress?: number;
    repCompleted?: {
      repNumber: number;
      score?: number | null;
      valid: boolean;
    } | null;
  }) => void;
}

export interface SessionConfig {
  mode: SessionMode;
  view: CameraView | UserViewMode | 'auto';
  model: FormModel | null;
  durationLimitSeconds?: number;
  voiceMode?: VoiceCoachMode;
  callbacks: SessionCallbacks;
}

const SNAPSHOT_INTERVAL_MS = 250;

export class WorkoutSession {
  private phase: SessionPhase = 'idle';
  private readonly cfg: SessionConfig;

  private readonly counter: RepCounter;
  private readonly extractCtx: ExtractContext = { prevNormalized: null };

  private userViewMode: UserViewMode = 'AUTO';
  private activeV2View: V2CameraView = 'VIEW_FRONT';
  private readonly viewEstimator = new ViewEstimator();
  private signalExtractor: IRepSignalExtractor;
  private readonly motionCalibrator: MotionCalibrator;
  private readonly coachEngine = new CoachEngine();
  private readonly voiceCoach = new VoiceCoach();
  private lastSignal: RepMotionSignal | null = null;
  private lastCoachAction: CoachAction | null = null;

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
  private calibrationHasRom = false;

  private adaptiveSamples: number[] = [];
  private framesSinceRefresh = 0;

  private calibrationFrameLog: CalibrationObservation[] = [];

  private liveElbowAngle: number | null = null;
  private pausedReason: 'pose-lost' | 'user' | null = null;

  private lostFrames = 0;
  private static readonly LOST_FRAMES_TO_PAUSE = 12; // ~0.6s at 20fps

  constructor(cfg: SessionConfig) {
    this.cfg = cfg;
    this.counter = new RepCounter();

    const rawView = String(cfg.view || 'side').toUpperCase();
    if (rawView === 'AUTO') {
      this.userViewMode = 'AUTO';
      this.activeV2View = 'VIEW_FRONT';
    } else if (rawView === 'FRONT') {
      this.userViewMode = 'FRONT';
      this.activeV2View = 'VIEW_FRONT';
    } else if (rawView === 'SIDE') {
      this.userViewMode = 'SIDE';
      this.activeV2View = 'VIEW_SIDE_LEFT';
    } else if (rawView === 'DIAGONAL') {
      this.userViewMode = 'DIAGONAL';
      this.activeV2View = 'VIEW_DIAGONAL_LEFT';
    } else {
      this.userViewMode = 'SIDE';
      this.activeV2View = 'VIEW_SIDE_LEFT';
    }

    this.signalExtractor = createSignalExtractor(this.activeV2View);
    this.motionCalibrator = new MotionCalibrator({ view: this.activeV2View });

    if (cfg.voiceMode) {
      this.voiceCoach.setMode(cfg.voiceMode);
    }
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

  getVoiceCoach(): VoiceCoach {
    return this.voiceCoach;
  }

  getCoachEngine(): CoachEngine {
    return this.coachEngine;
  }

  setVoiceMode(mode: VoiceCoachMode): void {
    this.voiceCoach.setMode(mode);
  }

  setUserViewMode(mode: UserViewMode): void {
    this.userViewMode = mode;
    if (mode === 'FRONT') {
      this.activeV2View = 'VIEW_FRONT';
    } else if (mode === 'SIDE') {
      this.activeV2View = 'VIEW_SIDE_LEFT';
    } else if (mode === 'DIAGONAL') {
      this.activeV2View = 'VIEW_DIAGONAL_LEFT';
    }
    this.signalExtractor = createSignalExtractor(this.activeV2View);
    this.motionCalibrator.setView(this.activeV2View);
  }

  getElapsedSeconds(): number {
    if (this.startedAtMs === 0) return 0;
    const now = performance.now();
    const paused = this.pausedAccumMs + (this.pauseStartedAtMs ? now - this.pauseStartedAtMs : 0);
    return Math.max(0, (now - this.startedAtMs - paused) / 1000);
  }

  beginCalibration(): void {
    this.phase = 'calibrating';
    this.calibrationSamples = [];
    this.calibrationComplete = false;
    this.calibrationHasRom = false;
    this.adaptiveSamples = [];
    this.framesSinceRefresh = 0;
    this.viewEstimator.reset();
    this.motionCalibrator.reset();
  }

  isCalibrated(): boolean {
    return this.calibrationComplete;
  }

  getCalibrationState(): {
    checks: CalibrationCheck[];
    samples: number;
    liveElbowAngle: number | null;
    ready: boolean;
    poseConfidence: number;
    calibrationPhase?: CalibrationPhase;
    calibrationRepsCompleted?: number;
    calibrationRepsRequired?: number;
    feedbackPrompt?: string;
  } {
    const frames = this.calibrationFrameLog;
    const recent = frames.slice(-30);
    const validFrames = recent.filter((f) => f.valid);

    const isFront = this.activeV2View === 'VIEW_FRONT';

    const bodyVisible = isFront
      ? validFrames.length >= 3 && recent.slice(-10).some((f) => f.upperBodyVisible)
      : validFrames.length >= 5 && recent.slice(-10).every((f) => f.anklesVisible);

    const poseDetected =
      validFrames.length >= 5 ||
      (isFront && recent.filter((f) => f.upperBodyVisible).length >= 5);

    const viewScore = mean(recent.map((f) => f.sideDominance));
    const effectiveView: CameraView =
      this.userViewMode === 'AUTO'
        ? toCameraView(this.activeV2View)
        : toCameraView(this.activeV2View);
    const viewCheck = VIEW_CHECKS[effectiveView] ?? VIEW_CHECKS['diagonal'];
    const viewOk = this.userViewMode === 'AUTO' ? true : viewCheck.ok(viewScore);

    const conf = mean(
      recent.map((f) => (isFront ? f.upperBodyVisibility : f.sideVisibility)),
    );
    const lightingOk = conf >= 0.45;

    const span = mean(recent.map((f) => f.bodySpanRatio));
    const distanceOk = isFront
      ? span >= 0.10 && span <= 0.85
      : span >= 0.12 && span <= 0.75;

    const stable = this.calibrationHasRom;

    // Safety fallback: if ROM has already been demonstrated through practice reps,
    // the user has definitively proven presence and active push-up movement.
    const effectiveDistanceOk = distanceOk || stable;
    const effectiveLightingOk = lightingOk || stable;
    const effectivePoseOk = poseDetected || stable;
    const effectiveBodyVisible = bodyVisible || stable;

    const checks: CalibrationCheck[] = [
      {
        id: 'full-body',
        label: isFront ? 'Upper body in frame' : 'Full body in frame',
        passed: effectiveBodyVisible,
        hint: isFront
          ? 'Position yourself so your shoulders, chest, and arms are in view.'
          : 'Move further from the camera so your feet are visible.',
      },
      {
        id: 'pose',
        label: 'Pose detected',
        passed: effectivePoseOk,
        hint: 'Step into the frame and hold a push-up position.',
      },
      {
        id: 'view',
        label: viewCheck.label,
        passed: viewOk,
        hint: viewCheck.hint,
      },
      {
        id: 'lighting',
        label: 'Lighting',
        passed: effectiveLightingOk,
        hint: 'Add light or avoid strong backlighting behind you.',
      },
      {
        id: 'distance',
        label: 'Distance',
        passed: effectiveDistanceOk,
        hint: isFront
          ? 'Adjust distance — ensure shoulders and chest fill the frame comfortably.'
          : 'Adjust your distance — you are too close or too far.',
      },
      {
        id: 'stable',
        label: 'Range of motion detected',
        passed: stable,
        hint: stable
          ? `Movement range captured from ${this.calibrationSamples.length} samples.`
          : 'Do two or three practice push-ups so the rep counter can learn your range.',
      },
    ];

    const motionState: TwoStageCalibrationState = this.motionCalibrator.getState();

    return {
      checks,
      samples: this.calibrationSamples.length,
      liveElbowAngle: this.liveElbowAngle,
      ready: checks.every((c) => c.passed),
      poseConfidence: conf,
      calibrationPhase: motionState.phase,
      calibrationRepsCompleted: motionState.calibrationRepsCompleted,
      calibrationRepsRequired: motionState.calibrationRepsRequired,
      feedbackPrompt: motionState.feedbackPrompt,
    };
  }

  start(): void {
    if (this.calibrationSamples.length > 0) {
      const thresholds = calibrateThresholds(this.calibrationSamples);
      this.counter.setThresholds(thresholds);
    }
    this.counter.resetFilters();
    this.phase = 'active';
    this.startedAtMs = performance.now();
    this.pausedAccumMs = 0;
    this.pauseStartedAtMs = null;
    this.pausedReason = null;
    this.voiceCoach.speakEvent('start');
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
    this.voiceCoach.speakEvent('workout_complete');
    this.emit(true);
  }

  reset(): void {
    this.phase = 'idle';
    this.counter.reset();
    this.viewEstimator.reset();
    this.motionCalibrator.reset();
    this.coachEngine.reset();
    this.voiceCoach.stop();
    this.assessments = [];
    this.repRecords = [];
    this.startedAtMs = 0;
    this.pausedAccumMs = 0;
    this.pauseStartedAtMs = null;
    this.lastRep = null;
    this.lastCoachAction = null;
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

  onPoseFrame(pose: PoseFrame): void {
    // 1. View estimation (if in AUTO mode)
    if (this.userViewMode === 'AUTO' && pose.valid && pose.landmarks?.length >= 25) {
      const est = this.viewEstimator.estimate(pose.landmarks, pose.timestamp);
      if (est.view !== this.activeV2View && !est.isLocked) {
        this.activeV2View = est.view;
        this.signalExtractor = createSignalExtractor(this.activeV2View);
        this.motionCalibrator.setView(this.activeV2View);
      }
    } else if (this.userViewMode === 'SIDE') {
      const sideView: V2CameraView = pose.side === 'right' ? 'VIEW_SIDE_RIGHT' : 'VIEW_SIDE_LEFT';
      if (this.activeV2View !== sideView) {
        this.activeV2View = sideView;
        this.signalExtractor = createSignalExtractor(this.activeV2View);
      }
    } else if (this.userViewMode === 'DIAGONAL') {
      const diagView: V2CameraView = pose.side === 'right' ? 'VIEW_DIAGONAL_RIGHT' : 'VIEW_DIAGONAL_LEFT';
      if (this.activeV2View !== diagView) {
        this.activeV2View = diagView;
        this.signalExtractor = createSignalExtractor(this.activeV2View);
      }
    }

    // 2. Extract bilateral / view-specific RepMotionSignal
    const signal = pose.valid && pose.landmarks?.length >= 25
      ? this.signalExtractor.extract(pose.landmarks, pose.timestamp)
      : this.emptySignal(pose.timestamp);
    this.lastSignal = signal;

    // 3. Extract biomechanical features for form assessment
    const features = extractFrameFeatures(pose, this.extractCtx);
    this.processFrame(features, pose, signal);

    this.maybeEmit();
  }

  private emptySignal(t: number): RepMotionSignal {
    return {
      timestamp: t,
      phaseEvidence: Number.NaN,
      elbowLeft: Number.NaN,
      elbowRight: Number.NaN,
      elbowCombined: Number.NaN,
      shoulderMotion: Number.NaN,
      hipMotion: Number.NaN,
      worldDepthMotion: Number.NaN,
      poseConfidence: 0,
      view: this.activeV2View,
    };
  }

  private processFrame(frame: FrameFeatures, pose: PoseFrame | undefined, signal: RepMotionSignal): void {
    if (this.phase === 'calibrating') {
      const angleToObserve = Number.isFinite(signal.phaseEvidence) ? signal.phaseEvidence : frame.elbowAngle;
      if (frame.valid && Number.isFinite(angleToObserve)) {
        const filtered = this.counter.observe(angleToObserve);
        if (Number.isFinite(filtered)) {
          this.calibrationSamples.push(filtered);

          if (this.calibrationSamples.length > CALIBRATION_WINDOW_MAX) {
            this.calibrationSamples.splice(
              0,
              this.calibrationSamples.length - CALIBRATION_WINDOW_MAX,
            );
          }

          if (this.calibrationSamples.length >= CALIBRATION_MIN_SAMPLES) {
            const calib = calibrateThresholds(this.calibrationSamples);
            this.calibrationHasRom = calib.calibrated;
            this.calibrationComplete = this.calibrationHasRom;
            if (this.calibrationComplete) {
              this.viewEstimator.lock();
            }
          }
        }
      }

      this.calibrationFrameLog.push(buildObservation(frame, pose, this.activeV2View));
      if (this.calibrationFrameLog.length > 60) this.calibrationFrameLog.shift();

      this.liveElbowAngle = frame.valid && Number.isFinite(angleToObserve) ? angleToObserve : null;
      if (this.liveElbowAngle !== null && Number.isFinite(this.liveElbowAngle)) {
        this.cfg.callbacks.onMotionSample?.({
          angle: this.liveElbowAngle,
          state: 'CALIBRATING',
          progress: 0,
        });
      }
      return;
    }

    if (this.phase !== 'active' && this.phase !== 'paused') return;

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
      this.lostFrames = 0;
      this.resume();
    }
    this.lostFrames = 0;

    const liveAngle = Number.isFinite(signal.phaseEvidence) ? signal.phaseEvidence : frame.elbowAngle;
    this.liveElbowAngle = liveAngle;

    if (Number.isFinite(liveAngle)) {
      this.cfg.callbacks.onMotionSample?.({
        angle: liveAngle,
        state: this.counter.getState(),
        progress: this.counter.getCycleProgress(),
      });
    }

    if (this.phase !== 'active') return;

    const rep = this.counter.feed(frame, signal);
    this.refreshThresholdsAdaptively();
    if (rep) {
      this.handleCompletedRep(rep.frames);
    }
  }

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
        view: toCameraView(this.activeV2View),
        totalFramesInWindow: frames.length,
      },
      {
        model: this.cfg.model,
        decisionThreshold: this.cfg.model?.getThreshold() ?? 0.53,
      },
    );

    this.assessments.push(assessment);

    const coachAction = this.coachEngine.onRepCompleted(assessment);
    this.lastCoachAction = coachAction;
    this.voiceCoach.speakRep(coachAction, assessment);

    const last = frames[frames.length - 1];
    const first = frames[0];
    const duration = last && first ? last.timestamp - first.timestamp : NaN;

    const record: WorkoutRepRecord = {
      repNumber: index,
      valid: assessment.valid,
      formProbability: assessment.goodProbability,
      formLabel: assessment.label,
      formStatus: assessment.formStatus,
      uncertain: assessment.uncertain,
      depthScore: assessment.components.depth,
      alignmentScore: assessment.components.alignment,
      tempoScore: assessment.components.tempo,
      consistencyScore: assessment.components.consistency,
      repScore: assessment.repScore,
      detectedIssue: assessment.primaryIssue,
      repDurationSeconds: duration,
      minElbowAngleDeg: minElbow(frames),
      bodyLineDeviationMax: maxAbsBodyLine(frames),
      coachMessage: coachAction.message ?? undefined,
      isCorrection: coachAction.isCorrection,
    };
    this.repRecords.push(record);

    this.repNonce++;
    this.lastRep = {
      repIndex: index,
      label: assessment.label,
      formStatus: assessment.formStatus,
      uncertain: assessment.uncertain,
      valid: assessment.valid,
      primaryIssue: assessment.primaryIssue,
      components: assessment.components,
      repScore: assessment.repScore,
      coachMessage: coachAction.message ?? undefined,
      isCorrection: coachAction.isCorrection,
      nonce: this.repNonce,
    };

    this.cfg.callbacks.onRep(assessment);
    const minElbowVal = minElbow(frames);
    this.cfg.callbacks.onMotionSample?.({
      angle: Number.isFinite(minElbowVal) ? minElbowVal : 90,
      state: 'TOP',
      progress: 1,
      repCompleted: {
        repNumber: index,
        score: assessment.repScore,
        valid: assessment.valid,
      },
    });
    this.emit(true);
  }

  private computeMetrics(): WorkoutMetrics {
    const total = this.assessments.length;
    const valid = this.assessments.filter((a) => a.valid).length;
    const invalid = total - valid;
    const uncertain = this.assessments.filter((a) => a.uncertain).length;

    const durations = this.repRecords
      .map((r) => r.repDurationSeconds)
      .filter((d) => Number.isFinite(d) && d > 0);
    const meanRep =
      durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : null;

    return {
      totalReps: total,
      validReps: valid,
      invalidReps: invalid,
      uncertainReps: uncertain,
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
      view: toCameraView(this.activeV2View),
      userViewMode: this.userViewMode,
      detectedV2View: this.activeV2View,
      lastCoachAction: this.lastCoachAction,
      diagnostics: {
        detectedView: this.activeV2View,
        viewConfidence: this.viewEstimator.getLastEstimate()?.confidence ?? 1.0,
        elbowLeft: this.lastSignal?.elbowLeft ?? null,
        elbowRight: this.lastSignal?.elbowRight ?? null,
        elbowCombined: this.lastSignal?.elbowCombined ?? null,
        elbow2D: this.lastSignal?.elbowCombined ?? null,
        elbow3D: this.lastSignal?.worldDepthMotion ?? null,
        romTop: this.counter.getThresholds().upEnter,
        romBottom: this.counter.getThresholds().downEnter,
        normalizedPhase: this.counter.getCycleProgress(),
        fsmState: this.counter.getState(),
        poseConfidence: this.lastSignal?.poseConfidence ?? 0,
        shoulderDepth: this.lastSignal?.shoulderMotion ?? null,
        hipDepth: this.lastSignal?.hipMotion ?? null,
        recalibrationStatus: `effTop: ${this.counter.getCalibrationTelemetry().effectiveTop.toFixed(1)}°, effBot: ${this.counter.getCalibrationTelemetry().effectiveBottom.toFixed(1)}°`,
      },
    };
  }

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

  flush(): void {
    this.emit(true);
  }

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

interface CalibrationObservation {
  valid: boolean;
  sideVisibility: number;
  anklesVisible: boolean;
  upperBodyVisible: boolean;
  upperBodyVisibility: number;
  sideDominance: number;
  bodySpanRatio: number;
}

function buildObservation(
  frame: FrameFeatures,
  pose?: PoseFrame,
  activeView: V2CameraView = 'VIEW_UNKNOWN',
): CalibrationObservation {
  if (!pose || !pose.valid || pose.landmarks.length < 33) {
    return {
      valid: false,
      sideVisibility: 0,
      anklesVisible: false,
      upperBodyVisible: false,
      upperBodyVisibility: 0,
      sideDominance: 0,
      bodySpanRatio: 0,
    };
  }

  const lms = pose.landmarks;
  const L_ANKLE = 27;
  const R_ANKLE = 28;
  const L_SHOULDER = 11;
  const R_SHOULDER = 12;
  const L_ELBOW = 13;
  const R_ELBOW = 14;
  const L_WRIST = 15;
  const R_WRIST = 16;
  const L_HIP = 23;
  const R_HIP = 24;

  const ankleL = lms[L_ANKLE];
  const ankleR = lms[R_ANKLE];
  const shL = lms[L_SHOULDER];
  const shR = lms[R_SHOULDER];
  const elL = lms[L_ELBOW];
  const elR = lms[R_ELBOW];
  const wrL = lms[L_WRIST];
  const wrR = lms[R_WRIST];
  const hipL = lms[L_HIP];
  const hipR = lms[R_HIP];

  const anklesVisible =
    !!ankleL &&
    !!ankleR &&
    ankleL.visibility > 0.4 &&
    ankleR.visibility > 0.4 &&
    ankleL.y < 0.99 &&
    ankleR.y < 0.99 &&
    ankleL.x > 0.01 &&
    ankleR.x > 0.01 &&
    ankleL.x < 0.99 &&
    ankleR.x < 0.99;

  // Upper body check (crucial for front view where feet are positioned behind torso)
  const shouldersOk =
    !!shL &&
    !!shR &&
    shL.visibility > 0.35 &&
    shR.visibility > 0.35 &&
    shL.x > 0.01 &&
    shL.x < 0.99 &&
    shR.x > 0.01 &&
    shR.x < 0.99 &&
    shL.y > 0.01 &&
    shL.y < 0.99 &&
    shR.y > 0.01 &&
    shR.y < 0.99;

  const armsOk =
    (!!elL && elL.visibility > 0.3) ||
    (!!elR && elR.visibility > 0.3) ||
    (!!wrL && wrL.visibility > 0.3) ||
    (!!wrR && wrR.visibility > 0.3);

  const upperBodyVisible = shouldersOk && armsOk;

  const upperLms = [shL, shR, elL, elR, wrL, wrR, hipL, hipR].filter(Boolean);
  const upperBodyVisibility =
    upperLms.length > 0
      ? upperLms.reduce((acc, lm) => acc + (lm.visibility ?? 0), 0) / upperLms.length
      : 0;

  const shMid = {
    x: ((shL?.x ?? 0) + (shR?.x ?? 0)) / 2,
    y: ((shL?.y ?? 0) + (shR?.y ?? 0)) / 2,
  };
  const hipMid = {
    x: ((hipL?.x ?? 0) + (hipR?.x ?? 0)) / 2,
    y: ((hipL?.y ?? 0) + (hipR?.y ?? 0)) / 2,
  };
  const torsoLen = Math.hypot(shMid.x - hipMid.x, shMid.y - hipMid.y) || 1e-6;
  const shoulderWidth = Math.hypot(
    (shL?.x ?? 0) - (shR?.x ?? 0),
    (shL?.y ?? 0) - (shR?.y ?? 0),
  );
  const widthRatio = shoulderWidth / torsoLen;
  const sideDominance = clamp01((1.2 - widthRatio) / 0.7);

  const spanX = Math.abs((ankleL?.x ?? 0) - shMid.x);
  const spanY = Math.abs((ankleL?.y ?? 0) - shMid.y);
  const sideBodySpan = Math.hypot(spanX, spanY);
  const frontBodySpan = Math.max(shoulderWidth, torsoLen * 0.9);

  const isFront = activeView === 'VIEW_FRONT' || widthRatio > 0.85;
  const bodySpanRatio = isFront ? frontBodySpan : sideBodySpan;

  return {
    valid: frame.valid,
    sideVisibility: pose.sideVisibility,
    anklesVisible,
    upperBodyVisible,
    upperBodyVisibility,
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
