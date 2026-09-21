/**
 * packages/form-engine/src/detectors.ts
 *
 * Agent 12 — GEOMETRIC FORM ENGINEER
 *
 * Deterministic issue detectors as mandated by V2 Section 23:
 * - DepthDetector
 * - BodyLineDetector
 * - HipPikeDetector
 * - HipSagDetector
 * - LockoutDetector
 * - ElbowSymmetryDetector
 * - TempoDetector
 * - PoseQualityDetector
 *
 * Each detector produces a structured GeometryIssueResult:
 * {
 *   issueCode,
 *   severity,     // 0 (mild) to 1.0 (severe)
 *   confidence,   // 0 to 1.0
 *   measurements, // key numerical values
 *   evidence      // human-readable proof string
 * }
 */

import type { IssueCode } from '@ai-pushup-coach/types';

export interface GeometryIssueResult {
  issueCode: IssueCode;
  severity: number;
  confidence: number;
  measurements: Record<string, number>;
  evidence: string;
}

export interface DetectorContext {
  view?: 'side' | 'diagonal' | 'front';
  leftElbowAngle?: number;
  rightElbowAngle?: number;
}

/** 1. DepthDetector: checks bottom depth achieved */
export class DepthDetector {
  detect(raw: Record<string, number>, ctx?: DetectorContext): GeometryIssueResult | null {
    const minElbow = raw.min_elbow_angle_deg;
    if (!Number.isFinite(minElbow)) return null;

    // Target depth is 90 deg. Normal tolerance up to 105 deg.
    if (minElbow > 105) {
      const severity = Math.min(1.0, Math.max(0.1, (minElbow - 105) / 45));
      return {
        issueCode: 'INCOMPLETE_DEPTH',
        severity: Number(severity.toFixed(2)),
        confidence: 0.95,
        measurements: {
          minElbowAngleDeg: minElbow,
          achievedRomRatio: raw.depth_ratio ?? 0,
        },
        evidence: `deepest elbow angle ${minElbow.toFixed(0)}° (target ≤90°)`,
      };
    }
    return null;
  }
}

/** 2. BodyLineDetector: checks spine/torso stability through the repetition */
export class BodyLineDetector {
  detect(raw: Record<string, number>, ctx?: DetectorContext): GeometryIssueResult | null {
    const blRange = raw.body_line_deviation_range;
    if (!Number.isFinite(blRange)) return null;

    if (blRange > 0.15) {
      const severity = Math.min(1.0, Math.max(0.2, (blRange - 0.15) / 0.35));
      return {
        issueCode: 'BODY_NOT_STRAIGHT',
        severity: Number(severity.toFixed(2)),
        confidence: 0.90,
        measurements: {
          bodyLineRangeTorsoRatio: blRange,
          bodyLineStd: raw.body_line_deviation_std ?? 0,
        },
        evidence: `body line broke down by ${blRange.toFixed(2)} torso-lengths`,
      };
    }
    return null;
  }
}

/** 3. HipPikeDetector: checks if hips rise excessively above the shoulder-ankle line */
export class HipPikeDetector {
  detect(raw: Record<string, number>, ctx?: DetectorContext): GeometryIssueResult | null {
    const blMean = raw.body_line_deviation_mean;
    if (!Number.isFinite(blMean)) return null;

    // Negative deviation indicates hips above line (piked)
    if (blMean < -0.10) {
      const pikeDist = Math.abs(blMean);
      const severity = Math.min(1.0, Math.max(0.2, (pikeDist - 0.10) / 0.25));
      return {
        issueCode: 'HIPS_TOO_HIGH',
        severity: Number(severity.toFixed(2)),
        confidence: 0.92,
        measurements: {
          hipOffsetTorsoRatio: pikeDist,
        },
        evidence: `hips piked ${pikeDist.toFixed(2)} torso-lengths above body line`,
      };
    }
    return null;
  }
}

/** 4. HipSagDetector: checks if hips drop toward the floor */
export class HipSagDetector {
  detect(raw: Record<string, number>, ctx?: DetectorContext): GeometryIssueResult | null {
    const blMean = raw.body_line_deviation_mean;
    if (!Number.isFinite(blMean)) return null;

    // Positive deviation indicates hips sagging below line
    if (blMean > 0.10) {
      const severity = Math.min(1.0, Math.max(0.2, (blMean - 0.10) / 0.25));
      return {
        issueCode: 'HIPS_DROPPING',
        severity: Number(severity.toFixed(2)),
        confidence: 0.92,
        measurements: {
          hipOffsetTorsoRatio: blMean,
        },
        evidence: `hips sagging ${blMean.toFixed(2)} torso-lengths below body line`,
      };
    }
    return null;
  }
}

