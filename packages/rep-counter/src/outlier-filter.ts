/**
 * packages/rep-counter/src/outlier-filter.ts
 *
 * Reject anatomically impossible jumps (tracking collapse) before they can
 * create a fake BOTTOM. Example: 162, 158, 153, 14, 149 — the 14° is collapse.
 */

import type { RepMotionSignal } from '@ai-pushup-coach/types';
import { ELBOW_ANGLE_MAX_PLAUSIBLE, ELBOW_ANGLE_MIN_PLAUSIBLE } from './rep-counter';

const MAX_DEG_PER_SEC = 420;
const MAX_PHASE_PER_SEC = 6;
const MEDIAN_K = 5;

export class OutlierFilter {
  private elbowBuf: number[] = [];
  private lastGood: RepMotionSignal | null = null;
  private lastTime = Number.NaN;

  reset(): void {
    this.elbowBuf = [];
    this.lastGood = null;
    this.lastTime = Number.NaN;
  }

  /**
   * Returns the (possibly held) signal, plus whether this frame was rejected.
   */
  push(signal: RepMotionSignal): { signal: RepMotionSignal; rejected: boolean; reason: string | null } {
    const elbow = signal.elbowCombined;
    if (Number.isFinite(elbow)) {
      if (elbow < ELBOW_ANGLE_MIN_PLAUSIBLE || elbow > ELBOW_ANGLE_MAX_PLAUSIBLE) {
        return this.hold('landmark_collapse');
      }
      if (this.elbowBuf.length >= 3) {
        const med = median(this.elbowBuf);
        const dt = Number.isFinite(this.lastTime) ? Math.max(1 / 60, signal.timestamp - this.lastTime) : 1 / 20;
        const vel = Math.abs(elbow - med) / dt;
        if (Math.abs(elbow - med) > 55 && vel > MAX_DEG_PER_SEC) {
          return this.hold('velocity_spike');
        }
      }
      const left = signal.elbowLeft ?? Number.NaN;
      const right = signal.elbowRight ?? Number.NaN;
      if (Number.isFinite(left) && Number.isFinite(right)) {
        const gap = Math.abs(left - right);
        const lv = signal.leftVisibility ?? 0;
        const rv = signal.rightVisibility ?? 0;
        if (gap > 70 && Math.min(lv, rv) < 0.35 && Math.max(lv, rv) > 0.5) {
          const keepLeft = lv >= rv;
          const cleaned = {
            ...signal,
            elbowCombined: keepLeft ? left : right,
            phaseEvidence: keepLeft ? left : right,
          };
          this.accept(cleaned);
          return { signal: cleaned, rejected: false, reason: null };
        }
      }
      this.elbowBuf.push(elbow);
      if (this.elbowBuf.length > MEDIAN_K) this.elbowBuf.shift();
    }

    this.accept(signal);
    return { signal, rejected: false, reason: null };
  }

  private accept(signal: RepMotionSignal): void {
    this.lastGood = signal;
    this.lastTime = signal.timestamp;
  }

  private hold(reason: string): { signal: RepMotionSignal; rejected: boolean; reason: string } {
    if (this.lastGood) {
      return { signal: { ...this.lastGood }, rejected: true, reason };
    }
    return {
      signal: {
        timestamp: 0,
        phaseEvidence: Number.NaN,
        elbowLeft: Number.NaN,
        elbowRight: Number.NaN,
        elbowCombined: Number.NaN,
        shoulderMotion: Number.NaN,
        hipMotion: Number.NaN,
        worldDepthMotion: Number.NaN,
        poseConfidence: 0,
        view: 'VIEW_UNKNOWN',
      },
      rejected: true,
      reason,
    };
  }
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export { MAX_DEG_PER_SEC, MAX_PHASE_PER_SEC };
