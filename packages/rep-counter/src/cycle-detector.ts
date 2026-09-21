/**
 * packages/rep-counter/src/cycle-detector.ts
 *
 * Coherent-cycle FSM. A rep is TOP → DESCENT → BOTTOM/reversal → ASCENT → TOP.
 * Never emit from a single threshold crossing. Count the attempt; form grading
 * happens elsewhere. Reject tremor / micro-motion / tracking spikes.
 */

import type { FrameFeatures, RepCycleEvent, V3RepState } from '@ai-pushup-coach/types';

export const MIN_PHASE_EXCURSION = 0.14;
export const BOTTOM_PHASE = 0.42;
export const TOP_PHASE = 0.22;
export const REVERSAL_PHASE = 0.18;
export const MIN_CYCLE_SECONDS = 0.28;
export const MAX_CYCLE_SECONDS = 10;
export const REARM_SECONDS = 0.06;
export const TOP_STABLE_SECONDS = 0.18;

export interface CycleTick {
  timestamp: number;
  phase: number;
  confidence: number;
  velocity: number;
  elbow: number;
  shoulderY: number;
  depth: number;
  dist: number;
  bilateralAgreement: number;
  frame?: FrameFeatures;
}

interface OpenCycle {
  id: number;
  startTime: number;
  bottomTime: number;
  startPhase: number;
  peakPhase: number;
  troughPhase: number;
  elbowMax: number;
  elbowMin: number;
  yTop: number;
  yBottom: number;
  depthTop: number;
  depthBottom: number;
  distTop: number;
  distBottom: number;
  dirHits: number;
  dirTotal: number;
  frames: FrameFeatures[];
}

export class CycleDetector {
  private state: V3RepState = 'WAITING';
  private topSince = Number.NaN;
  private rearmUntil = 0;
  private nextId = 1;
  private open: OpenCycle | null = null;
  private count = 0;
  readonly events: RepCycleEvent[] = [];
  private lastPhase = 0;
  private holdUntil = 0;

  getState(): V3RepState {
    return this.state;
  }

  getCount(): number {
    return this.count;
  }

  isInCycle(): boolean {
    return (
      this.state === 'DESCENDING' ||
      this.state === 'BOTTOM_CONFIRMED' ||
      this.state === 'ASCENDING'
    );
  }

  reset(): void {
    this.state = 'WAITING';
    this.topSince = Number.NaN;
    this.rearmUntil = 0;
    this.nextId = 1;
    this.open = null;
    this.count = 0;
    this.events.length = 0;
    this.lastPhase = 0;
    this.holdUntil = 0;
  }

  /** After the 3-2-1, the user is already in plank — do not wait for another hold. */
  assumeTopConfirmed(): void {
    this.state = 'TOP_CONFIRMED';
    this.topSince = 0;
  }

  /**
   * When confidence collapses, hold the current state instead of inventing motion.
   */
  hold(timestamp: number, seconds = 0.25): void {
    this.holdUntil = timestamp + seconds;
  }

  tick(sample: CycleTick): RepCycleEvent | null {
    if (sample.timestamp < this.holdUntil && sample.confidence < 0.35) {
      return null;
    }

    const phase = sample.phase;
    const t = sample.timestamp;
    let event: RepCycleEvent | null = null;

    switch (this.state) {
      case 'WAITING':
        if (phase <= TOP_PHASE + 0.08) {
          if (!Number.isFinite(this.topSince)) this.topSince = t;
          if (t - this.topSince >= TOP_STABLE_SECONDS) {
            this.state = 'TOP_CONFIRMED';
          }
        } else if (phase > REVERSAL_PHASE && sample.velocity > 0.08) {
          this.beginCycle(sample);
          this.state = 'DESCENDING';
        } else {
          this.topSince = Number.NaN;
        }
        break;

      case 'TOP_CONFIRMED':
        if (phase <= TOP_PHASE) {
          this.topSince = Number.isFinite(this.topSince) ? this.topSince : t;
        }
        if (phase > 0.12 && sample.velocity > 0.03) {
          this.beginCycle(sample);
          this.state = 'DESCENDING';
        }
        break;

      case 'DESCENDING':
        this.accumulate(sample, +1);
        if (phase >= BOTTOM_PHASE) {
          this.state = 'BOTTOM_CONFIRMED';
          if (this.open) this.open.bottomTime = t;
        } else if (sample.velocity < -0.06 && this.open && this.open.peakPhase >= REVERSAL_PHASE) {
          this.state = 'BOTTOM_CONFIRMED';
          if (this.open) this.open.bottomTime = t;
        } else if (phase <= TOP_PHASE && this.open && this.open.peakPhase < MIN_PHASE_EXCURSION) {
          this.rejectOpen('micro_motion');
          this.state = 'TOP_CONFIRMED';
        }
        break;

      case 'BOTTOM_CONFIRMED':
        this.accumulate(sample, 0);
        if (phase <= 0.92 && sample.velocity <= 0.02) {
          this.state = 'ASCENDING';
        }
        break;

      case 'ASCENDING':
        this.accumulate(sample, -1);
        if (this.open && this.open.peakPhase >= MIN_PHASE_EXCURSION) {
          const dropped = this.open.peakPhase - phase >= Math.max(0.08, this.open.peakPhase * 0.32);
          const backNearTop =
            phase <= 0.48 || phase <= this.open.startPhase + 0.28;
          if (dropped && backNearTop && sample.velocity <= 0.15) {
            this.state = 'TOP_RETURNED';
            event = this.complete(sample);
            break;
          }
        }
        if (phase >= BOTTOM_PHASE && sample.velocity > 0.12) {
          this.state = 'BOTTOM_CONFIRMED';
        }
        break;

      case 'TOP_RETURNED':
      case 'COMPLETE':
        this.state = 'REARMING';
        this.rearmUntil = t + REARM_SECONDS;
        break;

      case 'REARMING':
        if (phase > 0.16 && sample.velocity > 0.08) {
          this.beginCycle(sample);
          this.state = 'DESCENDING';
          break;
        }
        if (t >= this.rearmUntil && phase <= TOP_PHASE + 0.16) {
          this.state = 'TOP_CONFIRMED';
          this.topSince = t;
        } else if (t >= this.rearmUntil) {
          this.state = 'WAITING';
        }
        break;
    }

    this.lastPhase = phase;
    return event;
  }

