/**
 * packages/rep-counter/src/motion-calibration.ts
 *
 * Agent 5 — CALIBRATION ENGINEER
 *
 * Two-stage calibration engine:
 *   Phase A: Camera calibration (framing, distance, orientation, joint visibility)
 *   Phase B: Movement calibration ("Perform 2 normal push-ups so we can learn your movement range")
 *
 * Prevents the critical V1 standing-lockout defect by calibrating on dynamic movement
 * cycles rather than static preamble frames.
 */

import type {
  CalibrationCheck,
  CalibrationPhase,
  RepThresholds,
  TwoStageCalibrationState,
  V2CameraView,
} from '@ai-pushup-coach/types';

import {
  CausalSmoother,
  DOWN_ENTER_MAX,
  DOWN_ENTER_MIN,
  DOWN_EXIT_FRACTION,
  DOWN_FRACTION,
  FALLBACK_THRESHOLDS,
  MIN_DETECTABLE_ROM_DEG,
  MIN_FRAMES_TO_CALIBRATE,
  MedianFilter,
  UP_ENTER_MAX,
  UP_ENTER_MIN,
  UP_EXIT_FRACTION,
  UP_FRACTION,
  localExtrema,
  maskImplausibleAngle,
} from './rep-counter';

export const CALIBRATION_REPS_REQUIRED = 1;
export const MIN_CALIBRATION_ROM_DEG = 18;

export interface MotionCalibratorOptions {
  requiredReps?: number;
  minRomDeg?: number;
  view?: V2CameraView;
}

export class MotionCalibrator {
  private phase: CalibrationPhase = 'CAMERA_CHECK';
  private cameraPassed = false;
  private requiredReps: number;
  private minRomDeg: number;
  private view: V2CameraView = 'VIEW_FRONT';

  private smoother = new CausalSmoother();
  private median = new MedianFilter();

  private rawSamples: number[] = [];
  private filteredSamples: number[] = [];
  private timestamps: number[] = [];

  // Extremum tracking for dynamic calibration reps
  private cycleCount = 0;
  private inDescent = false;
  private currentCycleMax = 0;
  private currentCycleMin = 180;
  private completedRepsRom: number[] = [];

  private observedTop = 160;
  private observedBottom = 90;
  private calibratedThresholds: RepThresholds | null = null;

  constructor(opts: MotionCalibratorOptions = {}) {
    this.requiredReps = opts.requiredReps ?? CALIBRATION_REPS_REQUIRED;
    this.minRomDeg = opts.minRomDeg ?? MIN_CALIBRATION_ROM_DEG;
    if (opts.view) this.view = opts.view;
  }

  setCameraCheckPassed(passed: boolean): void {
    this.cameraPassed = passed;
    if (passed && this.phase === 'CAMERA_CHECK') {
      this.phase = 'MOVEMENT_CALIBRATION';
    } else if (!passed) {
      this.phase = 'CAMERA_CHECK';
      this.resetMovement();
    }
  }

  setView(view: V2CameraView): void {
    this.view = view;
  }

  reset(): void {
    this.phase = 'CAMERA_CHECK';
    this.cameraPassed = false;
    this.resetMovement();
  }

  private resetMovement(): void {
    this.smoother.reset();
    this.median.reset();
    this.rawSamples = [];
    this.filteredSamples = [];
    this.timestamps = [];
    this.cycleCount = 0;
    this.inDescent = false;
    this.currentCycleMax = 0;
    this.currentCycleMin = 180;
    this.completedRepsRom = [];
    this.calibratedThresholds = null;
  }

  /**
   * Feed one motion signal sample during calibration.
   * Returns updated TwoStageCalibrationState.
   */
  feed(rawAngle: number, timestamp: number): TwoStageCalibrationState {
    if (this.phase === 'CAMERA_CHECK') {
      return this.getState('Position yourself in camera view with upper body clearly visible');
    }

    const masked = maskImplausibleAngle(rawAngle);
    if (!Number.isFinite(masked)) {
      return this.getState('Keep arms visible in frame');
    }

    const smoothed = this.smoother.push(masked);
    const angle = this.median.push(smoothed);
    if (!Number.isFinite(angle)) {
      return this.getState('Keep arms visible in frame');
    }

    this.rawSamples.push(masked);
    this.filteredSamples.push(angle);
    this.timestamps.push(timestamp);

    // Track dynamic rep cycles during movement calibration
    this.trackCalibrationRep(angle);

    // Check if calibration can complete
    if (this.completedRepsRom.length >= this.requiredReps) {
      const validCycles = this.completedRepsRom.filter((rom) => rom >= this.minRomDeg);
      if (validCycles.length >= this.requiredReps) {
        this.finishCalibration();
        return this.getState('Calibration complete! Ready to workout.');
      } else {
        return this.getState('Complete a fuller push-up for calibration.');
      }
    }

    const remaining = this.requiredReps - this.completedRepsRom.length;
    if (remaining <= 0) {
      return this.getState('Calibration complete! Ready to workout.');
    }
    return this.getState(
      remaining === 1
        ? 'Do one push-up so I can learn your movement. It will count.'
        : `Perform ${remaining} push-ups so we can learn your movement range.`,
    );
  }

