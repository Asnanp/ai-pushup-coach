/**
 * packages/form-engine/assessment.ts
 *
 * Agent 14 — FORM FEEDBACK ENGINE
 *
 * Fuses the ML classifier's verdict with deterministic geometry into a single
 * rep assessment, and — critically — decides which *specific* fault to report.
 *
 * The rule that governs this whole file: we only claim a specific fault when
 * the geometric evidence for it is actually present. The ML model outputs a
 * probability, not a diagnosis; inventing "your hips are too high" from a
 * bare P(good)=0.3 would be dishonest, and a user following that advice would
 * be fixing a problem they may not have.
 */

import type {
  FrameFeatures,
  IssueCode,
  RepAssessment,
  ScoreComponents,
} from '@ai-pushup-coach/types';
import { aggregateRepWindow } from '@ai-pushup-coach/biomechanics';
import {
  MODEL_WEIGHT,
  GEOMETRY_WEIGHT,
  alignmentScore,
  consistencyScore,
  depthScore,
  depthScoreFromPhase,
  geometryScore,
  romScore,
  romScoreFromPhase,
  tempoScore,
} from './geometry-scores';
import type { FormModel } from './model-runtime';

/**
 * Priority order for issue reporting — most actionable first.
 * (docs/FORM_SCORE.md §5)
 */
const ISSUE_PRIORITY: IssueCode[] = [
  'INCOMPLETE_DEPTH',
  'HIPS_DROPPING',
  'HIPS_TOO_HIGH',
  'BODY_NOT_STRAIGHT',
  'KNEES_BENT',
  'ELBOW_FLARE',
  'PARTIAL_RANGE',
  'TOO_FAST',
  'UNSTABLE',
];

export interface IssueEvidence {
  code: IssueCode;
  /** The measured value that triggered it, for the detail panel. */
  evidence: string;
}

/**
 * Detect geometric faults. Each rule requires its precondition to be
 * genuinely satisfied — no guessing.
 */
export function detectIssues(
  raw: Record<string, number>,
  view: 'side' | 'diagonal' | 'front',
  live?: LiveCycleEvidence,
): IssueEvidence[] {
  const found: IssueEvidence[] = [];
  const g = (k: string) => raw[k];
  const has = (k: string) => Number.isFinite(raw[k]);

  const minElbow = g('min_elbow_angle_deg');
  const blMean = g('body_line_deviation_mean');
  const blRange = g('body_line_deviation_range');
  const romElbow = g('rom_elbow_deg');
  const kneeAngle = g('knee_angle_deg_mean');
  const shoulderAngle = g('shoulder_angle_deg_mean');
  const repDur = g('rep_duration_s');
  const jitter = g('jitter_score');

  // Depth: elbow never got near 90deg — side view only.
  // Front 2D elbow often stays above 130° on a real push-up (foreshortening).
  const frontish = view === 'front' || view === 'diagonal';
  if (frontish && live && Number.isFinite(live.phaseExcursion)) {
    if (live.phaseExcursion < 0.32) {
      found.push({
        code: 'INCOMPLETE_DEPTH',
        evidence: `movement depth ${(live.phaseExcursion * 100).toFixed(0)}% of personal range`,
      });
    }
  } else if (has('min_elbow_angle_deg') && minElbow > 105) {
    found.push({
      code: 'INCOMPLETE_DEPTH',
      evidence: `deepest elbow angle ${minElbow.toFixed(0)}deg (target <=90deg)`,
    });
  }

  // Hips / body-line need a visible ankle line. Front webcam (and a bed)
  // usually does not have that, so these would be invented faults.
  if (!frontish) {
    if (has('body_line_deviation_mean') && blMean > 0.1) {
      found.push({
        code: 'HIPS_DROPPING',
        evidence: `hips ${blMean.toFixed(2)} torso-lengths below the shoulder-ankle line`,
      });
    }

    if (has('body_line_deviation_mean') && blMean < -0.1) {
      found.push({
        code: 'HIPS_TOO_HIGH',
        evidence: `hips ${Math.abs(blMean).toFixed(2)} torso-lengths above the shoulder-ankle line`,
      });
    }

    if (has('body_line_deviation_range') && blRange > 0.15) {
      found.push({
        code: 'BODY_NOT_STRAIGHT',
        evidence: `body line varied by ${blRange.toFixed(2)} torso-lengths during the rep`,
      });
    }

    if (has('knee_angle_deg_mean') && kneeAngle < 150) {
      found.push({
        code: 'KNEES_BENT',
        evidence: `average knee angle ${kneeAngle.toFixed(0)}deg`,
      });
    }
  }

  // Elbow flare is only meaningful when we can see the shoulder angle, i.e.
  // not in pure side view where the shoulder angle is foreshortened.
  if (view !== 'side' && has('shoulder_angle_deg_mean') && shoulderAngle > 75) {
    found.push({
      code: 'ELBOW_FLARE',
      evidence: `shoulder abduction ${shoulderAngle.toFixed(0)}deg`,
    });
  }

  if (!frontish && has('rom_elbow_deg') && romElbow < 30) {
    found.push({
      code: 'PARTIAL_RANGE',
      evidence: `elbow travel only ${romElbow.toFixed(0)}deg`,
    });
  }

  if (has('rep_duration_s') && repDur < 0.9) {
    found.push({
      code: 'TOO_FAST',
      evidence: `rep completed in ${repDur.toFixed(1)}s`,
    });
  }

  if (has('jitter_score') && jitter > 0.02) {
    found.push({
      code: 'UNSTABLE',
      evidence: `landmark jitter ${jitter.toFixed(3)}`,
    });
  }

  // Sort by priority so the primary issue is the most actionable one.
  return found.sort(
    (a, b) => ISSUE_PRIORITY.indexOf(a.code) - ISSUE_PRIORITY.indexOf(b.code),
  );
}

