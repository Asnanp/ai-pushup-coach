import { describe, expect, it } from 'vitest';

import type { FrameFeatures, IssueCode, RepAssessment } from '@ai-pushup-coach/types';
import {
  alignmentScore,
  assessRep,
  bestValidStreak,
  consistencyScore,
  depthScore,
  detectIssues,
  geometryScore,
  mostCommonIssue,
  romScore,
  scoreStatus,
  sessionFormScore,
  tempoScore,
} from '@ai-pushup-coach/form-engine';

function feat(
  elbowAngle: number,
  timestamp: number,
  overrides: Partial<FrameFeatures> = {},
): FrameFeatures {
  return {
    valid: true,
    side: 'left',
    elbowAngle,
    elbowAngleOpposite: elbowAngle,
    shoulderAngle: 40,
    hipAngle: 170,
    kneeAngle: 170,
    ankleAngle: 100,
    bodyLineDeviation: 0.02,
    shoulderHipAnkleAngle: 178,
    torsoSlope: 0,
    hipHeightRel: 0.1,
    shoulderHeightRel: 0,
    shoulderElbowHeightDelta: -0.05,
    shoulderAnkleHeightDelta: 0.4,
    meanVisibility: 0.95,
    minVisibility: 0.9,
    jitter: 0.005,
    timestamp,
    ...overrides,
  };
}

/** One complete rep: top -> minElbow -> top. */
function repWindow(minElbow: number, n = 25, overrides: Partial<FrameFeatures> = {}): FrameFeatures[] {
  const top = 168;
  const frames: FrameFeatures[] = [];
  for (let i = 0; i < n; i++) {
    const frac = i / (n - 1);
    const angle =
      frac < 0.5
        ? top + (minElbow - top) * (frac / 0.5)
        : minElbow + (top - minElbow) * ((frac - 0.5) / 0.5);
    frames.push(feat(angle, i / 15, overrides));
  }
  return frames;
}

function assessment(overrides: Partial<RepAssessment> = {}): RepAssessment {
  return {
    repIndex: 1,
    label: 'good',
    confidence: 1,
    goodProbability: 1,
    valid: true,
    repScore: 80,
    geometryScore: 80,
    modelScore: null,
    components: { depth: 80, alignment: 80, tempo: 80, consistency: 80, rom: 80 },
    primaryIssue: null,
    secondaryIssues: [],
    scoreSource: 'geometry-only',
    borderline: false,
    missingFeatureCount: 0,
    ...overrides,
  };
}

describe('geometry component scores', () => {
  it('depthScore maps full depth to 100 and the top position to 0', () => {
    expect(depthScore(90)).toBe(100);
    expect(depthScore(160)).toBe(0);
    expect(depthScore(125)).toBeCloseTo(50, 3);
    expect(depthScore(60)).toBe(100); // clamped
    expect(depthScore(200)).toBe(0); // clamped
    expect(Number.isNaN(depthScore(Number.NaN))).toBe(true);
  });

  it('alignmentScore is 100 inside the free band and 0 past tolerance', () => {
    expect(alignmentScore(0)).toBe(100);
    expect(alignmentScore(0.05)).toBe(100);
    expect(alignmentScore(0.18)).toBeCloseTo(0, 6);
    expect(alignmentScore(0.4)).toBe(0);
    expect(Number.isNaN(alignmentScore(Number.NaN))).toBe(true);
  });

  it('tempoScore rewards the ideal cadence and penalises dive-and-collapse', () => {
    expect(tempoScore(2, 1, 1)).toBe(100);
    expect(tempoScore(2, 0, 2)).toBeCloseTo(50, 6); // fully asymmetric
    expect(tempoScore(0.6, 0.3, 0.3)).toBeCloseTo(75, 6); // cadence halved
    expect(tempoScore(8, 4, 4)).toBeCloseTo(75, 6); // slow cadence halved
    expect(Number.isNaN(tempoScore(0, 0, 0))).toBe(true);
    expect(Number.isNaN(tempoScore(Number.NaN, 1, 1))).toBe(true);
  });

  it('consistencyScore drops as velocity spread grows and as jitter rises', () => {
    expect(consistencyScore(0, 100, 0)).toBeCloseTo(100, 6);
    expect(consistencyScore(150, 100, 0)).toBeCloseTo(30, 6);
    expect(consistencyScore(0, 100, 0.02)).toBeCloseTo(70, 6);
    expect(Number.isNaN(consistencyScore(Number.NaN, 100, 0))).toBe(true);
  });

  it('romScore scales between the minimum and target travel', () => {
    expect(romScore(25)).toBe(0);
    expect(romScore(70)).toBe(100);
    expect(romScore(95)).toBe(100);
    expect(romScore(10)).toBe(0);
    expect(Number.isNaN(romScore(Number.NaN))).toBe(true);
  });

  it('geometryScore renormalises around missing components instead of zeroing them', () => {
    const all = { depth: 100, alignment: 0, tempo: 50, consistency: 50, rom: 50 };
    expect(geometryScore(all)).toBeCloseTo(0.3 * 100 + 0.3 * 0 + 0.2 * 50 + 0.1 * 50 + 0.1 * 50, 6);

    // Only depth is measurable: the score must be the depth score, not 30.
    expect(
      geometryScore({
        depth: 100,
        alignment: Number.NaN,
        tempo: Number.NaN,
        consistency: Number.NaN,
        rom: Number.NaN,
      }),
    ).toBe(100);

    expect(
      geometryScore({
        depth: Number.NaN,
        alignment: Number.NaN,
        tempo: Number.NaN,
        consistency: Number.NaN,
        rom: Number.NaN,
      }),
    ).toBe(Number.NaN);
  });
});