  private trackCalibrationRep(angle: number): void {
    if (this.currentCycleMax === 0) {
      this.currentCycleMax = angle;
      this.currentCycleMin = angle;
    }

    this.currentCycleMax = Math.max(this.currentCycleMax, angle);
    this.currentCycleMin = Math.min(this.currentCycleMin, angle);

    // Simple robust cycle detection on the calibration motion:
    // When signal drops by at least 15 deg from max -> descent started
    if (!this.inDescent && angle <= this.currentCycleMax - 14) {
      this.inDescent = true;
      this.currentCycleMin = angle;
    }
    // When signal rises by at least 14 deg from min and approaches top -> rep completed
    else if (this.inDescent && angle >= this.currentCycleMin + 14 && angle >= this.currentCycleMax - 18) {
      const repRom = this.currentCycleMax - this.currentCycleMin;
      this.completedRepsRom.push(repRom);
      this.inDescent = false;
      // Reset extrema for next rep
      this.currentCycleMax = angle;
      this.currentCycleMin = angle;
    }
  }

  private finishCalibration(): void {
    // Derive thresholds from all samples observed during the demonstrated push-ups
    const samples = this.filteredSamples;
    const { maxima, minima } = localExtrema(samples);

    let top = 160;
    let bottom = 90;

    if (maxima.length >= 2 && minima.length >= 2) {
      top = median(maxima);
      bottom = median(minima);
    } else {
      // Robust percentile fallback
      top = percentile(samples, 0.90);
      bottom = percentile(samples, 0.10);
    }

    this.observedTop = top;
    this.observedBottom = bottom;

    const span = Math.max(this.minRomDeg, top - bottom);

    // Calculate reachability-guaranteed thresholds
    let upEnter = clamp(bottom + span * UP_FRACTION, UP_ENTER_MIN, UP_ENTER_MAX);
    let upExit = clamp(bottom + span * UP_EXIT_FRACTION, upEnter - 12, upEnter - 2);
    let downEnter = clamp(bottom + span * DOWN_FRACTION, DOWN_ENTER_MIN, DOWN_ENTER_MAX);
    let downExit = clamp(bottom + span * DOWN_EXIT_FRACTION, downEnter + 2, downEnter + 15);

    // Guaranteed reachability
    const lowFloor = bottom + span * 0.12;
    const highCeiling = top - span * 0.10;
    if (downEnter > lowFloor) downEnter = lowFloor;
    if (upEnter > highCeiling) upEnter = highCeiling;

    if (!(downEnter < downExit && downExit < upExit && upExit < upEnter)) {
      downEnter = bottom + span * 0.15;
      downExit = bottom + span * 0.28;
      upExit = bottom + span * 0.65;
      upEnter = bottom + span * 0.78;
    }

    this.calibratedThresholds = {
      upEnter,
      upExit,
      downEnter,
      downExit,
      calibrated: true,
      observedMin: bottom,
      observedMax: top,
    };

    this.phase = 'READY';
  }

  getCalibratedThresholds(): RepThresholds {
    return this.calibratedThresholds ?? { ...FALLBACK_THRESHOLDS };
  }

  isReady(): boolean {
    return this.phase === 'READY' && this.calibratedThresholds !== null;
  }

  getState(prompt: string = ''): TwoStageCalibrationState {
    const rom = this.observedTop - this.observedBottom;
    return {
      phase: this.phase,
      cameraChecksPassed: this.cameraPassed,
      calibrationRepsCompleted: this.completedRepsRom.length,
      calibrationRepsRequired: this.requiredReps,
      observedTop: this.observedTop,
      observedBottom: this.observedBottom,
      effectiveRom: Number.isFinite(rom) ? rom : 0,
      feedbackPrompt: prompt,
      ready: this.isReady(),
    };
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function median(values: number[]): number {
  if (!values.length) return Number.NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function percentile(values: number[], p: number): number {
  const f = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!f.length) return NaN;
  const i = (f.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? f[lo] : f[lo] + (f[hi] - f[lo]) * (i - lo);
}
