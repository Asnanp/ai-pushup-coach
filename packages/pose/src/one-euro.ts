/**
 * packages/pose/one-euro.ts
 *
 * One-Euro filter for landmark smoothing.
 *
 * Why not a plain EMA: an EMA forces a single trade-off between lag and
 * jitter. Heavy smoothing makes the elbow-angle signal lag behind fast reps
 * (so the rep counter misses them); light smoothing lets MediaPipe's
 * per-frame noise fake a rep. The One-Euro filter adapts its cutoff frequency
 * to the signal's own speed — heavy smoothing when nearly still, light
 * smoothing during fast movement. That is exactly the behaviour we need for a
 * 15-30 FPS pose stream of a moving human.
 *
 * Reference: Casiez, Roussel, Vogel (CHI 2012), "1€ Filter".
 */

/** Low-pass filter with a fixed cutoff. */
class LowPass {
  private y: number | null = null;

  constructor(private alphaFn?: () => number) {}

  setAlpha(fn: () => number): void {
    this.alphaFn = fn;
  }

  filter(x: number, alpha: number): number {
    this.y = this.y === null ? x : alpha * x + (1 - alpha) * this.y;
    return this.y;
  }

  get last(): number | null {
    return this.y;
  }

  reset(): void {
    this.y = null;
  }
}

function smoothingFactor(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

export interface OneEuroParams {
  /** Minimum cutoff frequency. Lower = smoother when still, but laggier. */
  minCutoff?: number;
  /** Speed coefficient. Higher = more responsive during fast movement. */
  beta?: number;
  /** Cutoff for the derivative estimate. */
  dCutoff?: number;
}

export class OneEuroFilter {
  private readonly minCutoff: number;
  private readonly beta: number;
  private readonly dCutoff: number;

  private xFilter: LowPass;
  private dxFilter: LowPass;

  private lastTime: number | null = null;
  private lastRaw: number | null = null;

  constructor(params: OneEuroParams = {}) {
    this.minCutoff = params.minCutoff ?? 1.0;
    this.beta = params.beta ?? 0.007;
    this.dCutoff = params.dCutoff ?? 1.0;

    this.xFilter = new LowPass();
    this.dxFilter = new LowPass();
  }

  /**
   * @param x  raw signal value
   * @param t  timestamp in SECONDS (not ms)
   */
  filter(x: number, t: number): number {
    if (!Number.isFinite(x)) {
      // Preserve the last output through a dropout rather than injecting NaN.
      return this.xFilter.last ?? 0;
    }

    let dt = 1 / 30;
    if (this.lastTime !== null) {
      dt = t - this.lastTime;
      // Clamp: a tab-switch can produce a multi-second gap which would make
      // the derivative spike and wreck the adaptive cutoff.
      if (dt <= 0 || dt > 1) dt = 1 / 30;
    }
    this.lastTime = t;

    // --- derivative estimate ---
    const dxRaw =
      this.lastRaw === null || dt === 0 ? 0 : (x - this.lastRaw) / dt;
    const dxAlpha = smoothingFactor(this.dCutoff, dt);
    const dx = this.dxFilter.filter(dxRaw, dxAlpha);

    // --- adaptive cutoff ---
    const cutoff = this.minCutoff + this.beta * Math.abs(dx);
    const alpha = smoothingFactor(cutoff, dt);

    this.lastRaw = x;
    return this.xFilter.filter(x, alpha);
  }

  reset(): void {
    this.xFilter.reset();
    this.dxFilter.reset();
    this.lastTime = null;
    this.lastRaw = null;
  }
}
