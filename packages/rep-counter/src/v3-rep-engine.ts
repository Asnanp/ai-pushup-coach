/**
 * packages/rep-counter/src/v3-rep-engine.ts
 *
 * Live-first rep engine: rich signals → outlier/dropout → fused phase →
 * coherent-cycle FSM. Counts movement attempts; form grading is downstream.
 */

import type {
  FrameFeatures,
  Landmark,
  LiveTraceFrame,
  MotionEvidence,
  PersonalRom,
  PhaseEstimate,
  RepCycleEvent,
  RepMotionSignal,
  V2CameraView,
  V3RepState,
} from '@ai-pushup-coach/types';
import { fuseMotionEvidence } from './motion-fusion';
import { RepPhaseEstimator } from './phase-estimator';
import { CycleDetector } from './cycle-detector';
import { OutlierFilter } from './outlier-filter';
import { DropoutBridge } from './dropout-bridge';
import { LiveTraceRecorder, buildTraceFrame } from './live-trace';
import { extractRichMotion } from './signal-extractors';
import { CausalSmoother, MedianFilter } from './rep-counter';

export interface V3FeedInput {
  timestamp: number;
  landmarks?: Landmark[];
  worldLandmarks?: Landmark[];
  view: V2CameraView;
  viewConfidence?: number;
  frame?: FrameFeatures;
  canCount?: boolean;
  signal?: RepMotionSignal;
}

export interface V3FeedResult {
  phase: number;
  phaseConfidence: number;
  estimate: PhaseEstimate;
  evidence: MotionEvidence;
  fsmState: V3RepState;
  event: RepCycleEvent | null;
  rejectionReason: string | null;
  inCycle: boolean;
  liveElbow: number | null;
  rom: PersonalRom;
  trace: LiveTraceFrame;
}

export class V3RepEngine {
  private readonly phase = new RepPhaseEstimator();
  private readonly cycles = new CycleDetector();
  private readonly outliers = new OutlierFilter();
  private readonly dropout = new DropoutBridge();
  private readonly smoother = new CausalSmoother(3);
  private readonly median = new MedianFilter(3);
  readonly traces = new LiveTraceRecorder();
  private lastView: V2CameraView = 'VIEW_FRONT';
  private learningFrozen = false;

  reset(): void {
    this.phase.reset();
    this.cycles.reset();
    this.outliers.reset();
    this.dropout.reset();
    this.smoother.reset();
    this.median.reset();
    this.traces.reset();
  }

  freezeLearning(frozen: boolean): void {
    this.learningFrozen = frozen;
    this.phase.freeze(frozen);
  }

  seedElbowRom(top: number, bottom: number): void {
    this.phase.seedElbowRom(top, bottom);
  }

  getState(): V3RepState {
    return this.cycles.getState();
  }

  getCount(): number {
    return this.cycles.getCount();
  }

  isInCycle(): boolean {
    return this.cycles.isInCycle();
  }

  getRom(): PersonalRom {
    return this.phase.getRom();
  }

  /** Begin a counted set: reset the FSM, keep personal ROM. */
  startCounting(): void {
    this.cycles.reset();
    this.cycles.assumeTopConfirmed();
    this.outliers.reset();
    this.dropout.reset();
    this.smoother.reset();
    this.median.reset();
    this.phase.markSetStart();
    this.phase.freeze(false);
    this.learningFrozen = false;
  }

  getEvents(): RepCycleEvent[] {
    return this.cycles.events;
  }

