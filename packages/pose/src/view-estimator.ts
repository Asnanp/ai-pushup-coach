/**
 * packages/pose/src/view-estimator.ts
 *
 * Agent 3 — VIEW-DETECTION ENGINEER
 *
 * Robust camera orientation estimation with temporal hysteresis and manual override.
 * Supports:
 *   - VIEW_UNKNOWN
 *   - VIEW_FRONT
 *   - VIEW_SIDE_LEFT
 *   - VIEW_SIDE_RIGHT
 *   - VIEW_DIAGONAL_LEFT
 *   - VIEW_DIAGONAL_RIGHT
 *
 * Exposes temporal smoothing (rolling window voting) and post-calibration locking.
 */

import type {
  CameraView,
  Landmark,
  UserViewMode,
  V2CameraView,
  ViewEstimate,
  ViewEvidence,
} from '@ai-pushup-coach/types';

const L_SHOULDER = 11;
const R_SHOULDER = 12;
const L_ELBOW = 13;
const R_ELBOW = 14;
const L_WRIST = 15;
const R_WRIST = 16;
const L_HIP = 23;
const R_HIP = 24;

export const DEFAULT_VIEW_HISTORY_SIZE = 15;

export interface ViewEstimatorOptions {
  historySize?: number;
  manualMode?: UserViewMode;
}

export class ViewEstimator {
  private historySize: number;
  private manualMode: UserViewMode = 'AUTO';
  private history: V2CameraView[] = [];
  private lockedView: V2CameraView | null = null;
  private lastEstimate: ViewEstimate = {
    view: 'VIEW_UNKNOWN',
    confidence: 0,
    evidence: {
      shoulderWidthRel: 0,
      hipWidthRel: 0,
      shoulderDepthDiff: 0,
      hipDepthDiff: 0,
      visibilitySymmetry: 0,
      torsoYawDeg: 0,
    },
    isLocked: false,
  };

  constructor(opts: ViewEstimatorOptions = {}) {
    this.historySize = opts.historySize ?? DEFAULT_VIEW_HISTORY_SIZE;
    if (opts.manualMode) this.manualMode = opts.manualMode;
  }

  setManualMode(mode: UserViewMode): void {
    this.manualMode = mode;
  }

  getManualMode(): UserViewMode {
    return this.manualMode;
  }

  lockView(view?: V2CameraView): void {
    this.lockedView = view ?? this.lastEstimate.view;
  }

  lock(view?: V2CameraView): void {
    this.lockView(view);
  }

  unlockView(): void {
    this.lockedView = null;
  }

  isLocked(): boolean {
    return this.lockedView !== null;
  }

  getLastEstimate(): ViewEstimate {
    return this.lastEstimate;
  }

  reset(): void {
    this.history = [];
    this.lockedView = null;
    this.lastEstimate = {
      view: 'VIEW_UNKNOWN',
      confidence: 0,
      evidence: {
        shoulderWidthRel: 0,
        hipWidthRel: 0,
        shoulderDepthDiff: 0,
        hipDepthDiff: 0,
        visibilitySymmetry: 0,
        torsoYawDeg: 0,
      },
      isLocked: false,
    };
  }

  /**
   * Process a landmark set and return the smoothed/locked view estimate.
   */
  estimate(landmarks: Landmark[], _timestamp?: number): ViewEstimate {
    return this.update(landmarks);
  }

