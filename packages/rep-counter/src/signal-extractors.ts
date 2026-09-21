/**
 * packages/rep-counter/src/signal-extractors.ts
 *
 * Agent 4 — REP COUNTER ENGINEER & Agent 2 — FRONT-VIEW RESEARCH ENGINEER
 *
 * View-specific signal extraction behind a unified RepMotionSignal contract.
 * - SideRepSignalExtractor: Dominant side elbow angle + sagittal alignment
 * - FrontRepSignalExtractor: Bilateral arm fusion (left + right) + vertical centroid motion + depth
 * - DiagonalRepSignalExtractor: Perspective-weighted bilateral fusion
 */

import type { Landmark, RepMotionSignal, V2CameraView } from '@ai-pushup-coach/types';
import {
  L_ANKLE,
  L_ELBOW,
  L_HIP,
  L_SHOULDER,
  L_WRIST,
  R_ANKLE,
  R_ELBOW,
  R_HIP,
  R_SHOULDER,
  R_WRIST,
  angleDeg,
  toVec,
  vlen,
  vmid,
  vsub,
  type Vec2,
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

/**
 * 3D angle between joints in world landmark space (meters) if available.
 */
function angle3D(a: Landmark, b: Landmark, c: Landmark): number {
  const ba = { x: a.x - b.x, y: a.y - b.y, z: (a.z ?? 0) - (b.z ?? 0) };
  const bc = { x: c.x - b.x, y: c.y - b.y, z: (c.z ?? 0) - (c.z ?? 0) };

  const normBA = Math.hypot(ba.x, ba.y, ba.z);
  const normBC = Math.hypot(bc.x, bc.y, bc.z);
  if (normBA < 1e-6 || normBC < 1e-6) return Number.NaN;

  const dot = ba.x * bc.x + ba.y * bc.y + ba.z * bc.z;
  const cos = Math.max(-1, Math.min(1, dot / (normBA * normBC)));
  return (Math.acos(cos) * 180) / Math.PI;
}

// ---------------------------------------------------------------------------
// SIDE VIEW EXTRACTOR
// ---------------------------------------------------------------------------

export class SideRepSignalExtractor implements IRepSignalExtractor {
  constructor(private readonly dominantSide: 'left' | 'right' = 'left') {}

  extract(landmarks: Landmark[], timestamp: number, worldLandmarks?: Landmark[]): RepMotionSignal {
    if (!landmarks || landmarks.length < 25) {
      return this.emptySignal(timestamp, this.dominantSide === 'left' ? 'VIEW_SIDE_LEFT' : 'VIEW_SIDE_RIGHT');
    }

    const isLeft = this.dominantSide === 'left';
    const shIdx = isLeft ? L_SHOULDER : R_SHOULDER;
    const elIdx = isLeft ? L_ELBOW : R_ELBOW;
    const wrIdx = isLeft ? L_WRIST : R_WRIST;
    const hpIdx = isLeft ? L_HIP : R_HIP;

    const oShIdx = isLeft ? R_SHOULDER : L_SHOULDER;
    const oElIdx = isLeft ? R_ELBOW : L_ELBOW;
    const oWrIdx = isLeft ? R_WRIST : L_WRIST;

    const sh = landmarks[shIdx];
    const el = landmarks[elIdx];
    const wr = landmarks[wrIdx];
    const hp = landmarks[hpIdx];

    const oSh = landmarks[oShIdx];
    const oEl = landmarks[oElIdx];
    const oWr = landmarks[oWrIdx];

    const elAngle = maskImplausibleAngle(angleDeg(toVec(sh), toVec(el), toVec(wr)));
    const oppAngle = maskImplausibleAngle(angleDeg(toVec(oSh), toVec(oEl), toVec(oWr)));

    const leftAngle = isLeft ? elAngle : oppAngle;
    const rightAngle = isLeft ? oppAngle : elAngle;

    const vis = Math.min(sh.visibility ?? 1, el.visibility ?? 1, wr.visibility ?? 1);

    return {
      timestamp,
      phaseEvidence: elAngle,
      elbowLeft: leftAngle,
      elbowRight: rightAngle,
      elbowCombined: elAngle,
      shoulderMotion: sh.y,
      hipMotion: hp.y,
      worldDepthMotion: sh.z ?? 0,
      poseConfidence: vis,
      view: isLeft ? 'VIEW_SIDE_LEFT' : 'VIEW_SIDE_RIGHT',
    };
  }

  reset(): void {}

  private emptySignal(t: number, view: V2CameraView): RepMotionSignal {
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
    };
  }
}

