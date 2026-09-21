/**
 * packages/biomechanics/geometry.ts
 *
 * Agent 7 — BIOMECHANICS / FEATURE ENGINEER (runtime)
 *
 * TypeScript mirror of ml/src/features.py.
 *
 * THIS FILE MUST STAY IN SYNC WITH THE PYTHON IMPLEMENTATION.
 * If they diverge, the model is trained on features the app never produces,
 * and every prediction becomes meaningless. The parity test
 * (tests/feature-parity.test.ts) exists specifically to catch that.
 */

import type { Landmark } from '@ai-pushup-coach/types';

export const NOSE = 0;
export const L_SHOULDER = 11;
export const R_SHOULDER = 12;
export const L_ELBOW = 13;
export const R_ELBOW = 14;
export const L_WRIST = 15;
export const R_WRIST = 16;
export const L_HIP = 23;
export const R_HIP = 24;
export const L_KNEE = 25;
export const R_KNEE = 26;
export const L_ANKLE = 27;
export const R_ANKLE = 28;
export const L_FOOT = 31;
export const R_FOOT = 32;

export interface Vec2 {
  x: number;
  y: number;
}

export function vsub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}
export function vadd(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}
export function vscale(a: Vec2, s: number): Vec2 {
  return { x: a.x * s, y: a.y * s };
}
export function vmid(a: Vec2, b: Vec2): Vec2 {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
export function vlen(a: Vec2): number {
  return Math.hypot(a.x, a.y);
}
export function vdot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

/**
 * Angle at vertex `b`, in degrees.
 * Returns NaN for degenerate (zero-length) limbs rather than throwing —
 * a NaN propagates cleanly into the "invalid frame" path, an exception
 * would kill the rAF loop.
 */
export function angleDeg(a: Vec2, b: Vec2, c: Vec2): number {
  const ba = vsub(a, b);
  const bc = vsub(c, b);
  const nba = vlen(ba);
  const nbc = vlen(bc);
  if (nba < 1e-9 || nbc < 1e-9) return NaN;
  const cos = vdot(ba, bc) / (nba * nbc);
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}

export function toVec(lm: Landmark): Vec2 {
  return { x: lm.x, y: lm.y };
}

/**
 * Perpendicular offset of `hip` from the shoulder->ankle line, with a
 * consistent sign.
 *
 * Sign convention (must match Python):
 *   positive -> hips below the line (sagging)
 *   negative -> hips above the line (piked)
 */
export function signedBodyLineDeviation(
  shoulderMid: Vec2,
  hipMid: Vec2,
  ankleMid: Vec2,
): number {
  const ab = vsub(ankleMid, shoulderMid);
  const norm = vlen(ab);
  if (norm < 1e-9) return NaN;
  const ap = vsub(hipMid, shoulderMid);
  // 2D cross product: ab.x * ap.y - ab.y * ap.x
  const cross = ab.x * ap.y - ab.y * ap.x;
  return cross / norm;
}