  update(landmarks: Landmark[]): ViewEstimate {
    const raw = this.estimateRaw(landmarks);

    // If manual mode is active, override view decision
    if (this.manualMode !== 'AUTO') {
      const overrideView = this.resolveManualView(this.manualMode, raw.evidence, raw.view);
      this.lastEstimate = {
        view: overrideView,
        confidence: 1.0,
        evidence: raw.evidence,
        isLocked: this.isLocked(),
      };
      return this.lastEstimate;
    }

    // If locked post-calibration, preserve locked view unless confidence is 0
    if (this.lockedView !== null) {
      this.lastEstimate = {
        view: this.lockedView,
        confidence: Math.max(0.5, raw.confidence),
        evidence: raw.evidence,
        isLocked: true,
      };
      return this.lastEstimate;
    }

    // Temporal smoothing / hysteresis with rolling vote
    if (raw.view !== 'VIEW_UNKNOWN') {
      this.history.push(raw.view);
      if (this.history.length > this.historySize) {
        this.history.shift();
      }
    }

    const smoothedView = this.computeDominantView(raw.view);
    const voteConfidence = this.computeVoteConfidence(smoothedView);

    this.lastEstimate = {
      view: smoothedView,
      confidence: voteConfidence,
      evidence: raw.evidence,
      isLocked: false,
    };

    return this.lastEstimate;
  }

  /**
   * Single-frame raw view estimation without temporal smoothing.
   */
  estimateRaw(landmarks: Landmark[]): { view: V2CameraView; confidence: number; evidence: ViewEvidence } {
    if (!landmarks || landmarks.length < 25) {
      return {
        view: 'VIEW_UNKNOWN',
        confidence: 0,
        evidence: {
          shoulderWidthRel: 0,
          hipWidthRel: 0,
          shoulderDepthDiff: 0,
          hipDepthDiff: 0,
          visibilitySymmetry: 0,
          torsoYawDeg: 0,
        },
      };
    }

    const ls = landmarks[L_SHOULDER];
    const rs = landmarks[R_SHOULDER];
    const lh = landmarks[L_HIP];
    const rh = landmarks[R_HIP];

    const le = landmarks[L_ELBOW];
    const re = landmarks[R_ELBOW];
    const lw = landmarks[L_WRIST];
    const rw = landmarks[R_WRIST];

    const leftSideOk = (ls?.visibility ?? 0) >= 0.35 && (lh?.visibility ?? 0) >= 0.35;
    const rightSideOk = (rs?.visibility ?? 0) >= 0.35 && (rh?.visibility ?? 0) >= 0.35;
    if (!leftSideOk && !rightSideOk) {
      return {
        view: 'VIEW_UNKNOWN',
        confidence: 0,
        evidence: {
          shoulderWidthRel: 0,
          hipWidthRel: 0,
          shoulderDepthDiff: 0,
          hipDepthDiff: 0,
          visibilitySymmetry: 0,
          torsoYawDeg: 0,
        },
      };
    }

    // Compute torso dimension
    const shMid = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
    const hipMid = { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2 };
    const torsoHeight = Math.max(1e-4, Math.hypot(shMid.x - hipMid.x, shMid.y - hipMid.y));

    // Apparent 2D widths relative to torso height
    const shoulderWidthRel = Math.hypot(ls.x - rs.x, ls.y - rs.y) / torsoHeight;
    const hipWidthRel = Math.hypot(lh.x - rh.x, lh.y - rh.y) / torsoHeight;

    // Depth disparity in camera coordinate system (Z)
    const shoulderDepthDiff = Math.abs((ls.z ?? 0) - (rs.z ?? 0));
    const hipDepthDiff = Math.abs((lh.z ?? 0) - (rh.z ?? 0));

    // Left vs Right visibility symmetry
    const leftVis = ((ls.visibility ?? 0) + (le?.visibility ?? 0) + (lw?.visibility ?? 0) + (lh.visibility ?? 0)) / 4;
    const rightVis = ((rs.visibility ?? 0) + (re?.visibility ?? 0) + (rw?.visibility ?? 0) + (rh.visibility ?? 0)) / 4;
    const maxVis = Math.max(0.01, Math.max(leftVis, rightVis));
    const visibilitySymmetry = Math.max(0, 1.0 - Math.abs(leftVis - rightVis) / maxVis);

    // Torso yaw calculation
    const dx = rs.x - ls.x;
    const dz = (rs.z ?? 0) - (ls.z ?? 0);
    const torsoYawDeg = Math.abs((Math.atan2(dz, dx) * 180) / Math.PI);

    const evidence: ViewEvidence = {
      shoulderWidthRel,
      hipWidthRel,
      shoulderDepthDiff,
      hipDepthDiff,
      visibilitySymmetry,
      torsoYawDeg,
    };

    // Classification Decision Tree
    let view: V2CameraView;
    let confidence = 0.5;

    // Front: high symmetry and wide relative shoulder width
    if (shoulderWidthRel >= 0.45 && visibilitySymmetry >= 0.65 && shoulderDepthDiff <= 0.28) {
      view = 'VIEW_FRONT';
      confidence = Math.min(1.0, 0.5 + 0.3 * visibilitySymmetry + 0.2 * (shoulderWidthRel / 0.7));
    }
    // Side: low shoulder width and low visibility symmetry
    else if (shoulderWidthRel <= 0.30 || visibilitySymmetry <= 0.52) {
      const isLeft = leftVis >= rightVis;
      view = isLeft ? 'VIEW_SIDE_LEFT' : 'VIEW_SIDE_RIGHT';
      confidence = Math.min(1.0, 0.5 + 0.5 * (1.0 - visibilitySymmetry));
    }
    // Diagonal: intermediate range
    else {
      const isLeft = leftVis >= rightVis;
      view = isLeft ? 'VIEW_DIAGONAL_LEFT' : 'VIEW_DIAGONAL_RIGHT';
      confidence = 0.75;
    }

    return { view, confidence, evidence };
  }