// ---------------------------------------------------------------------------
// FRONT VIEW EXTRACTOR (BILATERAL + DEPTH)
// ---------------------------------------------------------------------------

export class FrontRepSignalExtractor implements IRepSignalExtractor {
  private baselineShoulderY: number | null = null;
  private baselineTorsoHeight: number | null = null;

  extract(landmarks: Landmark[], timestamp: number, worldLandmarks?: Landmark[]): RepMotionSignal {
    if (!landmarks || landmarks.length < 25) {
      return this.emptySignal(timestamp);
    }

    const ls = landmarks[L_SHOULDER];
    const rs = landmarks[R_SHOULDER];
    const le = landmarks[L_ELBOW];
    const re = landmarks[R_ELBOW];
    const lw = landmarks[L_WRIST];
    const rw = landmarks[R_WRIST];
    const lh = landmarks[L_HIP];
    const rh = landmarks[R_HIP];

    // Compute left and right 2D elbow angles
    let leftAngle2D = angleDeg(toVec(ls), toVec(le), toVec(lw));
    let rightAngle2D = angleDeg(toVec(rs), toVec(re), toVec(rw));

    // Also check world landmarks if available (in 3D, immune to foreshortening)
    if (worldLandmarks && worldLandmarks.length >= 25) {
      const wLs = worldLandmarks[L_SHOULDER];
      const wRs = worldLandmarks[R_SHOULDER];
      const wLe = worldLandmarks[L_ELBOW];
      const wRe = worldLandmarks[R_ELBOW];
      const wLw = worldLandmarks[L_WRIST];
      const wRw = worldLandmarks[R_WRIST];

      const left3D = angle3D(wLs, wLe, wLw);
      const right3D = angle3D(wRs, wRe, wRw);

      if (Number.isFinite(left3D) && left3D >= ELBOW_ANGLE_MIN_PLAUSIBLE && left3D <= ELBOW_ANGLE_MAX_PLAUSIBLE) {
        // Blend 2D and 3D with priority on 3D stability
        leftAngle2D = 0.6 * left3D + 0.4 * leftAngle2D;
      }
      if (Number.isFinite(right3D) && right3D >= ELBOW_ANGLE_MIN_PLAUSIBLE && right3D <= ELBOW_ANGLE_MAX_PLAUSIBLE) {
        rightAngle2D = 0.6 * right3D + 0.4 * rightAngle2D;
      }
    }

    const leftAngle = maskImplausibleAngle(leftAngle2D);
    const rightAngle = maskImplausibleAngle(rightAngle2D);

    const leftVis = Math.min(ls.visibility ?? 1, le.visibility ?? 1, lw.visibility ?? 1);
    const rightVis = Math.min(rs.visibility ?? 1, re.visibility ?? 1, rw.visibility ?? 1);

    // Bilateral combination: weighted by visibility and plausibility
    let combinedElbow = Number.NaN;
    const leftOk = Number.isFinite(leftAngle) && leftVis >= 0.25;
    const rightOk = Number.isFinite(rightAngle) && rightVis >= 0.25;

    if (leftOk && rightOk) {
      // Both arms visible: weighted average
      const totalVis = leftVis + rightVis;
      combinedElbow = (leftAngle * leftVis + rightAngle * rightVis) / totalVis;
    } else if (leftOk) {
      combinedElbow = leftAngle;
    } else if (rightOk) {
      combinedElbow = rightAngle;
    }

    // Midline vertical translation
    const shMid = vmid(toVec(ls), toVec(rs));
    const hipMid = vmid(toVec(lh), toVec(rh));
    const torsoHeight = Math.max(1e-4, vlen(vsub(shMid, hipMid)));

    if (this.baselineTorsoHeight === null || this.baselineShoulderY === null) {
      this.baselineTorsoHeight = torsoHeight;
      this.baselineShoulderY = shMid.y;
    }

    // In front view, when going down, shoulder mid moves down in the camera frame (increasing Y)
    // Normalized shoulder descent relative to torso length
    const shoulderDescentRel = (shMid.y - this.baselineShoulderY) / this.baselineTorsoHeight;

    // Depth displacement in Z
    const shoulderDepth = ((ls.z ?? 0) + (rs.z ?? 0)) / 2;

    // Phase evidence combines bilateral elbow flexion with vertical motion
    let phaseEvidence = combinedElbow;
    if (Number.isFinite(combinedElbow) && Number.isFinite(shoulderDescentRel)) {
      // Map vertical descent (typically 0.0 to 0.4 of torso height) to equivalent elbow angle deduction
      // 0.35 torso descent roughly equals full 90 deg drop (160 -> 70 deg)
      const verticalEquivalentAngle = Math.max(50, Math.min(175, 160 - shoulderDescentRel * 250));
      // Front phase evidence blends bilateral elbow with vertical centroid
      phaseEvidence = 0.75 * combinedElbow + 0.25 * verticalEquivalentAngle;
    }

    const poseConfidence = (leftVis + rightVis) / 2;

    return {
      timestamp,
      phaseEvidence,
      elbowLeft: leftAngle,
      elbowRight: rightAngle,
      elbowCombined: combinedElbow,
      shoulderMotion: shMid.y,
      hipMotion: hipMid.y,
      worldDepthMotion: shoulderDepth,
      poseConfidence,
      view: 'VIEW_FRONT',
    };
  }