export interface LiveCycleEvidence {
  phaseExcursion: number;
  angularExcursion: number;
  depthExcursion: number;
  shoulderYTravel: number;
}

export interface AssessmentInput {
  repIndex: number;
  frames: FrameFeatures[];
  view: 'side' | 'diagonal' | 'front';
  totalFramesInWindow?: number;
  live?: LiveCycleEvidence;
}

export interface AssessmentDeps {
  model: FormModel | null;
  decisionThreshold: number;
}

/**
 * Assess one completed rep.
 *
 * Produces the label, the blended score, the component breakdown, and the
 * specific issues that the geometry actually supports.
 */
export function assessRep(
  input: AssessmentInput,
  deps: AssessmentDeps,
): RepAssessment {
  const agg = aggregateRepWindow(input.frames, input.totalFramesInWindow);

  if (!agg) {
    // Mobile / dropout: a counted cycle may lack FrameFeatures while still
    // carrying honest live excursion evidence. Grade from that rather than
    // emitting a blank "unknown" that looks like form validation failed.
    if (input.live && Number.isFinite(input.live.phaseExcursion)) {
      return liveOnlyAssessment(input.repIndex, input.view, input.live);
    }
    return unknownAssessment(input.repIndex, 'no usable pose frames in this rep');
  }

  const { raw } = agg;
  const live = input.live;
  const frontish = input.view === 'front' || input.view === 'diagonal';
  const elbowRom = raw.rom_elbow_deg;
  const elbowUnreliable = frontish && (!Number.isFinite(elbowRom) || elbowRom < 35);

  // Front webcam: 2D elbow often barely moves on a real push-up. Grade depth
  // and ROM from the fused movement cycle instead of a 90° elbow target.
  const depth = elbowUnreliable && live
    ? depthScoreFromPhase(live.phaseExcursion)
    : depthScore(raw.min_elbow_angle_deg);
  const rom = elbowUnreliable && live
    ? romScoreFromPhase(live.phaseExcursion)
    : romScore(raw.rom_elbow_deg);

  // Ankle-based body line is garbage in front view (feet off-screen / on a bed).
  const alignmentRaw = alignmentScore(raw.body_line_deviation_max_abs);
  const alignment =
    frontish && (!Number.isFinite(alignmentRaw) || alignmentRaw < 25) ? Number.NaN : alignmentRaw;

  // --- component scores ---
  const components: ScoreComponents = {
    depth,
    alignment,
    tempo: tempoScore(
      raw.rep_duration_s,
      raw.descent_duration_s,
      raw.ascent_duration_s,
    ),
    consistency: consistencyScore(
      raw.elbow_angle_std * 2, // std of angle is a proxy for velocity spread
      raw.elbow_angular_velocity_mean,
      raw.jitter_score,
    ),
    rom,
  };

  const geo = geometryScore(components);

  // --- model inference ---
  let goodProbability = NaN;
  let missingFeatureCount = 0;
  let modelScore: number | null = null;

  if (deps.model && deps.model.isReady()) {
    const res = deps.model.predict(agg.vector);
    if (res) {
      goodProbability = res.goodProbability;
      missingFeatureCount = res.missingFeatureCount;
      modelScore = 100 * res.goodProbability;
    }
  }

  const missing = missingFeatureCount > 3;
  const hasModel = modelScore !== null && !missing;

  // --- blended score (renormalised when the model is unavailable) ---
  let repScore: number;
  let scoreSource: 'model+geometry' | 'geometry-only';

  if (hasModel && Number.isFinite(geo)) {
    repScore = GEOMETRY_WEIGHT * geo + MODEL_WEIGHT * (modelScore as number);
    scoreSource = 'model+geometry';
  } else if (Number.isFinite(geo)) {
    repScore = geo;
    scoreSource = 'geometry-only';
  } else {
    repScore = NaN;
    scoreSource = 'geometry-only';
  }

  // --- label & uncertainty ---
  // Both conditions must hold for confident GOOD: model confidence AND geometric floor.
  const threshold = deps.decisionThreshold;
  const modelSaysGood = hasModel ? goodProbability >= threshold : true;
  const geometrySaysGood = !Number.isFinite(geo) || geo >= 55;

  const borderline =
    Number.isFinite(goodProbability) && Math.abs(goodProbability - threshold) < 0.08;

  const uncertain = Boolean(missing || borderline);
  let formStatus: 'GOOD' | 'BAD' | 'UNCERTAIN';
  if (uncertain) {
    formStatus = 'UNCERTAIN';
  } else if (modelSaysGood && geometrySaysGood) {
    formStatus = 'GOOD';
  } else {
    formStatus = 'BAD';
  }

  let label: RepAssessment['label'];
  let valid: boolean;

  if (missing) {
    label = 'unknown';
    valid = false;
  } else if (uncertain) {
    // An uncertain repetition may still count geometrically if geometry meets the floor.
    // We preserve user reps when camera data is borderline rather than penalizing them.
    label = geometrySaysGood ? 'good' : 'bad';
    valid = geometrySaysGood;
  } else if (modelSaysGood && geometrySaysGood) {
    label = 'good';
    valid = true;
  } else {
    label = 'bad';
    valid = false;
  }

  const confidence = Number.isFinite(goodProbability)
    ? label === 'good'
      ? goodProbability
      : 1 - goodProbability
    : 0;

  // --- issue attribution ---
  const issues = detectIssues(raw, input.view, live);
  const primaryIssue = issues.length ? issues[0].code : null;
  const secondaryIssues = issues.slice(1, 4).map((i) => i.code);

  return {
    repIndex: input.repIndex,
    label,
    formStatus,
    uncertain,
    confidence,
    goodProbability,
    valid,
    repScore,
    geometryScore: geo,
    modelScore,
    components,
    primaryIssue,
    secondaryIssues,
    scoreSource,
    borderline,
    missingFeatureCount,
  };
}

