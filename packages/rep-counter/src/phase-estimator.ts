/**
 * packages/rep-counter/src/phase-estimator.ts
 *
 * Continuous rep phase in [0, 1]:
 *   0.0 ≈ top / lockout
 *   0.5 ≈ mid-depth
 *   1.0 ≈ bottom
 *
 * Each channel is normalized by personal ROM. Polarities for depth / image-Y /
 * shoulder-wrist distance are learned from the first real descent, not assumed.
 */

import type { PersonalRom, PhaseEstimate, RepMotionSignal, V2CameraView } from '@ai-pushup-coach/types';
import { fuseMotionEvidence } from './motion-fusion';

const ELBOW_TOP_PRIOR = 165;
const ELBOW_BOTTOM_PRIOR = 80;
const MIN_ELBOW_SPAN = 18;

export function defaultPersonalRom(): PersonalRom {
  return {
    elbowTop: ELBOW_TOP_PRIOR,
    elbowBottom: ELBOW_BOTTOM_PRIOR,
    shoulderYTop: Number.NaN,
    shoulderYBottom: Number.NaN,
    depthTop: Number.NaN,
    depthBottom: Number.NaN,
    distTop: Number.NaN,
    distBottom: Number.NaN,
    depthPolarity: 1,
    shoulderYPolarity: 1,
    distPolarity: -1,
    samples: 0,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function normPhase(value: number, top: number, bottom: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(top) || !Number.isFinite(bottom)) return Number.NaN;
  const span = bottom - top;
  if (Math.abs(span) < 1e-6) return Number.NaN;
  return clamp((value - top) / span, 0, 1);
}

export class RepPhaseEstimator {
  private rom: PersonalRom = defaultPersonalRom();
  private frozen = false;
  private lastPhase = 0;
  private lastTimestamp = Number.NaN;
  private lastVelocity = 0;
  private topHold: { elbow: number; y: number; z: number; dist: number; n: number } | null = null;

  getRom(): PersonalRom {
    return { ...this.rom };
  }

  freeze(frozen: boolean): void {
    this.frozen = frozen;
  }

  isFrozen(): boolean {
    return this.frozen;
  }

  reset(): void {
    this.rom = defaultPersonalRom();
    this.frozen = false;
    this.lastPhase = 0;
    this.lastTimestamp = Number.NaN;
    this.lastVelocity = 0;
    this.topHold = null;
  }

  markSetStart(): void {
    this.lastPhase = 0;
    this.lastTimestamp = Number.NaN;
    this.lastVelocity = 0;
  }

  seedElbowRom(top: number, bottom: number): void {
    if (!Number.isFinite(top) || !Number.isFinite(bottom)) return;
    const hi = Math.max(top, bottom);
    const lo = Math.min(top, bottom);
    if (hi - lo < MIN_ELBOW_SPAN) return;
    this.rom.elbowTop = hi;
    this.rom.elbowBottom = lo;
  }

  /**
   * While the user holds the plank top, slowly lock top-of-ROM anchors.
   */
  observeStableTop(signal: RepMotionSignal): void {
    if (this.frozen) return;
    const elbow = Number.isFinite(signal.elbowCombined) ? signal.elbowCombined : Number.NaN;
    const y = signal.shoulderCenterY ?? signal.shoulderMotion;
    const z = signal.shoulderWorldZ ?? signal.worldDepthMotion;
    const dist = signal.shoulderWristDist ?? Number.NaN;
    if (!this.topHold) {
      this.topHold = { elbow, y, z, dist, n: 1 };
      return;
    }
    const n = this.topHold.n + 1;
    const mix = (prev: number, next: number) =>
      Number.isFinite(next) ? (Number.isFinite(prev) ? prev + (next - prev) / n : next) : prev;
    this.topHold = {
      elbow: mix(this.topHold.elbow, elbow),
      y: mix(this.topHold.y, y),
      z: mix(this.topHold.z, z),
      dist: mix(this.topHold.dist, dist),
      n,
    };
    if (n >= 8) {
      if (Number.isFinite(this.topHold.elbow)) {
        this.rom.elbowTop = 0.7 * this.rom.elbowTop + 0.3 * this.topHold.elbow;
      }
      if (Number.isFinite(this.topHold.y)) this.rom.shoulderYTop = this.topHold.y;
      if (Number.isFinite(this.topHold.z)) this.rom.depthTop = this.topHold.z;
      if (Number.isFinite(this.topHold.dist)) this.rom.distTop = this.topHold.dist;
    }
  }

  /**
   * After a completed cycle, refine personal ROM from measured extrema.
   */
  refineFromCycle(opts: {
    elbowMax: number;
    elbowMin: number;
    shoulderYTop: number;
    shoulderYBottom: number;
    depthTop: number;
    depthBottom: number;
    distTop: number;
    distBottom: number;
  }): void {
    if (this.frozen) return;
    const span = opts.elbowMax - opts.elbowMin;
    if (span >= MIN_ELBOW_SPAN) {
      this.rom.elbowTop = 0.65 * this.rom.elbowTop + 0.35 * opts.elbowMax;
      this.rom.elbowBottom = 0.65 * this.rom.elbowBottom + 0.35 * opts.elbowMin;
    }
    if (Number.isFinite(opts.shoulderYTop) && Number.isFinite(opts.shoulderYBottom)) {
      this.rom.shoulderYTop = opts.shoulderYTop;
      this.rom.shoulderYBottom = opts.shoulderYBottom;
      this.rom.shoulderYPolarity = opts.shoulderYBottom >= opts.shoulderYTop ? 1 : -1;
    }
    if (Number.isFinite(opts.depthTop) && Number.isFinite(opts.depthBottom)) {
      this.rom.depthTop = opts.depthTop;
      this.rom.depthBottom = opts.depthBottom;
      this.rom.depthPolarity = opts.depthBottom >= opts.depthTop ? 1 : -1;
    }
    if (Number.isFinite(opts.distTop) && Number.isFinite(opts.distBottom)) {
      this.rom.distTop = opts.distTop;
      this.rom.distBottom = opts.distBottom;
      this.rom.distPolarity = opts.distBottom <= opts.distTop ? -1 : 1;
    }
    this.rom.samples += 1;
  }

  estimate(signal: RepMotionSignal, view: V2CameraView): PhaseEstimate & { velocity: number } {
    const elbow = Number.isFinite(signal.elbowCombined)
      ? signal.elbowCombined
      : Number.isFinite(signal.elbowLeft)
        ? signal.elbowLeft
        : signal.elbowRight;
    const elbowPhase = normPhase(elbow, this.rom.elbowTop, this.rom.elbowBottom);

    const y = signal.shoulderCenterY ?? signal.shoulderMotion;
    let centroidPhase = Number.NaN;
    if (Number.isFinite(y) && Number.isFinite(this.rom.shoulderYTop) && Number.isFinite(this.rom.shoulderYBottom)) {
      const top = this.rom.shoulderYTop;
      const bottom =
        this.rom.shoulderYPolarity >= 0
          ? Math.max(this.rom.shoulderYBottom, top + 0.02)
          : Math.min(this.rom.shoulderYBottom, top - 0.02);
      centroidPhase = normPhase(y, top, bottom);
    } else if (Number.isFinite(y) && Number.isFinite(this.rom.shoulderYTop)) {
      // Cold start: image Y increasing is the usual webcam descent.
      // Front camera: even a small shoulder drop is the actual push-up.
      const scale = view === 'VIEW_FRONT' ? 0.10 : 0.18;
      const rel = ((y - this.rom.shoulderYTop) * this.rom.shoulderYPolarity) / scale;
      if (rel > 0.05) centroidPhase = clamp(rel, 0, 1);
    }

    const z = signal.shoulderWorldZ ?? signal.worldDepthMotion;
    let depthPhase = Number.NaN;
    if (Number.isFinite(z) && Number.isFinite(this.rom.depthTop) && Number.isFinite(this.rom.depthBottom)) {
      const top = this.rom.depthTop;
      const bottom =
        this.rom.depthPolarity >= 0
          ? Math.max(this.rom.depthBottom, top + 1e-4)
          : Math.min(this.rom.depthBottom, top - 1e-4);
      depthPhase = normPhase(z, top, bottom);
    }

    const dist = signal.shoulderWristDist ?? Number.NaN;
    let distancePhase = Number.NaN;
    if (Number.isFinite(dist) && Number.isFinite(this.rom.distTop) && Number.isFinite(this.rom.distBottom)) {
      const top = this.rom.distTop;
      const bottom =
        this.rom.distPolarity < 0
          ? Math.min(this.rom.distBottom, top - 1e-4)
          : Math.max(this.rom.distBottom, top + 1e-4);
      distancePhase = normPhase(dist, top, bottom);
    } else if (Number.isFinite(dist) && Number.isFinite(this.rom.distTop)) {
      const rel = (this.rom.distTop - dist) / Math.max(0.08, this.rom.distTop * 0.45);
      if (rel > 0.06) distancePhase = clamp(rel, 0, 1);
    }

    const front = view === 'VIEW_FRONT';
    const side = view === 'VIEW_SIDE_LEFT' || view === 'VIEW_SIDE_RIGHT';
    const weights = {
      elbow: side ? 0.7 : front ? 0.4 : 0.45,
      depth: side ? 0.05 : front ? 0.22 : 0.15,
      centroid: side ? 0.15 : front ? 0.25 : 0.22,
      dist: side ? 0.1 : front ? 0.13 : 0.18,
    };

    const parts: { p: number; w: number }[] = [];
    if (Number.isFinite(elbowPhase)) parts.push({ p: elbowPhase, w: weights.elbow });
    if (Number.isFinite(depthPhase)) parts.push({ p: depthPhase, w: weights.depth });
    if (Number.isFinite(centroidPhase)) parts.push({ p: centroidPhase, w: weights.centroid });
    if (Number.isFinite(distancePhase)) parts.push({ p: distancePhase, w: weights.dist });

    let phase = 0;
    if (parts.length === 0) {
      phase = this.lastPhase;
    } else {
      const wsum = parts.reduce((a, b) => a + b.w, 0);
      phase = parts.reduce((a, b) => a + b.p * b.w, 0) / Math.max(wsum, 1e-6);
    }
    phase = clamp(phase, 0, 1);

    let velocity = 0;
    if (Number.isFinite(this.lastTimestamp) && signal.timestamp > this.lastTimestamp) {
      const dt = Math.max(1 / 60, signal.timestamp - this.lastTimestamp);
      velocity = (phase - this.lastPhase) / dt;
    }
    this.lastPhase = phase;
    this.lastTimestamp = signal.timestamp;
    this.lastVelocity = velocity;

    const evidence = fuseMotionEvidence(
      signal,
      elbowPhase,
      depthPhase,
      centroidPhase,
      distancePhase,
      velocity,
      view,
    );

    return {
      phase,
      confidence: evidence.phaseConfidence,
      elbowPhase: Number.isFinite(elbowPhase) ? elbowPhase : Number.NaN,
      depthPhase: Number.isFinite(depthPhase) ? depthPhase : Number.NaN,
      centroidPhase: Number.isFinite(centroidPhase) ? centroidPhase : Number.NaN,
      distancePhase: Number.isFinite(distancePhase) ? distancePhase : Number.NaN,
      velocity,
    };
  }

  getLastVelocity(): number {
    return this.lastVelocity;
  }
}
