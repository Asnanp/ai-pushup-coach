/**
 * packages/rep-counter/src/live-trace.ts
 *
 * Numerical-only live traces. Never stores RGB, camera frames, or canvas pixels.
 */

import type { LiveTraceFrame, PersonalRom, V2CameraView, V3RepState } from '@ai-pushup-coach/types';
import type { RepMotionSignal } from '@ai-pushup-coach/types';

const MAX_FRAMES = 12_000; // ~10 minutes at 20 fps

function xyz(lm: { x?: number; y?: number; z?: number; visibility?: number } | undefined) {
  return {
    x: lm?.x ?? Number.NaN,
    y: lm?.y ?? Number.NaN,
    z: lm?.z ?? Number.NaN,
    visibility: lm?.visibility ?? 0,
  };
}

export class LiveTraceRecorder {
  private frames: LiveTraceFrame[] = [];
  private enabled = true;

  setEnabled(on: boolean): void {
    this.enabled = on;
  }

  reset(): void {
    this.frames = [];
  }

  get length(): number {
    return this.frames.length;
  }

  push(frame: LiveTraceFrame): void {
    if (!this.enabled) return;
    this.frames.push(frame);
    if (this.frames.length > MAX_FRAMES) this.frames.shift();
  }

  snapshot(): LiveTraceFrame[] {
    return this.frames.slice();
  }

  exportJSON(): string {
    return JSON.stringify(
      {
        kind: 'ai-pushup-coach-live-trace',
        version: 3,
        recordedAt: new Date().toISOString(),
        frameCount: this.frames.length,
        containsVideo: false,
        containsFrames: false,
        frames: this.frames,
      },
      null,
      2,
    );
  }

  last(): LiveTraceFrame | null {
    return this.frames.length ? this.frames[this.frames.length - 1] : null;
  }
}

export function buildTraceFrame(opts: {
  signal: RepMotionSignal;
  view: V2CameraView;
  viewConfidence: number;
  phase: number;
  filteredPhase: number;
  fsmState: V3RepState;
  confidence: number;
  cycleId: number | null;
  emitted: boolean;
  rejection: string | null;
  rom: PersonalRom;
  landmarks?: { x: number; y: number; z: number; visibility: number }[];
}): LiveTraceFrame {
  const lm = opts.landmarks ?? [];
  const pick = (i: number) => xyz(lm[i]);
  return {
    timestamp: opts.signal.timestamp,
    view: opts.view,
    viewConfidence: opts.viewConfidence,
    leftShoulder: pick(11),
    leftElbow: pick(13),
    leftWrist: pick(15),
    rightShoulder: pick(12),
    rightElbow: pick(14),
    rightWrist: pick(16),
    hipCenter: {
      x: opts.signal.hipCenterX ?? Number.NaN,
      y: opts.signal.hipCenterY ?? opts.signal.hipMotion,
      z: opts.signal.hipCenterZ ?? Number.NaN,
    },
    shoulderCenter: {
      x: opts.signal.shoulderCenterX ?? Number.NaN,
      y: opts.signal.shoulderCenterY ?? opts.signal.shoulderMotion,
      z: opts.signal.shoulderCenterZ ?? Number.NaN,
    },
    leftElbow2D: opts.signal.elbowLeft2D ?? opts.signal.elbowLeft,
    rightElbow2D: opts.signal.elbowRight2D ?? opts.signal.elbowRight,
    leftElbow3D: opts.signal.elbowLeft3D ?? Number.NaN,
    rightElbow3D: opts.signal.elbowRight3D ?? Number.NaN,
    bilateralFusedAngle: opts.signal.elbowCombined,
    shoulderImageMovement: opts.signal.shoulderMotion,
    shoulderWorldZ: opts.signal.shoulderWorldZ ?? opts.signal.worldDepthMotion,
    torsoWorldZ: opts.signal.torsoWorldZ ?? Number.NaN,
    poseConfidence: opts.signal.poseConfidence,
    rawRepSignal: opts.phase,
    filteredRepSignal: opts.filteredPhase,
    normalizedMovementPhase: opts.filteredPhase,
    fsmState: opts.fsmState,
    counterConfidence: opts.confidence,
    candidateCycleId: opts.cycleId,
    repEventEmitted: opts.emitted,
    rejectionReason: opts.rejection,
    calibration: opts.rom,
    adaptiveRom: opts.rom,
  };
}