  private beginCycle(sample: CycleTick): void {
    this.open = {
      id: this.nextId++,
      startTime: sample.timestamp,
      bottomTime: sample.timestamp,
      startPhase: sample.phase,
      peakPhase: sample.phase,
      troughPhase: sample.phase,
      elbowMax: Number.isFinite(sample.elbow) ? sample.elbow : -Infinity,
      elbowMin: Number.isFinite(sample.elbow) ? sample.elbow : Infinity,
      yTop: sample.shoulderY,
      yBottom: sample.shoulderY,
      depthTop: sample.depth,
      depthBottom: sample.depth,
      distTop: sample.dist,
      distBottom: sample.dist,
      dirHits: 0,
      dirTotal: 0,
      frames: sample.frame ? [sample.frame] : [],
    };
  }

  private accumulate(sample: CycleTick, expectedDir: number): void {
    const c = this.open;
    if (!c) return;
    c.peakPhase = Math.max(c.peakPhase, sample.phase);
    c.troughPhase = Math.min(c.troughPhase, sample.phase);
    if (Number.isFinite(sample.elbow)) {
      c.elbowMax = Math.max(c.elbowMax, sample.elbow);
      c.elbowMin = Math.min(c.elbowMin, sample.elbow);
    }
    if (Number.isFinite(sample.shoulderY)) {
      c.yTop = Math.min(c.yTop, sample.shoulderY);
      c.yBottom = Math.max(c.yBottom, sample.shoulderY);
    }
    if (Number.isFinite(sample.depth)) {
      c.depthTop = c.depthTop;
      c.depthBottom = sample.depth;
    }
    if (Number.isFinite(sample.dist)) {
      if (!Number.isFinite(c.distTop)) c.distTop = sample.dist;
      c.distBottom = sample.dist;
    }
    if (expectedDir !== 0) {
      c.dirTotal += 1;
      if (Math.sign(sample.velocity) === expectedDir || Math.abs(sample.velocity) < 0.05) {
        c.dirHits += 1;
      }
    }
    if (sample.frame) c.frames.push(sample.frame);
  }

  private rejectOpen(reason: string): void {
    this.open = null;
    void reason;
  }

  private complete(sample: CycleTick): RepCycleEvent | null {
    const c = this.open;
    this.open = null;
    if (!c) return null;

    const duration = sample.timestamp - c.startTime;
    const excursion = c.peakPhase - Math.min(c.startPhase, 0.08);
    const angular = Number.isFinite(c.elbowMax) && Number.isFinite(c.elbowMin) ? c.elbowMax - c.elbowMin : 0;
    const depthExc = Number.isFinite(c.depthTop) && Number.isFinite(c.depthBottom)
      ? Math.abs(c.depthBottom - c.depthTop)
      : 0;
    const dir = c.dirTotal > 0 ? c.dirHits / c.dirTotal : 0;

    const yTravel = Number.isFinite(c.yTop) && Number.isFinite(c.yBottom) ? Math.abs(c.yBottom - c.yTop) : 0;
    let rejection: string | null = null;
    if (excursion < MIN_PHASE_EXCURSION && angular < 12 && yTravel < 0.03 && depthExc < 0.02) {
      rejection = 'micro_motion';
    } else if (duration < MIN_CYCLE_SECONDS) rejection = 'too_fast';
    else if (duration > MAX_CYCLE_SECONDS) rejection = 'too_slow';
    else if (dir < 0.22 && c.dirTotal >= 12) rejection = 'direction_inconsistent';

    const counted = rejection === null;
    if (counted) this.count += 1;

    const event: RepCycleEvent = {
      index: counted ? this.count : this.count,
      startTime: c.startTime,
      bottomTime: c.bottomTime,
      endTime: sample.timestamp,
      durationS: duration,
      phaseExcursion: excursion,
      angularExcursion: angular,
      depthExcursion: depthExc,
      elbowMin: Number.isFinite(c.elbowMin) ? c.elbowMin : Number.NaN,
      elbowMax: Number.isFinite(c.elbowMax) ? c.elbowMax : Number.NaN,
      shoulderYTop: c.yTop,
      shoulderYBottom: c.yBottom,
      depthTop: c.depthTop,
      depthBottom: c.depthBottom,
      distTop: c.distTop,
      distBottom: c.distBottom,
      bilateralAgreement: sample.bilateralAgreement,
      directionConsistency: dir,
      overallConfidence: sample.confidence,
      counted,
      rejectionReason: rejection,
      frames: c.frames,
    };

    if (counted) {
      this.events.push(event);
      this.state = 'COMPLETE';
      this.rearmUntil = sample.timestamp + REARM_SECONDS;
    } else {
      this.state = 'TOP_CONFIRMED';
    }
    return counted ? event : { ...event, index: 0 };
  }

  getOpenCycleId(): number | null {
    return this.open?.id ?? null;
  }

  getOpenExtrema(): OpenCycle | null {
    return this.open;
  }
}
