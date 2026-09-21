/**
 * packages/pose — PoseEngine
 *
 * Agent 6 — POSE ESTIMATION ENGINEER
 *
 * Wraps MediaPipe Pose Landmarker (browser Tasks API) and exposes a clean,
 * standardized pose stream to the rest of the app.
 *
 * Responsibilities:
 *   - load the landmarker model (with GPU delegate + CPU fallback)
 *   - run detection at a throttled rate, decoupled from camera FPS
 *   - smooth landmarks (adaptive low-pass) to kill per-frame jitter
 *   - determine which body side is trustworthy (side-view occlusion)
 *   - report confidence and validity per frame
 *   - detect multiple people (MediaPipe Pose detects the dominant subject, so
 *     we additionally count faces/poses where possible and surface a warning)
 *
 * Design note: this class is deliberately NOT a React hook. It runs a rAF loop
 * and pushes frames through a callback. React only receives throttled derived
 * metrics. Putting 33 landmarks x 30fps into React state would tank the UI.
 */

import {
  FilesetResolver,
  PoseLandmarker,
  type PoseLandmarkerResult,
} from '@mediapipe/tasks-vision';
import type { Landmark, PoseFrame } from '@ai-pushup-coach/types';
import { OneEuroFilter } from './one-euro';
import { computeSideVisibility, chooseActiveSide } from './side-selection';
import { evaluatePoseCapability } from './pose-capability';

/**
 * Where the MediaPipe runtime assets live, tried in order.
 *
 * Local first, deliberately. This app is demonstrated live at a booth, and a
 * venue's wifi is the least reliable component in the whole system: a failed
 * CDN fetch presents as "the app is broken" when in fact only the network is.
 * The ~19 MB of WASM and the ~9 MB landmarker are served from `/public` so the
 * whole thing runs with the network cable pulled out.
 *
 * The CDN entries are a fallback for deployments that ship without the local
 * copies (a host with a tight bundle limit, for instance). Populate the local
 * copies with `npm run fetch:pose-assets`.
 */
export const POSE_ASSET_SOURCES = [
  {
    label: 'local',
    wasmBase: '/mediapipe/wasm',
    modelUrl: '/models/pose_landmarker_full.task',
  },
  {
    label: 'cdn',
    wasmBase: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm',
    modelUrl:
      'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
  },
] as const;

/** Kept for callers that only want the canonical CDN locations. */
export const MEDIAPIPE_WASM_BASE = POSE_ASSET_SOURCES[1].wasmBase;

/** Model variants. Full gives better accuracy on the small joints we need. */
export const POSE_MODEL_URL = POSE_ASSET_SOURCES[1].modelUrl;

/** Below this the frame's geometry is untrustworthy (see docs/POSE_SCHEMA.md). */
export const MIN_VISIBILITY = 0.5;
export const SIDE_SWITCH_MARGIN = 0.15;

export type PoseStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'running'
  | 'error'
  | 'unavailable';

export interface PoseEngineOptions {
  /** Target detection rate. Camera may run at 30; pose at 20 is plenty. */
  targetFps?: number;
  /** Called for every processed frame. */
  onFrame?: (frame: PoseFrame) => void;
  /** Called when status changes. */
  onStatus?: (status: PoseStatus, detail?: string) => void;
  /** Called when landmarker confidence overall drops. */
  onConfidence?: (meanVisibility: number, peopleCount: number) => void;
}

interface DetectionStats {
  /** Frames where a pose was found at all. */
  detected: number;
  total: number;
  lastDetectionMs: number;
}

export class PoseEngine {
  private landmarker: PoseLandmarker | null = null;
  private status: PoseStatus = 'idle';

  private readonly filters: OneEuroFilter[] = [];
  private activeSide: 'left' | 'right' | null = null;

  private rafId: number | null = null;
  private lastDetectTime = 0;
  private readonly minDetectIntervalMs: number;

  private readonly stats: DetectionStats = { detected: 0, total: 0, lastDetectionMs: 0 };

  /** Rolling window of recent landmark sets, for smoothing short dropouts. */
  private lastGoodFrame: PoseFrame | null = null;

  /**
   * Which asset source actually served the model ('local' or 'cdn').
   * Surfaced so a demo can confirm the offline path engaged instead of
   * discovering at the venue that it silently fell back to the network.
   */
  private assetSource: string | null = null;

  /** Asset source in use, or null before a successful init. */
  getAssetSource(): string | null {
    return this.assetSource;
  }

  constructor(private readonly opts: PoseEngineOptions = {}) {
    const fps = opts.targetFps ?? 20;
    this.minDetectIntervalMs = 1000 / fps;

    // 33 landmarks x 3 coordinates (x, y, z) share one filter each.
    // Positional jitter in normalized coords is typically ~0.005 at rest and
    // spikes to ~0.05 during fast reps, so the filter must adapt.
    for (let i = 0; i < 33 * 3; i++) {
      this.filters.push(new OneEuroFilter({ minCutoff: 1.0, beta: 0.007, dCutoff: 1.0 }));
    }
  }

  getStatus(): PoseStatus {
    return this.status;
  }

  getStats(): Readonly<DetectionStats> {
    return this.stats;
  }

  private setStatus(status: PoseStatus, detail?: string): void {
    this.status = status;
    this.opts.onStatus?.(status, detail);
  }