/** 5. LockoutDetector: checks extension at top of push-up */
export class LockoutDetector {
  detect(raw: Record<string, number>, ctx?: DetectorContext): GeometryIssueResult | null {
    const maxElbow = raw.elbow_angle_deg_max;
    if (!Number.isFinite(maxElbow)) return null;

    if (maxElbow < 145) {
      const severity = Math.min(1.0, Math.max(0.2, (155 - maxElbow) / 30));
      return {
        issueCode: 'PARTIAL_RANGE',
        severity: Number(severity.toFixed(2)),
        confidence: 0.88,
        measurements: {
          lockoutElbowAngleDeg: maxElbow,
          romDeg: raw.rom_elbow_deg ?? 0,
        },
        evidence: `incomplete arm lockout (top extension only reached ${maxElbow.toFixed(0)}°)`,
      };
    }
    return null;
  }
}

/** 6. ElbowSymmetryDetector: checks bilateral arm balance in front view */
export class ElbowSymmetryDetector {
  detect(raw: Record<string, number>, ctx?: DetectorContext): GeometryIssueResult | null {
    // Check ctx first, then raw features
    const left = ctx?.leftElbowAngle ?? raw.elbow_angle_deg_mean;
    const right = ctx?.rightElbowAngle ?? raw.elbow_angle_opposite_deg_mean;

    if (!Number.isFinite(left) || !Number.isFinite(right)) return null;

    const diff = Math.abs(left - right);
    if (diff > 25) {
      const severity = Math.min(1.0, Math.max(0.2, (diff - 25) / 35));
      return {
        issueCode: 'BODY_NOT_STRAIGHT',
        severity: Number(severity.toFixed(2)),
        confidence: 0.85,
        measurements: {
          elbowAsymmetryDeg: diff,
          leftElbowDeg: left,
          rightElbowDeg: right,
        },
        evidence: `arm asymmetry: ${diff.toFixed(0)}° difference between left and right arms`,
      };
    }
    return null;
  }
}

/** 7. TempoDetector: checks rep pacing, rushing, or hesitation */
export class TempoDetector {
  detect(raw: Record<string, number>, ctx?: DetectorContext): GeometryIssueResult | null {
    const duration = raw.rep_duration_s;
    if (!Number.isFinite(duration)) return null;

    if (duration < 0.9) {
      return {
        issueCode: 'TOO_FAST',
        severity: Number(Math.min(1.0, (0.9 - duration) / 0.5).toFixed(2)),
        confidence: 0.95,
        measurements: { repDurationS: duration },
        evidence: `rep completed too fast (${duration.toFixed(1)}s)`,
      };
    }

    const ratio = raw.descent_ascent_ratio;
    if (Number.isFinite(ratio) && (ratio > 4.0 || ratio < 0.25)) {
      return {
        issueCode: 'UNSTABLE',
        severity: 0.4,
        confidence: 0.80,
        measurements: { descentAscentRatio: ratio, repDurationS: duration },
        evidence: `erratic rep pacing (descent-to-ascent ratio ${ratio.toFixed(1)})`,
      };
    }

    return null;
  }
}

/** 8. PoseQualityDetector: verifies tracking certainty */
export class PoseQualityDetector {
  detect(raw: Record<string, number>, ctx?: DetectorContext): GeometryIssueResult | null {
    const vis = raw.mean_visibility;
    const gap = raw.tracking_gap_ratio;

    if (Number.isFinite(vis) && vis < 0.45) {
      return {
        issueCode: 'LOW_CONFIDENCE',
        severity: Number(Math.min(1.0, (0.45 - vis) / 0.3).toFixed(2)),
        confidence: 0.95,
        measurements: { meanVisibility: vis },
        evidence: `body partially occluded or out of frame (visibility ${(vis * 100).toFixed(0)}%)`,
      };
    }

    if (Number.isFinite(gap) && gap > 0.35) {
      return {
        issueCode: 'LOW_CONFIDENCE',
        severity: Number(Math.min(1.0, (gap - 0.35) / 0.4).toFixed(2)),
        confidence: 0.95,
        measurements: { trackingGapRatio: gap },
        evidence: `${(gap * 100).toFixed(0)}% of frames lost pose tracking`,
      };
    }

    return null;
  }
}

/** Composite registry that runs all 8 detectors and returns sorted issues */
export function runAllDetectors(
  raw: Record<string, number>,
  ctx?: DetectorContext,
): GeometryIssueResult[] {
  const detectors = [
    new DepthDetector(),
    new BodyLineDetector(),
    new HipPikeDetector(),
    new HipSagDetector(),
    new LockoutDetector(),
    new ElbowSymmetryDetector(),
    new TempoDetector(),
    new PoseQualityDetector(),
  ];

  const results: GeometryIssueResult[] = [];
  for (const d of detectors) {
    const res = d.detect(raw, ctx);
    if (res) results.push(res);
  }

  // Sort by severity descending
  return results.sort((a, b) => b.severity - a.severity);
}