describe('detectIssues', () => {
  it('reports nothing when there is no evidence', () => {
    expect(detectIssues({}, 'side')).toEqual([]);
  });

  it('orders issues by actionability, not detection order', () => {
    const found = detectIssues(
      { min_elbow_angle_deg: 120, knee_angle_deg_mean: 120, rom_elbow_deg: 20 },
      'side',
    );
    expect(found.map((f) => f.code)).toEqual(['INCOMPLETE_DEPTH', 'KNEES_BENT', 'PARTIAL_RANGE']);
  });

  it('only claims elbow flare when the shoulder angle is visible', () => {
    const raw = { shoulder_angle_deg_mean: 80 };
    expect(detectIssues(raw, 'side')).toEqual([]);
    expect(detectIssues(raw, 'front').map((f) => f.code)).toContain('ELBOW_FLARE');
    expect(detectIssues(raw, 'diagonal').map((f) => f.code)).toContain('ELBOW_FLARE');
  });

  it('distinguishes hips dropping from hips piked up', () => {
    expect(detectIssues({ body_line_deviation_mean: 0.2 }, 'side').map((f) => f.code)).toEqual([
      'HIPS_DROPPING',
    ]);
    expect(detectIssues({ body_line_deviation_mean: -0.2 }, 'side').map((f) => f.code)).toEqual([
      'HIPS_TOO_HIGH',
    ]);
  });

  it('treats each threshold as strict', () => {
    expect(detectIssues({ min_elbow_angle_deg: 105 }, 'side')).toEqual([]);
    expect(detectIssues({ min_elbow_angle_deg: 105.1 }, 'side').map((f) => f.code)).toEqual([
      'INCOMPLETE_DEPTH',
    ]);
    expect(detectIssues({ knee_angle_deg_mean: 150 }, 'side')).toEqual([]);
    expect(detectIssues({ knee_angle_deg_mean: 149.9 }, 'side').map((f) => f.code)).toEqual([
      'KNEES_BENT',
    ]);
    expect(detectIssues({ jitter_score: 0.02 }, 'side')).toEqual([]);
    expect(detectIssues({ jitter_score: 0.0201 }, 'side').map((f) => f.code)).toEqual(['UNSTABLE']);
    expect(detectIssues({ body_line_deviation_mean: 0.1 }, 'side')).toEqual([]);
    expect(detectIssues({ rep_duration_s: 0.9 }, 'side')).toEqual([]);
    expect(detectIssues({ rep_duration_s: 0.89 }, 'side').map((f) => f.code)).toEqual(['TOO_FAST']);
  });

  it('quotes the measurement in the evidence string', () => {
    const [issue] = detectIssues({ min_elbow_angle_deg: 128.4 }, 'side');
    expect(issue.code).toBe('INCOMPLETE_DEPTH');
    expect(issue.evidence).toContain('128');
    expect(issue.evidence.length).toBeGreaterThan(0);
  });

  it('does not call a real front-camera push-up shallow just because 2D elbow stayed high', () => {
    const found = detectIssues(
      { min_elbow_angle_deg: 148, rom_elbow_deg: 12, knee_angle_deg_mean: 120 },
      'front',
      { phaseExcursion: 0.62, angularExcursion: 12, depthExcursion: 0.08, shoulderYTravel: 0.12 },
    );
    expect(found.map((f) => f.code)).not.toContain('INCOMPLETE_DEPTH');
    expect(found.map((f) => f.code)).not.toContain('KNEES_BENT');
    expect(found.map((f) => f.code)).not.toContain('PARTIAL_RANGE');
  });
});

