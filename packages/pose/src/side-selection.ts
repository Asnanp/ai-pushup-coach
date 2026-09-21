/**
 * packages/pose/side-selection.ts
 *
 * Which side of the body do we trust?
 *
 * Measured on the actual dataset (good/side/subject_001, frame 100):
 *   visible side visibility  : 0.98 - 1.00
 *   occluded side visibility : 0.18 - 0.42
 *
 * That separation is large and reliable, so visibility is a sound
 * discriminator. Averaging both sides — the naive approach — would mix fully
 * occluded joints into every angle we compute.
 *
 * See docs/POSE_SCHEMA.md §0.1 and §5.
 */

import type { Landmark } from '@ai-pushup-coach/types';

const L_SHOULDER = 11;
const R_SHOULDER = 12;
const L_ELBOW = 13;
const R_ELBOW = 14;
const L_WRIST = 15;
const R_WRIST = 16;
const L_HIP = 23;
const R_HIP = 24;
const L_KNEE = 25;
const R_KNEE = 26;
const L_ANKLE = 27;
const R_ANKLE = 28;

export const LEFT_SIDE = [L_SHOULDER, L_ELBOW, L_WRIST, L_HIP, L_KNEE, L_ANKLE];
export const RIGHT_SIDE = [R_SHOULDER, R_ELBOW, R_WRIST, R_HIP, R_KNEE, R_ANKLE];

export interface SideVisibility {
  left: number;
  right: number;
}

export function meanVisibility(landmarks: Landmark[], indices: number[]): number {
  let sum = 0;
  let n = 0;
  for (const i of indices) {
    const lm = landmarks[i];
    if (lm) {
      sum += lm.visibility;
      n++;
    }
  }
  return n === 0 ? 0 : sum / n;
}

export function computeSideVisibility(landmarks: Landmark[]): SideVisibility {
  const fullLeft = meanVisibility(landmarks, LEFT_SIDE);
  const fullRight = meanVisibility(landmarks, RIGHT_SIDE);
  const upperLeft = meanVisibility(landmarks, [L_SHOULDER, L_ELBOW, L_WRIST, L_HIP]);
  const upperRight = meanVisibility(landmarks, [R_SHOULDER, R_ELBOW, R_WRIST, R_HIP]);
  return {
    left: Math.max(fullLeft, upperLeft * 0.9),
    right: Math.max(fullRight, upperRight * 0.9),
  };
}

export interface SideChoice {
  side: 'left' | 'right';
  score: number;
  otherScore: number;
  switched: boolean;
}

/**
 * Choose the active side, with stickiness.
 *
 * Switching sides mid-rep would create a discontinuous joint-angle signal and
 * break the rep state machine, so we only switch when the other side is
 * *clearly* better by `margin`.
 */
export function chooseActiveSide(
  landmarks: Landmark[],
  current: 'left' | 'right' | null,
  vis: SideVisibility,
  margin = 0.15,
): SideChoice {
  const fresh = (): SideChoice => {
    const side = vis.left >= vis.right ? 'left' : 'right';
    return {
      side,
      score: side === 'left' ? vis.left : vis.right,
      otherScore: side === 'left' ? vis.right : vis.left,
      switched: false,
    };
  };

  if (current === null) return fresh();

  const curScore = current === 'left' ? vis.left : vis.right;
  const otherScore = current === 'left' ? vis.right : vis.left;
  const otherSide = current === 'left' ? 'right' : 'left';

  if (otherScore > curScore + margin) {
    return { side: otherSide, score: otherScore, otherScore: curScore, switched: true };
  }

  return { side: current, score: curScore, otherScore, switched: false };
}

/**
 * Indices of the joints used by the active side, in the canonical order
 * (shoulder, elbow, wrist, hip, knee, ankle).
 */
export function activeSideIndices(side: 'left' | 'right'): number[] {
  return side === 'left' ? LEFT_SIDE : RIGHT_SIDE;
}
