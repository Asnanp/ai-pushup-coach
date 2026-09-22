/**
 * packages/pose/src/pose-capability.ts
 *
 * Capability-based pose quality. Never a single global POSE GOOD / BAD.
 * Counting can continue when ankles are missing; form grading degrades
 * independently.
 */

import type { Landmark, PoseCapability } from '@ai-pushup-coach/types';

const L_SHOULDER = 11;
const R_SHOULDER = 12;
const L_ELBOW = 13;
const R_ELBOW = 14;
const L_WRIST = 15;
const R_WRIST = 16;
const L_HIP = 23;
const R_HIP = 24;
const L_ANKLE = 27;
const R_ANKLE = 28;

function vis(lm: Landmark | undefined): number {
  return lm?.visibility ?? 0;
}

function armOk(landmarks: Landmark[], sh: number, el: number, wr: number, minV: number): boolean {
  return vis(landmarks[sh]) >= minV && vis(landmarks[el]) >= minV && vis(landmarks[wr]) >= minV;
}

export function evaluatePoseCapability(landmarks: Landmark[]): PoseCapability {
  if (!landmarks || landmarks.length < 25) {
    return {
      canCountRep: false,
      canGradeDepth: false,
      canGradeAlignment: false,
      canGradeSymmetry: false,
      canGradeTempo: false,
      canFullyAssessForm: false,
    };
  }

  const leftArm = armOk(landmarks, L_SHOULDER, L_ELBOW, L_WRIST, 0.22);
  const rightArm = armOk(landmarks, R_SHOULDER, R_ELBOW, R_WRIST, 0.22);
  const shoulders =
    (vis(landmarks[L_SHOULDER]) >= 0.22 && vis(landmarks[R_SHOULDER]) >= 0.22) ||
    vis(landmarks[L_SHOULDER]) >= 0.35 ||
    vis(landmarks[R_SHOULDER]) >= 0.35;
  const hips = vis(landmarks[L_HIP]) >= 0.22 || vis(landmarks[R_HIP]) >= 0.22;
  const ankles = vis(landmarks[L_ANKLE]) >= 0.30 || vis(landmarks[R_ANKLE]) >= 0.30;

  const canCountRep = (shoulders && (leftArm || rightArm)) || leftArm || rightArm;
  const canGradeDepth = leftArm || rightArm;
  const canGradeAlignment = shoulders && hips;
  const canGradeSymmetry = leftArm && rightArm;
  const canGradeTempo = canCountRep;
  const canFullyAssessForm =
    canCountRep && canGradeDepth && canGradeAlignment && canGradeSymmetry && ankles;

  return {
    canCountRep,
    canGradeDepth,
    canGradeAlignment,
    canGradeSymmetry,
    canGradeTempo,
    canFullyAssessForm,
  };
}
