/**
 * packages/rep-counter/src/signal-extractors.ts
 *
 * View-specific signal extraction. V3 fills a rich RepMotionSignal so the
 * fusion engine can survive a bad 2D elbow (typical front webcam).
 *
 * Confirmed live-path bugs this file used to carry:
 *   1. 3D angle z-component computed as (c.z - c.z) === 0
 *   2. diagonal worldDepthMotion operator precedence (z ?? 0 + other)
 */

import type { Landmark, RepMotionSignal, V2CameraView } from '@ai-pushup-coach/types';
import {
  L_ELBOW,
  L_HIP,
  L_SHOULDER,
  L_WRIST,
  R_ELBOW,
  R_HIP,
  R_SHOULDER,
  R_WRIST,
  angleDeg,
  angleDeg3D,
  toVec,
  vlen,
  vmid,
  vsub,
} from '@ai-pushup-coach/biomechanics';

import {
  ELBOW_ANGLE_MAX_PLAUSIBLE,
  ELBOW_ANGLE_MIN_PLAUSIBLE,
  maskImplausibleAngle,
} from './rep-counter';

export interface IRepSignalExtractor {
  extract(landmarks: Landmark[], timestamp: number, worldLandmarks?: Landmark[]): RepMotionSignal;
  reset(): void;
}

function vis(lm: Landmark | undefined): number {
  return lm?.visibility ?? 0;
}

function emptySignal(t: number, view: V2CameraView): RepMotionSignal {
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
    view,
    elbowLeft2D: Number.NaN,
    elbowRight2D: Number.NaN,
    elbowLeft3D: Number.NaN,
    elbowRight3D: Number.NaN,
    shoulderCenterX: Number.NaN,
    shoulderCenterY: Number.NaN,
    shoulderCenterZ: Number.NaN,
    hipCenterX: Number.NaN,
    hipCenterY: Number.NaN,
    hipCenterZ: Number.NaN,
    shoulderWorldZ: Number.NaN,
    torsoWorldZ: Number.NaN,
    shoulderWristDist: Number.NaN,
    centroidY: Number.NaN,
    leftVisibility: 0,
    rightVisibility: 0,
  };
}

function combineElbows(
  left: number,
  right: number,
  leftVis: number,
  rightVis: number,
): number {
  // 0.18: mobile front cams often report 0.18–0.28 on the working arm.
  const leftOk = Number.isFinite(left) && leftVis >= 0.18;
  const rightOk = Number.isFinite(right) && rightVis >= 0.18;
  if (leftOk && rightOk) {
    // Phone cameras often lose the far elbow behind the torso. A low-confidence
    // arm that disagrees sharply must not pull the counting angle halfway down.
    if (Math.abs(left - right) > 35 && Math.max(leftVis, rightVis) >= 0.35 &&
        Math.max(leftVis, rightVis) >= Math.min(leftVis, rightVis) * 1.5) {
      return leftVis > rightVis ? left : right;
    }
    const total = leftVis + rightVis;
    return (left * leftVis + right * rightVis) / total;
  }
  if (leftOk) return left;
  if (rightOk) return right;
  return Number.NaN;
}

function dist3(a: Landmark, b: Landmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));
}

/**
 * Shared landmark → rich signal. View only changes which arm is primary for
 * the V2 `phaseEvidence` scalar (kept so existing replay tests still compile).
 */
