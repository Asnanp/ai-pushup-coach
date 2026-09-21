import { describe, expect, it } from 'vitest';

import type { Landmark, PoseFrame } from '@ai-pushup-coach/types';
import {
  FEATURE_NAMES,
  N_FEATURES,
  aggregateRepWindow,
  extractFrameFeatures,
  type ExtractContext,
} from '@ai-pushup-coach/biomechanics';

function makeLandmarks(): Landmark[] {
  const lm = (x: number, y: number, visibility = 1): Landmark => ({ x, y, z: 0, visibility });
  const lms = Array.from({ length: 33 }, () => lm(0.5, 0.5));
  lms[11] = lm(0.49, 0.5);
  lms[12] = lm(0.51, 0.5);
  lms[13] = lm(0.49, 0.6);
  lms[14] = lm(0.51, 0.6);
  lms[15] = lm(0.58, 0.6);
  lms[16] = lm(0.58, 0.6);
  lms[23] = lm(0.49, 0.65);
  lms[24] = lm(0.51, 0.65);
  lms[25] = lm(0.49, 0.75);
  lms[26] = lm(0.51, 0.75);
  lms[27] = lm(0.2, 0.85);
  lms[28] = lm(0.22, 0.85);
  lms[29] = lm(0.2, 0.9);
  lms[30] = lm(0.22, 0.9);
  return lms;
}

function pose(timestamp: number, landmarks = makeLandmarks()): PoseFrame {
  return { timestamp, landmarks, side: 'left', valid: true, sideVisibility: 0.9 };
}

describe('extractFrameFeatures', () => {
  it('derives finite geometry from a tracked pose', () => {
    const ctx: ExtractContext = { prevNormalized: null };
    const f = extractFrameFeatures(pose(1.5), ctx);

    expect(f.valid).toBe(true);
    expect(f.timestamp).toBe(1.5);
    expect(f.side).toBe('left');
    // Shoulder (0.49,0.5), elbow (0.49,0.6), wrist (0.58,0.6) -> a right angle.
    expect(f.elbowAngle).toBeCloseTo(90, 6);
    expect(Number.isFinite(f.bodyLineDeviation)).toBe(true);
    expect(f.meanVisibility).toBeCloseTo(1, 6);
    expect(f.minVisibility).toBeCloseTo(1, 6);
  });

  it('returns a NaN frame when the pose is not valid or is incomplete', () => {
    const ctx: ExtractContext = { prevNormalized: null };
    const invalid = extractFrameFeatures({ ...pose(1), valid: false }, ctx);
    expect(invalid.valid).toBe(false);
    expect(Number.isNaN(invalid.elbowAngle)).toBe(true);
    expect(invalid.meanVisibility).toBe(0);

    const short = extractFrameFeatures(pose(2, makeLandmarks().slice(0, 20)), ctx);
    expect(short.valid).toBe(false);
    expect(Number.isNaN(short.elbowAngle)).toBe(true);
  });

  it('reports zero jitter when there is no previous frame to compare against', () => {
    const f = extractFrameFeatures(pose(1), { prevNormalized: null });
    expect(f.jitter).toBe(0);
  });

  it.fails('measures inter-frame jitter from the previous normalised pose', () => {
    /*
     * `jitter` is inert in BOTH implementations, and deliberately left that way.
     *
     * `ExtractContext.prevNormalized` is read here but never written anywhere in
     * the TypeScript app. The Python reference has the same hole: in
     * ml/scripts/extract_pose_features.py, `prev_norm` is initialised to None
     * (line 128) and passed to every frame (line 168) without ever being
     * reassigned, so `prev_normalized` is None for the whole dataset.
     *
     * The consequence is that `jitter` is 0 for every frame, so `jitter_score`
     * is a constant 0 in the training data AND in the browser. `jitter_max`,
     * `jitter_mean` and `jitter_std` are three of the seven capture-quality
     * features that were excluded from the model for acting as a subject
     * identity proxy, which is consistent with them carrying no signal.
     *
     * Populating prevNormalized on the TypeScript side alone would therefore be
     * a REGRESSION, not a fix: the model was trained with jitter_score pinned at
     * 0, so feeding it real values at inference time shifts the feature
     * distribution away from training. Making jitter meaningful requires fixing
     * the offline extractor, re-running feature extraction over all 144 videos,
     * retraining, and re-exporting — a pipeline change, not a patch.
     *
     * This test stays failing to keep the limitation visible and to stop someone
     * "fixing" the browser in isolation.
     */
    const ctx: ExtractContext = { prevNormalized: null };
    extractFrameFeatures(pose(0), ctx);

    const moved = makeLandmarks().map((lm, i) => (i >= 11 && i <= 30 ? { ...lm, x: lm.x + 0.01 } : lm));
    const second = extractFrameFeatures(pose(0.05, moved), ctx);

    expect(second.jitter).toBeGreaterThan(0);
  });
});

describe('aggregateRepWindow', () => {
  function sweep(minElbow = 95, n = 25) {
    const top = 168;
    const frames = [];
    for (let i = 0; i < n; i++) {
      const frac = i / (n - 1);
      const angle =
        frac < 0.5
          ? top + (minElbow - top) * (frac / 0.5)
          : minElbow + (top - minElbow) * ((frac - 0.5) / 0.5);
      frames.push({ ...extractFrameFeatures(pose(i / 15), { prevNormalized: null }), elbowAngle: angle });
    }
    return frames;
  }

  it('returns null when no frame is usable', () => {
    expect(aggregateRepWindow([])).toBeNull();
    expect(
      aggregateRepWindow(sweep().map((f) => ({ ...f, valid: false }))),
    ).toBeNull();
  });

  it('computes range of motion, depth, and duration from the window', () => {
    const frames = sweep(95, 25);
    const agg = aggregateRepWindow(frames, frames.length);
    expect(agg).not.toBeNull();

    expect(agg?.raw.min_elbow_angle_deg).toBeCloseTo(95, 6);
    expect(agg?.raw.rom_elbow_deg).toBeCloseTo(168 - 95, 6);
    expect(agg?.raw.rep_duration_s).toBeCloseTo(24 / 15, 6);
    expect(agg?.raw.tracking_gap_ratio).toBeCloseTo(0, 6);
    expect(agg?.vector).toHaveLength(N_FEATURES);
    expect(agg?.vector[FEATURE_NAMES.indexOf('min_elbow_angle_deg')]).toBeCloseTo(95, 6);
  });

  it('reports the share of dropped frames as tracking_gap_ratio', () => {
    const frames = sweep(95, 25);
    const halfInvalid = frames.map((f, i) => (i < 5 ? { ...f, valid: false } : f));
    const agg = aggregateRepWindow(halfInvalid, halfInvalid.length);
    expect(agg?.raw.tracking_gap_ratio).toBeCloseTo(5 / 25, 6);
  });
});