describe('assessRep', () => {
  it('scores a well-executed rep from geometry alone when no model is loaded', () => {
    const result = assessRep(
      { repIndex: 1, frames: repWindow(95), view: 'side', totalFramesInWindow: 25 },
      { model: null, decisionThreshold: 0.5 },
    );

    expect(result.label).toBe('good');
    expect(result.valid).toBe(true);
    expect(result.scoreSource).toBe('geometry-only');
    expect(result.modelScore).toBeNull();
    expect(Number.isNaN(result.goodProbability)).toBe(true);
    expect(result.geometryScore).toBeGreaterThan(80);
    expect(result.repScore).toBeCloseTo(result.geometryScore, 10);
    expect(result.components.depth).toBeCloseTo(92.857, 2);
    expect(result.primaryIssue).toBeNull();
    expect(result.secondaryIssues).toEqual([]);
    expect(result.borderline).toBe(false);
  });

  it('marks a shallow, sagging, fast rep invalid and names the worst fault first', () => {
    const result = assessRep(
      {
        repIndex: 2,
        frames: repWindow(130, 8, { bodyLineDeviation: 0.3, kneeAngle: 120, jitter: 0.05 }),
        view: 'side',
        totalFramesInWindow: 8,
      },
      { model: null, decisionThreshold: 0.5 },
    );

    expect(result.label).toBe('bad');
    expect(result.valid).toBe(false);
    expect(result.geometryScore).toBeLessThan(55);
    expect(result.primaryIssue).toBe('INCOMPLETE_DEPTH');
    expect(result.secondaryIssues).toContain('HIPS_DROPPING');
    expect(result.secondaryIssues).toContain('KNEES_BENT');
  });

  it('counts a front-view cycle as valid when fused depth is real even if 2D elbow barely moved', () => {
    const frames = repWindow(150, 25, { bodyLineDeviation: 0.4, kneeAngle: 100 });
    const result = assessRep(
      {
        repIndex: 1,
        frames,
        view: 'front',
        totalFramesInWindow: 25,
        live: {
          phaseExcursion: 0.7,
          angularExcursion: 14,
          depthExcursion: 0.1,
          shoulderYTravel: 0.14,
        },
      },
      { model: null, decisionThreshold: 0.5 },
    );
    expect(result.valid).toBe(true);
    expect(result.label).toBe('good');
    expect(result.components.depth).toBeGreaterThan(70);
    expect(result.components.rom).toBeGreaterThan(70);
    expect(result.primaryIssue).not.toBe('INCOMPLETE_DEPTH');
  });

  it('reports unknown rather than guessing when no pose frames are usable', () => {
    const frames = repWindow(95).map((f) => ({ ...f, valid: false }));
    const result = assessRep(
      { repIndex: 1, frames, view: 'side' },
      { model: null, decisionThreshold: 0.5 },
    );

    expect(result.label).toBe('unknown');
    expect(result.valid).toBe(false);
    expect(result.primaryIssue).toBe('LOW_CONFIDENCE');
    expect(Number.isNaN(result.repScore)).toBe(true);
    expect(result.missingFeatureCount).toBe(999);
    expect(result.secondaryIssues).toEqual([]);
  });
});

describe('session aggregation', () => {
  it('sessionFormScore averages measurable reps and refuses to invent a score', () => {
    expect(sessionFormScore([])).toBeNull();
    expect(sessionFormScore([assessment({ repScore: Number.NaN })])).toBeNull();
    expect(sessionFormScore([assessment({ repScore: 80 }), assessment({ repScore: 90 })])).toBe(85);
    expect(
      sessionFormScore([
        assessment({ repScore: 80 }),
        assessment({ repScore: Number.NaN }),
        assessment({ repScore: 90 }),
      ]),
    ).toBe(85);
    expect(sessionFormScore([assessment({ repScore: 1 }), assessment({ repScore: 2 }), assessment({ repScore: 2 })])).toBe(
      1.7,
    );
  });

  it('scoreStatus reflects how many reps back the score', () => {
    expect(scoreStatus(0)).toBe('insufficient-data');
    expect(scoreStatus(1)).toBe('provisional');
    expect(scoreStatus(2)).toBe('provisional');
    expect(scoreStatus(3)).toBe('ok');
    expect(scoreStatus(50)).toBe('ok');
  });

  it('mostCommonIssue only considers invalid reps and picks the most frequent', () => {
    expect(mostCommonIssue([])).toBeNull();
    expect(
      mostCommonIssue([assessment({ valid: true, primaryIssue: 'TOO_FAST' as IssueCode })]),
    ).toBeNull();
    expect(
      mostCommonIssue([
        assessment({ valid: false, primaryIssue: 'INCOMPLETE_DEPTH' }),
        assessment({ valid: false, primaryIssue: 'INCOMPLETE_DEPTH' }),
        assessment({ valid: false, primaryIssue: 'KNEES_BENT' }),
      ]),
    ).toBe('INCOMPLETE_DEPTH');
    // Reps with no attributed issue cannot win.
    expect(
      mostCommonIssue([
        assessment({ valid: false, primaryIssue: null }),
        assessment({ valid: false, primaryIssue: 'UNSTABLE' }),
      ]),
    ).toBe('UNSTABLE');
  });

  it('bestValidStreak finds the longest unbroken run of valid reps', () => {
    expect(bestValidStreak([])).toBe(0);
    expect(bestValidStreak([assessment({ valid: false })])).toBe(0);
    expect(
      bestValidStreak([
        assessment({ valid: true }),
        assessment({ valid: true }),
        assessment({ valid: false }),
        assessment({ valid: true }),
        assessment({ valid: true }),
        assessment({ valid: true }),
      ]),
    ).toBe(3);
  });
});
