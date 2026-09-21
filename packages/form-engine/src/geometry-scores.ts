/**
 * packages/form-engine/geometry-scores.ts
 *
 * Agent 14 — FORM FEEDBACK ENGINE
 *
 * Deterministic component scores. Implements docs/FORM_SCORE.md exactly.
 *
 * Every number produced here is traceable to a measured feature. Nothing is
 * randomised, and no score is invented when the data is missing.
 */

import type { ScoreComponents } from '@ai-pushup-coach/types';

// Thresholds — must match ml/src/features.py and docs/FORM_SCORE.md
export const DEPTH_TARGET_DEG = 90;
export const DEPTH_TOP_DEG = 160;
export const ALIGNMENT_TOLERANCE = 0.18;
export const ALIGNMENT_FREE = 0.05;
export const TEMPO_IDEAL_MIN = 1.2;
export const TEMPO_IDEAL_MAX = 4.0;

function clamp(v: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Depth: how close the chest got to the floor, via minimum elbow flexion.
 * 90deg -> 100 (full depth), 125deg -> ~64 (the most common fault), 160deg -> 0.
 */
export function depthScore(minElbowAngle: number): number {
  if (!Number.isFinite(minElbowAngle)) return NaN;
  const span = DEPTH_TOP_DEG - DEPTH_TARGET_DEG;
  return clamp((100 * (DEPTH_TOP_DEG - minElbowAngle)) / span);
}

/**
 * Alignment: how straight the shoulder-hip-ankle line stayed.
 * Uses worst absolute deviation across the rep — a body that is straight for
 * most of the rep but collapses at the bottom is not well aligned.
 */
export function alignmentScore(bodyLineDeviationMaxAbs: number): number {
  if (!Number.isFinite(bodyLineDeviationMaxAbs)) return NaN;
  const span = ALIGNMENT_TOLERANCE - ALIGNMENT_FREE;
  if (span <= 0) return NaN;
  return clamp(100 * (1 - (bodyLineDeviationMaxAbs - ALIGNMENT_FREE) / span));
}

/**
 * Tempo: control. Two terms — cadence plausibility and descent/ascent symmetry.
 * The symmetry term catches dive-and-collapse reps that a pure duration
 * measure would score as fine.
 */
export function tempoScore(
  repDurationS: number,
  descentDurationS: number,
  ascentDurationS: number,
): number {
  if (!Number.isFinite(repDurationS) || repDurationS <= 0) return NaN;

  let cadence: number;
  if (repDurationS < TEMPO_IDEAL_MIN) {
    cadence = 100 * (repDurationS / TEMPO_IDEAL_MIN);
  } else if (repDurationS > TEMPO_IDEAL_MAX) {
    cadence = 100 * (TEMPO_IDEAL_MAX / repDurationS);
  } else {
    cadence = 100;
  }
  cadence = clamp(cadence);

  let symmetry = 100;
  if (Number.isFinite(descentDurationS) && Number.isFinite(ascentDurationS)) {
    const asymmetry = Math.abs(descentDurationS - ascentDurationS) / repDurationS;
    symmetry = clamp(100 * (1 - asymmetry / 0.6));
  }

  return 0.5 * cadence + 0.5 * symmetry;
}

/**
 * Consistency: stability of movement (not speed).
 * Derived from the coefficient of variation of elbow angular velocity plus a
 * jitter penalty.
 */
export function consistencyScore(
  elbowAngularVelStd: number,
  elbowAngularVelMean: number,
  jitterScore: number,
): number {
  if (!Number.isFinite(elbowAngularVelStd)) return NaN;

  const denom = Math.max(Math.abs(elbowAngularVelMean), 1e-6);
  const cv = elbowAngularVelStd / denom;
  const stability = clamp(100 * (1 - cv / 1.5));

  const jitterPenalty = clamp(100 * clamp(jitterScore / 0.02, 0, 1));

  return 0.7 * stability + 0.3 * (100 - jitterPenalty);
}

/**
 * Range of motion: guards against reps that barely move but still cross the
 * state-machine thresholds.
 */
export function romScore(romElbowDeg: number): number {
  if (!Number.isFinite(romElbowDeg)) return NaN;
  return clamp((100 * (romElbowDeg - 25)) / (70 - 25));
}

/** Weighting for the geometry half of the rep score (docs/FORM_SCORE.md §2). */
export const GEOMETRY_WEIGHTS = {
  depth: 0.3,
  alignment: 0.3,
  tempo: 0.2,
  consistency: 0.1,
  rom: 0.1,
} as const;

/**
 * Blend components into a single geometry score.
 *
 * Missing components are dropped and the remaining weights renormalised,
 * rather than treating NaN as zero. Scoring a rep 0 for a component we could
 * not measure would be fabricating a measurement.
 */
export function geometryScore(components: ScoreComponents): number {
  let total = 0;
  let weightSum = 0;

  for (const key of Object.keys(GEOMETRY_WEIGHTS) as (keyof typeof GEOMETRY_WEIGHTS)[]) {
    const value = components[key];
    if (!Number.isFinite(value)) continue;
    total += value * GEOMETRY_WEIGHTS[key];
    weightSum += GEOMETRY_WEIGHTS[key];
  }

  if (weightSum === 0) return NaN;
  return total / weightSum;
}

export const MODEL_WEIGHT = 0.35;
export const GEOMETRY_WEIGHT = 0.65;