  /**
   * Load the model. Safe to call more than once.
   *
   * Tries each asset source in turn (local, then CDN) and within each tries GPU
   * before CPU — a school laptop may not have WebGL2, and silently failing here
   * would be worse than running slower.
   */
  async init(): Promise<boolean> {
    if (this.landmarker) return true;
    this.setStatus('loading');

    const failures: string[] = [];

    for (const source of POSE_ASSET_SOURCES) {
      try {
        const fileset = await FilesetResolver.forVisionTasks(source.wasmBase);

        const build = (delegate: 'GPU' | 'CPU') =>
          PoseLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: source.modelUrl, delegate },
            runningMode: 'VIDEO',
            numPoses: 2,
            minPoseDetectionConfidence: 0.5,
            minPosePresenceConfidence: 0.5,
            minTrackingConfidence: 0.5,
          });

        try {
          this.landmarker = await build('GPU');
        } catch {
          this.landmarker = await build('CPU');
        }

        // Recorded so the UI can report whether the offline path actually
        // engaged, rather than assuming it did. Surfaced by `getAssetSource()`
        // in the workout page's camera check (`app/workout/page.tsx`), which
        // renders it as `assets: local` / `assets: cdn`.
        this.assetSource = source.label;
        this.setStatus('ready');
        return true;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        failures.push(`${source.label}: ${detail}`);
        // Fall through to the next source. A missing local copy is expected on
        // a deployment that did not run `fetch:pose-assets`, so it must not be
        // fatal while a usable fallback remains.
      }
    }

    this.setStatus('unavailable', failures.join(' | '));
    return false;
  }

  /** Begin processing a video element. */
  start(video: HTMLVideoElement): void {
    if (!this.landmarker || this.status === 'unavailable') return;
    if (this.rafId !== null) return;
    this.setStatus('running');

    const loop = () => {
      this.rafId = requestAnimationFrame(loop);
      this.tick(video);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.status === 'running') this.setStatus('ready');
  }

  close(): void {
    this.stop();
    this.landmarker?.close();
    this.landmarker = null;
    this.setStatus('idle');
  }

  /** Reset per-session state (side lock, filters, stats). */
  resetSession(): void {
    this.activeSide = null;
    this.lastGoodFrame = null;
    this.stats.detected = 0;
    this.stats.total = 0;
    this.filters.forEach((f) => f.reset());
  }

  private tick(video: HTMLVideoElement): void {
    if (!this.landmarker) return;
    if (video.readyState < 2) return;
    if (video.videoWidth === 0) return;

    const now = performance.now();
    if (now - this.lastDetectTime < this.minDetectIntervalMs) return;
    this.lastDetectTime = now;

    let result: PoseLandmarkerResult;
    const t0 = performance.now();
    try {
      result = this.landmarker.detectForVideo(video, now);
    } catch {
      // Transient WebGL/timestamp errors happen; skip the frame rather than
      // tearing down the engine.
      return;
    }
    this.stats.lastDetectionMs = performance.now() - t0;
    this.stats.total++;

    const timestamp = now / 1000;
    const frame = this.toPoseFrame(result, timestamp);

    if (frame && frame.valid) {
      this.stats.detected++;
      this.lastGoodFrame = frame;
    }

    const peopleCount = result.landmarks?.length ?? 0;
    this.opts.onConfidence?.(frame?.sideVisibility ?? 0, peopleCount);
    this.opts.onFrame?.(frame ?? this.makeInvalidFrame(timestamp, peopleCount));
  }

  private makeInvalidFrame(timestamp: number, peopleCount: number): PoseFrame {
    return {
      timestamp,
      landmarks: [],
      side: this.activeSide ?? 'left',
      valid: false,
      sideVisibility: 0,
    };
  }

  /**
   * Convert a raw MediaPipe result into our normalized PoseFrame.
   *
   * Note on side locking: once a side is chosen we keep it for the session.
   * Switching mid-rep would produce a discontinuous joint-angle signal and
   * break the rep state machine (see docs/POSE_SCHEMA.md §0.1).
   */
  private toPoseFrame(
    result: PoseLandmarkerResult,
    timestamp: number,
  ): PoseFrame | null {
    const all = result.landmarks;
    if (!all || all.length === 0) return null;

    // Pick the most prominent pose. With numPoses=2 the second detection is
    // usually a bystander; the first is the tracked subject.
    const raw = all[0];
    if (!raw || raw.length < 33) return null;

    // --- smoothing ---
    const landmarks: Landmark[] = raw.map((lm, i) => {
      const base = i * 3;
      return {
        x: this.filters[base].filter(lm.x, timestamp),
        y: this.filters[base + 1].filter(lm.y, timestamp),
        z: this.filters[base + 2].filter(lm.z, timestamp),
        visibility: lm.visibility ?? 0,
      };
    });

    const sideVis = computeSideVisibility(landmarks);
    const chosen = chooseActiveSide(
      landmarks,
      this.activeSide,
      sideVis,
      SIDE_SWITCH_MARGIN,
    );

    // Lock the side for the session once we have a confident read.
    if (this.activeSide === null && chosen.score >= MIN_VISIBILITY) {
      this.activeSide = chosen.side;
    }

    const activeIdx = this.activeSide ?? chosen.side;
    const activeScore = activeIdx === 'left' ? sideVis.left : sideVis.right;
    const capability = evaluatePoseCapability(landmarks);
    // Counting does not require ankles. A missing foot must not zero the live counter.
    const valid = capability.canCountRep || activeScore >= MIN_VISIBILITY;

    const worldRaw = result.worldLandmarks?.[0];
    const worldLandmarks: Landmark[] | undefined =
      worldRaw && worldRaw.length >= 25
        ? worldRaw.map((lm) => ({
            x: lm.x,
            y: lm.y,
            z: lm.z ?? 0,
            visibility: lm.visibility ?? 1,
          }))
        : undefined;

    return {
      timestamp,
      landmarks,
      worldLandmarks,
      side: activeIdx,
      valid,
      sideVisibility: activeScore,
      capability,
    };
  }
}