export function extractRichMotion(
  landmarks: Landmark[],
  timestamp: number,
  view: V2CameraView,
  worldLandmarks?: Landmark[],
  baseline?: { shoulderY: number; torsoHeight: number },
): RepMotionSignal {
  if (!landmarks || landmarks.length < 25) return emptySignal(timestamp, view);

  const ls = landmarks[L_SHOULDER];
  const rs = landmarks[R_SHOULDER];
  const le = landmarks[L_ELBOW];
  const re = landmarks[R_ELBOW];
  const lw = landmarks[L_WRIST];
  const rw = landmarks[R_WRIST];
  const lh = landmarks[L_HIP];
  const rh = landmarks[R_HIP];

  const left2D = maskImplausibleAngle(angleDeg(toVec(ls), toVec(le), toVec(lw)));
  const right2D = maskImplausibleAngle(angleDeg(toVec(rs), toVec(re), toVec(rw)));

  let left3D = Number.NaN;
  let right3D = Number.NaN;
  const world = worldLandmarks && worldLandmarks.length >= 25 ? worldLandmarks : null;
  const src3 = world ?? landmarks;
  left3D = maskImplausibleAngle(angleDeg3D(src3[L_SHOULDER], src3[L_ELBOW], src3[L_WRIST]));
  right3D = maskImplausibleAngle(angleDeg3D(src3[R_SHOULDER], src3[R_ELBOW], src3[R_WRIST]));

  // World coordinates can hallucinate an occluded wrist. When their angle
  // strongly conflicts with the image, retain the image signal for counting.
  const blend = (a2: number, a3: number): number => {
    if (Number.isFinite(a3) && a3 >= ELBOW_ANGLE_MIN_PLAUSIBLE && a3 <= ELBOW_ANGLE_MAX_PLAUSIBLE) {
      if (Number.isFinite(a2)) return Math.abs(a3 - a2) > 40 ? a2 : 0.55 * a3 + 0.45 * a2;
      return a3;
    }
    return a2;
  };

  const leftAngle = blend(left2D, left3D);
  const rightAngle = blend(right2D, right3D);

  const leftVis = Math.min(vis(ls), vis(le), vis(lw));
  const rightVis = Math.min(vis(rs), vis(re), vis(rw));
  const combinedElbow = combineElbows(leftAngle, rightAngle, leftVis, rightVis);

  const shMid = vmid(toVec(ls), toVec(rs));
  const hipMid = vmid(toVec(lh), toVec(rh));
  const torsoHeight = Math.max(1e-4, vlen(vsub(shMid, hipMid)));

  const shoulderZ = ((ls.z ?? 0) + (rs.z ?? 0)) / 2;
  const hipZ = ((lh.z ?? 0) + (rh.z ?? 0)) / 2;
  const worldShZ = world
    ? ((world[L_SHOULDER].z ?? 0) + (world[R_SHOULDER].z ?? 0)) / 2
    : shoulderZ;
  const worldHipZ = world
    ? ((world[L_HIP].z ?? 0) + (world[R_HIP].z ?? 0)) / 2
    : hipZ;
  const torsoWorldZ = worldShZ - worldHipZ;

  const distL = dist3(ls, lw);
  const distR = dist3(rs, rw);
  let shoulderWristDist = Number.NaN;
  if (leftVis >= 0.25 && rightVis >= 0.25) shoulderWristDist = (distL + distR) / 2;
  else if (leftVis >= 0.25) shoulderWristDist = distL;
  else if (rightVis >= 0.25) shoulderWristDist = distR;

  const centroidY = (shMid.y + hipMid.y) / 2;

  let phaseEvidence = combinedElbow;
  if (Number.isFinite(combinedElbow) && baseline) {
    const shoulderDescentRel = (shMid.y - baseline.shoulderY) / Math.max(baseline.torsoHeight, torsoHeight);
    const verticalEquivalentAngle = Math.max(50, Math.min(175, 160 - shoulderDescentRel * 250));
    const isFront = view === 'VIEW_FRONT';
    const elbowW = isFront ? 0.7 : 0.85;
    phaseEvidence = elbowW * combinedElbow + (1 - elbowW) * verticalEquivalentAngle;
  }

  return {
    timestamp,
    phaseEvidence,
    elbowLeft: leftAngle,
    elbowRight: rightAngle,
    elbowCombined: combinedElbow,
    shoulderMotion: shMid.y,
    hipMotion: hipMid.y,
    worldDepthMotion: worldShZ,
    poseConfidence: (leftVis + rightVis) / 2,
    view,
    elbowLeft2D: left2D,
    elbowRight2D: right2D,
    elbowLeft3D: left3D,
    elbowRight3D: right3D,
    shoulderCenterX: shMid.x,
    shoulderCenterY: shMid.y,
    shoulderCenterZ: shoulderZ,
    hipCenterX: hipMid.x,
    hipCenterY: hipMid.y,
    hipCenterZ: hipZ,
    shoulderWorldZ: worldShZ,
    torsoWorldZ,
    shoulderWristDist,
    centroidY,
    leftVisibility: leftVis,
    rightVisibility: rightVis,
  };
}