  feed(input: V3FeedInput): V3FeedResult {
    const view = input.view;
    this.lastView = view;
    const viewConfidence = input.viewConfidence ?? 1;

    let raw: RepMotionSignal | null = input.signal ?? null;
    if (!raw && input.landmarks && input.landmarks.length >= 25) {
      raw = extractRichMotion(input.landmarks, input.timestamp, view, input.worldLandmarks);
    }

    const canCount = input.canCount !== false;
    const usable = Boolean(raw && canCount && (raw.poseConfidence > 0.12 || Number.isFinite(raw.elbowCombined)));

    let rejection: string | null = null;
    if (raw) {
      const filtered = this.outliers.push(raw);
      if (filtered.rejected) {
        rejection = filtered.reason;
        raw = filtered.signal ?? raw;
      }
    }

    const bridged = this.dropout.push(raw, usable && !rejection);
    if (bridged.paused) {
      this.cycles.hold(input.timestamp, 0.3);
    }
    const signal = bridged.signal;

    if (!signal) {
      const empty = this.emptyResult(input.timestamp, view, viewConfidence, 'no_pose');
      return empty;
    }

    const stateBefore = this.cycles.getState();
    if (stateBefore === 'WAITING' || stateBefore === 'TOP_CONFIRMED' || stateBefore === 'REARMING') {
      if (!this.learningFrozen) this.phase.observeStableTop(signal);
    }

    const estimate = this.phase.estimate(signal, view);
    const smoothed = this.median.push(this.smoother.push(estimate.phase));
    const phase = Number.isFinite(smoothed) ? smoothed : estimate.phase;

    const evidence = fuseMotionEvidence(
      signal,
      estimate.elbowPhase,
      estimate.depthPhase,
      estimate.centroidPhase,
      estimate.distancePhase,
      estimate.velocity,
      view,
    );

    const event = this.cycles.tick({
      timestamp: input.timestamp,
      phase,
      confidence: estimate.confidence,
      velocity: estimate.velocity,
      elbow: signal.elbowCombined,
      shoulderY: signal.shoulderCenterY ?? signal.shoulderMotion,
      depth: signal.shoulderWorldZ ?? signal.worldDepthMotion,
      dist: signal.shoulderWristDist ?? Number.NaN,
      bilateralAgreement: evidence.bilateralAgreement,
      frame: input.frame,
    });

    if (event?.counted && !this.learningFrozen) {
      this.phase.refineFromCycle({
        elbowMax: event.elbowMax,
        elbowMin: event.elbowMin,
        shoulderYTop: event.shoulderYTop,
        shoulderYBottom: event.shoulderYBottom,
        depthTop: event.depthTop,
        depthBottom: event.depthBottom,
        distTop: event.distTop,
        distBottom: event.distBottom,
      });
    }

    if (event && !event.counted) {
      rejection = event.rejectionReason;
    }

    const fsmState = this.cycles.getState();
    const trace = buildTraceFrame({
      signal,
      view,
      viewConfidence,
      phase: estimate.phase,
      filteredPhase: phase,
      fsmState,
      confidence: evidence.overallConfidence,
      cycleId: this.cycles.getOpenCycleId(),
      emitted: Boolean(event?.counted),
      rejection,
      rom: this.phase.getRom(),
      landmarks: input.landmarks,
    });
    this.traces.push(trace);

    return {
      phase,
      phaseConfidence: estimate.confidence,
      estimate,
      evidence,
      fsmState,
      event: event?.counted ? event : event && !event.counted ? event : null,
      rejectionReason: rejection,
      inCycle: this.cycles.isInCycle(),
      liveElbow: Number.isFinite(signal.elbowCombined) ? signal.elbowCombined : null,
      rom: this.phase.getRom(),
      trace,
    };
  }

  private emptyResult(
    timestamp: number,
    view: V2CameraView,
    viewConfidence: number,
    reason: string,
  ): V3FeedResult {
    const rom = this.phase.getRom();
    const fsmState = this.cycles.getState();
    const signal: RepMotionSignal = {
      timestamp,
      phaseEvidence: Number.NaN,
      elbowLeft: Number.NaN,
      elbowRight: Number.NaN,
      elbowCombined: Number.NaN,
      shoulderMotion: Number.NaN,
      hipMotion: Number.NaN,
      worldDepthMotion: Number.NaN,
      poseConfidence: 0,
      view,
    };
    const trace = buildTraceFrame({
      signal,
      view,
      viewConfidence,
      phase: 0,
      filteredPhase: 0,
      fsmState,
      confidence: 0,
      cycleId: null,
      emitted: false,
      rejection: reason,
      rom,
    });
    this.traces.push(trace);
    return {
      phase: 0,
      phaseConfidence: 0,
      estimate: {
        phase: 0,
        confidence: 0,
        elbowPhase: Number.NaN,
        depthPhase: Number.NaN,
        centroidPhase: Number.NaN,
        distancePhase: Number.NaN,
      },
      evidence: {
        elbowEvidence: 0,
        depthEvidence: 0,
        centroidEvidence: 0,
        distanceEvidence: 0,
        bilateralAgreement: 0,
        motionDirection: 0,
        movementMagnitude: 0,
        phaseConfidence: 0,
        overallConfidence: 0,
      },
      fsmState,
      event: null,
      rejectionReason: reason,
      inCycle: false,
      liveElbow: null,
      rom,
      trace,
    };
  }
}