function liveOnlyAssessment(
  repIndex: number,
  view: 'side' | 'diagonal' | 'front',
  live: LiveCycleEvidence,
): RepAssessment {
  const depth = depthScoreFromPhase(live.phaseExcursion);
  const rom = romScoreFromPhase(live.phaseExcursion);
  const components: ScoreComponents = {
    depth,
    alignment: Number.NaN,
    tempo: Number.NaN,
    consistency: Number.NaN,
    rom,
  };
  const geo = geometryScore(components);
  const geometrySaysGood = Number.isFinite(geo) && geo >= 55;
  const issues = detectIssues({}, view, live);
  return {
    repIndex,
    label: geometrySaysGood ? 'good' : 'bad',
    formStatus: 'UNCERTAIN',
    uncertain: true,
    confidence: 0.45,
    goodProbability: Number.NaN,
    valid: geometrySaysGood,
    repScore: geo,
    geometryScore: geo,
    modelScore: null,
    components,
    primaryIssue: issues.length ? issues[0].code : null,
    secondaryIssues: issues.slice(1, 4).map((i) => i.code),
    scoreSource: 'geometry-only',
    borderline: true,
    missingFeatureCount: 0,
  };
}

function unknownAssessment(repIndex: number, _reason: string): RepAssessment {
  return {
    repIndex,
    label: 'unknown',
    confidence: 0,
    goodProbability: NaN,
    valid: false,
    repScore: NaN,
    geometryScore: NaN,
    modelScore: null,
    components: {
      depth: NaN,
      alignment: NaN,
      tempo: NaN,
      consistency: NaN,
      rom: NaN,
    },
    primaryIssue: 'LOW_CONFIDENCE',
    secondaryIssues: [],
    scoreSource: 'geometry-only',
    borderline: false,
    missingFeatureCount: 999,
  };
}

/**
 * Session form score = mean of per-rep scores, weighted equally regardless of
 * validity — an invalid rep still carries information about the session.
 * (docs/FORM_SCORE.md §3)
 */
export function sessionFormScore(reps: RepAssessment[]): number | null {
  const scored = reps.map((r) => r.repScore).filter(Number.isFinite);
  if (scored.length === 0) return null;
  const mean = scored.reduce((a, b) => a + b, 0) / scored.length;
  return Math.round(mean * 10) / 10;
}

export function scoreStatus(totalReps: number): 'ok' | 'provisional' | 'insufficient-data' {
  if (totalReps === 0) return 'insufficient-data';
  if (totalReps < 3) return 'provisional';
  return 'ok';
}

export function mostCommonIssue(reps: RepAssessment[]): IssueCode | null {
  const counts = new Map<IssueCode, number>();
  for (const r of reps) {
    if (r.valid) continue; // only invalid reps carry a meaningful fault
    if (!r.primaryIssue) continue;
    counts.set(r.primaryIssue, (counts.get(r.primaryIssue) ?? 0) + 1);
  }
  let best: IssueCode | null = null;
  let bestCount = 0;
  for (const [code, n] of counts) {
    if (n > bestCount) {
      best = code;
      bestCount = n;
    }
  }
  return best;
}

export function bestValidStreak(reps: RepAssessment[]): number {
  let best = 0;
  let cur = 0;
  for (const r of reps) {
    if (r.valid) {
      cur++;
      best = Math.max(best, cur);
    } else {
      cur = 0;
    }
  }
  return best;
}