export class SideRepSignalExtractor implements IRepSignalExtractor {
  constructor(private readonly dominantSide: 'left' | 'right' = 'left') {}

  extract(landmarks: Landmark[], timestamp: number, worldLandmarks?: Landmark[]): RepMotionSignal {
    const view: V2CameraView = this.dominantSide === 'left' ? 'VIEW_SIDE_LEFT' : 'VIEW_SIDE_RIGHT';
    const signal = extractRichMotion(landmarks, timestamp, view, worldLandmarks);
    const primary = this.dominantSide === 'left' ? signal.elbowLeft : signal.elbowRight;
    if (Number.isFinite(primary)) signal.phaseEvidence = primary;
    return signal;
  }

  reset(): void {}
}

export class FrontRepSignalExtractor implements IRepSignalExtractor {
  private baselineShoulderY: number | null = null;
  private baselineTorsoHeight: number | null = null;

  extract(landmarks: Landmark[], timestamp: number, worldLandmarks?: Landmark[]): RepMotionSignal {
    if (!landmarks || landmarks.length < 25) {
      return extractRichMotion(landmarks, timestamp, 'VIEW_FRONT', worldLandmarks);
    }
    const ls = landmarks[L_SHOULDER];
    const rs = landmarks[R_SHOULDER];
    const lh = landmarks[L_HIP];
    const rh = landmarks[R_HIP];
    const shMid = vmid(toVec(ls), toVec(rs));
    const hipMid = vmid(toVec(lh), toVec(rh));
    const torsoHeight = Math.max(1e-4, vlen(vsub(shMid, hipMid)));
    if (this.baselineTorsoHeight === null || this.baselineShoulderY === null) {
      this.baselineTorsoHeight = torsoHeight;
      this.baselineShoulderY = shMid.y;
    }
    return extractRichMotion(landmarks, timestamp, 'VIEW_FRONT', worldLandmarks, {
      shoulderY: this.baselineShoulderY,
      torsoHeight: this.baselineTorsoHeight,
    });
  }

  reset(): void {
    this.baselineShoulderY = null;
    this.baselineTorsoHeight = null;
  }
}

export class DiagonalRepSignalExtractor implements IRepSignalExtractor {
  constructor(private readonly nearSide: 'left' | 'right' = 'left') {}

  extract(landmarks: Landmark[], timestamp: number, worldLandmarks?: Landmark[]): RepMotionSignal {
    const view: V2CameraView = this.nearSide === 'left' ? 'VIEW_DIAGONAL_LEFT' : 'VIEW_DIAGONAL_RIGHT';
    const signal = extractRichMotion(landmarks, timestamp, view, worldLandmarks);
    const near = this.nearSide === 'left' ? signal.elbowLeft : signal.elbowRight;
    const far = this.nearSide === 'left' ? signal.elbowRight : signal.elbowLeft;
    if (Number.isFinite(near) && Number.isFinite(far)) {
      signal.phaseEvidence = 0.75 * near + 0.25 * far;
      signal.elbowCombined = signal.phaseEvidence;
    } else if (Number.isFinite(near)) {
      signal.phaseEvidence = near;
    } else if (Number.isFinite(far)) {
      signal.phaseEvidence = far;
    }
    return signal;
  }

  reset(): void {}
}

export function createSignalExtractor(view: V2CameraView): IRepSignalExtractor {
  switch (view) {
    case 'VIEW_FRONT':
      return new FrontRepSignalExtractor();
    case 'VIEW_SIDE_LEFT':
      return new SideRepSignalExtractor('left');
    case 'VIEW_SIDE_RIGHT':
      return new SideRepSignalExtractor('right');
    case 'VIEW_DIAGONAL_LEFT':
      return new DiagonalRepSignalExtractor('left');
    case 'VIEW_DIAGONAL_RIGHT':
      return new DiagonalRepSignalExtractor('right');
    case 'VIEW_UNKNOWN':
    default:
      return new FrontRepSignalExtractor();
  }
}