  reset(): void {
    this.baselineShoulderY = null;
    this.baselineTorsoHeight = null;
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
      view: 'VIEW_FRONT',
    };
  }
}

// ---------------------------------------------------------------------------
// DIAGONAL VIEW EXTRACTOR
// ---------------------------------------------------------------------------

export class DiagonalRepSignalExtractor implements IRepSignalExtractor {
  constructor(private readonly nearSide: 'left' | 'right' = 'left') {}

  extract(landmarks: Landmark[], timestamp: number, worldLandmarks?: Landmark[]): RepMotionSignal {
    if (!landmarks || landmarks.length < 25) {
      return this.emptySignal(timestamp);
    }

    const isNearLeft = this.nearSide === 'left';
    const nearSh = isNearLeft ? L_SHOULDER : R_SHOULDER;
    const nearEl = isNearLeft ? L_ELBOW : R_ELBOW;
    const nearWr = isNearLeft ? L_WRIST : R_WRIST;

    const farSh = isNearLeft ? R_SHOULDER : L_SHOULDER;
    const farEl = isNearLeft ? R_ELBOW : L_ELBOW;
    const farWr = isNearLeft ? R_WRIST : L_WRIST;

    const nearAngle = maskImplausibleAngle(
      angleDeg(toVec(landmarks[nearSh]), toVec(landmarks[nearEl]), toVec(landmarks[nearWr])),
    );
    const farAngle = maskImplausibleAngle(
      angleDeg(toVec(landmarks[farSh]), toVec(landmarks[farEl]), toVec(landmarks[farWr])),
    );

    const nearVis = Math.min(
      landmarks[nearSh].visibility ?? 1,
      landmarks[nearEl].visibility ?? 1,
      landmarks[nearWr].visibility ?? 1,
    );
    const farVis = Math.min(
      landmarks[farSh].visibility ?? 1,
      landmarks[farEl].visibility ?? 1,
      landmarks[farWr].visibility ?? 1,
    );

    let combined = nearAngle;
    if (Number.isFinite(nearAngle) && Number.isFinite(farAngle)) {
      // 75% near arm, 25% far arm
      combined = 0.75 * nearAngle + 0.25 * farAngle;
    } else if (Number.isFinite(farAngle)) {
      combined = farAngle;
    }

    const shMid = vmid(toVec(landmarks[L_SHOULDER]), toVec(landmarks[R_SHOULDER]));
    const hipMid = vmid(toVec(landmarks[L_HIP]), toVec(landmarks[R_HIP]));

    const view: V2CameraView = isNearLeft ? 'VIEW_DIAGONAL_LEFT' : 'VIEW_DIAGONAL_RIGHT';

    return {
      timestamp,
      phaseEvidence: combined,
      elbowLeft: isNearLeft ? nearAngle : farAngle,
      elbowRight: isNearLeft ? farAngle : nearAngle,
      elbowCombined: combined,
      shoulderMotion: shMid.y,
      hipMotion: hipMid.y,
      worldDepthMotion: (landmarks[L_SHOULDER].z ?? 0 + (landmarks[R_SHOULDER].z ?? 0)) / 2,
      poseConfidence: (nearVis + farVis) / 2,
      view,
    };
  }

  reset(): void {}

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
      view: 'VIEW_DIAGONAL_LEFT',
    };
  }
}

/**
 * Factory to create the appropriate signal extractor for a view.
 */
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