  private resolveManualView(mode: UserViewMode, ev: ViewEvidence, defaultView: V2CameraView): V2CameraView {
    if (mode === 'FRONT') return 'VIEW_FRONT';
    if (mode === 'SIDE') {
      if (defaultView === 'VIEW_SIDE_LEFT' || defaultView === 'VIEW_SIDE_RIGHT') return defaultView;
      return ev.visibilitySymmetry <= 0.8 && ev.shoulderDepthDiff > 0 ? (ev.shoulderDepthDiff > 0.05 ? 'VIEW_SIDE_LEFT' : 'VIEW_SIDE_RIGHT') : 'VIEW_SIDE_LEFT';
    }
    if (mode === 'DIAGONAL') {
      if (defaultView === 'VIEW_DIAGONAL_LEFT' || defaultView === 'VIEW_DIAGONAL_RIGHT') return defaultView;
      return 'VIEW_DIAGONAL_LEFT';
    }
    return defaultView;
  }

  private computeDominantView(fallback: V2CameraView): V2CameraView {
    if (this.history.length === 0) return fallback;

    const counts: Record<string, number> = {};
    for (const v of this.history) {
      counts[v] = (counts[v] || 0) + 1;
    }

    let bestView: V2CameraView = fallback;
    let maxCount = 0;
    for (const [v, cnt] of Object.entries(counts)) {
      if (cnt > maxCount) {
        maxCount = cnt;
        bestView = v as V2CameraView;
      }
    }

    // Require at least 60% agreement to change away from last estimate
    if (
      this.lastEstimate.view !== 'VIEW_UNKNOWN' &&
      bestView !== this.lastEstimate.view &&
      maxCount / this.history.length < 0.6
    ) {
      return this.lastEstimate.view;
    }

    return bestView;
  }

  private computeVoteConfidence(view: V2CameraView): number {
    if (this.history.length === 0) return 0.5;
    const matchCount = this.history.filter((v) => v === view).length;
    return matchCount / this.history.length;
  }
}

/**
 * Helper to map V2CameraView down to V1 CameraView ('front' | 'side' | 'diagonal').
 */
export function toLegacyCameraView(v2View: V2CameraView): CameraView {
  switch (v2View) {
    case 'VIEW_FRONT':
      return 'front';
    case 'VIEW_SIDE_LEFT':
    case 'VIEW_SIDE_RIGHT':
      return 'side';
    case 'VIEW_DIAGONAL_LEFT':
    case 'VIEW_DIAGONAL_RIGHT':
      return 'diagonal';
    case 'VIEW_UNKNOWN':
    default:
      return 'side';
  }
}
