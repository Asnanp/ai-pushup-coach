/**
 * packages/rep-counter/src/dropout-bridge.ts
 *
 * If MediaPipe loses a wrist for 1–5 frames, do not destroy the rep.
 * Hold the last good signal. Longer dropouts pause assessment.
 */

import type { RepMotionSignal } from '@ai-pushup-coach/types';

export const SHORT_DROPOUT_FRAMES = 8;

export class DropoutBridge {
  private lastGood: RepMotionSignal | null = null;
  private missing = 0;

  reset(): void {
    this.lastGood = null;
    this.missing = 0;
  }

  push(
    signal: RepMotionSignal | null,
    usable: boolean,
  ): { signal: RepMotionSignal | null; bridged: boolean; paused: boolean } {
    if (usable && signal && Number.isFinite(signal.poseConfidence) && signal.poseConfidence > 0.12) {
      this.lastGood = signal;
      this.missing = 0;
      return { signal, bridged: false, paused: false };
    }
    this.missing += 1;
    if (this.missing <= SHORT_DROPOUT_FRAMES && this.lastGood) {
      return {
        signal: { ...this.lastGood, timestamp: signal?.timestamp ?? this.lastGood.timestamp },
        bridged: true,
        paused: false,
      };
    }
    return { signal: this.lastGood, bridged: false, paused: true };
  }

  getMissing(): number {
    return this.missing;
  }
}
