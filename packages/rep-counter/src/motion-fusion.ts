/**
 * packages/rep-counter/src/motion-fusion.ts
 *
 * Multi-signal motion evidence. The counter must survive one bad channel.
 * Front webcam: 2D elbow often weak; world-Z + centroid + shoulder-wrist
 * distance must still produce a usable descent/ascent vote.
 */

import type { MotionEvidence, RepMotionSignal, V2CameraView } from '@ai-pushup-coach/types';

export interface FusionInputs {
  signal: RepMotionSignal;
  phase: number;
  phaseVelocity: number;
  prevPhase: number;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function finiteOr(v: number | undefined, fallback = Number.NaN): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * How strongly the current frame supports TOP (0) vs BOTTOM (1) vs in-between.
 * Evidence channels are already expressed as phase-like [0,1] by the estimator;
 * this module scores agreement and magnitude rather than re-deriving phase.
 */
export function fuseMotionEvidence(
  signal: RepMotionSignal,
  elbowPhase: number,
  depthPhase: number,
  centroidPhase: number,
  distancePhase: number,
  phaseVelocity: number,
  view: V2CameraView,
): MotionEvidence {
  const left = finiteOr(signal.elbowLeft);
  const right = finiteOr(signal.elbowRight);
  const leftV = finiteOr(signal.leftVisibility, 0);
  const rightV = finiteOr(signal.rightVisibility, 0);

  let bilateralAgreement = 0.5;
  if (Number.isFinite(left) && Number.isFinite(right) && leftV >= 0.25 && rightV >= 0.25) {
    const gap = Math.abs(left - right);
    bilateralAgreement = clamp01(1 - gap / 50);
  } else if (leftV >= 0.25 || rightV >= 0.25) {
    bilateralAgreement = 0.55;
  }

  const elbowOk = Number.isFinite(elbowPhase);
  const depthOk = Number.isFinite(depthPhase);
  const centroidOk = Number.isFinite(centroidPhase);
  const distOk = Number.isFinite(distancePhase);

  const front = view === 'VIEW_FRONT';
  const side = view === 'VIEW_SIDE_LEFT' || view === 'VIEW_SIDE_RIGHT';

  const elbowEvidence = elbowOk ? (front ? 0.55 + 0.45 * elbowPhase : 0.35 + 0.65 * elbowPhase) : 0;
  const depthEvidence = depthOk ? (front ? 0.4 + 0.6 * depthPhase : 0.2 + 0.4 * depthPhase) : 0;
  const centroidEvidence = centroidOk ? 0.3 + 0.7 * centroidPhase : 0;
  const distanceEvidence = distOk ? 0.3 + 0.7 * distancePhase : 0;

  const votes: number[] = [];
  if (elbowOk) votes.push(elbowPhase);
  if (depthOk) votes.push(depthPhase);
  if (centroidOk) votes.push(centroidPhase);
  if (distOk) votes.push(distancePhase);

  let agreement = 0.4;
  if (votes.length >= 2) {
    const mean = votes.reduce((a, b) => a + b, 0) / votes.length;
    const spread = Math.sqrt(votes.reduce((a, b) => a + (b - mean) ** 2, 0) / votes.length);
    agreement = clamp01(1 - spread / 0.45);
  } else if (votes.length === 1) {
    agreement = front ? 0.55 : 0.7;
  }

  const movementMagnitude = Math.min(1, Math.abs(phaseVelocity) * 8);
  const poseC = clamp01(signal.poseConfidence);
  const channelCount = votes.length;
  const coverage = channelCount / 4;

  const phaseConfidence = clamp01(
    0.35 * poseC + 0.3 * agreement + 0.2 * bilateralAgreement + 0.15 * coverage,
  );

  const overallConfidence = clamp01(
    phaseConfidence * (0.7 + 0.3 * (side ? 1 : front ? 0.9 : 0.85)),
  );

  return {
    elbowEvidence: clamp01(elbowEvidence),
    depthEvidence: clamp01(depthEvidence),
    centroidEvidence: clamp01(centroidEvidence),
    distanceEvidence: clamp01(distanceEvidence),
    bilateralAgreement,
    motionDirection: Number.isFinite(phaseVelocity) ? Math.sign(phaseVelocity) : 0,
    movementMagnitude,
    phaseConfidence,
    overallConfidence,
  };
}

export { clamp01 };
