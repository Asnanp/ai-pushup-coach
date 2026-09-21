/**
 * packages/coach-engine/src/voice-coach.ts
 *
 * Agent 14 — VOICE ENGINEER
 *
 * Local browser SpeechSynthesis wrapper:
 * - Local offline operation only (no cloud API)
 * - Modes: 'OFF' | 'NORMAL' | 'ACTIVE'
 * - Automatic cancellation of stale speech
 * - Safe fallback if speech synthesis is unsupported or disabled
 */

export type VoiceCoachMode = 'OFF' | 'NORMAL' | 'ACTIVE';

export interface VoiceCoachOptions {
  mode?: VoiceCoachMode;
  rate?: number;
  pitch?: number;
  lang?: string;
}

export class VoiceCoach {
  private mode: VoiceCoachMode = 'NORMAL';
  private rate = 1.05;
  private pitch = 1.0;
  private lang = 'en-US';
  private lastSpokenText = '';
  private lastSpokenTime = 0;

  constructor(opts: VoiceCoachOptions = {}) {
    if (opts.mode) this.mode = opts.mode;
    if (opts.rate) this.rate = opts.rate;
    if (opts.pitch) this.pitch = opts.pitch;
    if (opts.lang) this.lang = opts.lang;
  }

  setMode(mode: VoiceCoachMode): void {
    this.mode = mode;
    if (mode === 'OFF') {
      this.cancel();
    }
  }

  getMode(): VoiceCoachMode {
    return this.mode;
  }

  speak(text: string, force = false): boolean {
    if (this.mode === 'OFF' && !force) return false;
    if (!text || typeof text !== 'string') return false;

    // Check environment support for SpeechSynthesis
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      return false;
    }

    try {
      const synth = window.speechSynthesis;
      // In NORMAL mode, cancel prior speech to prevent lag/overlap
      synth.cancel();

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = this.rate;
      utterance.pitch = this.pitch;
      utterance.lang = this.lang;

      this.lastSpokenText = text;
      this.lastSpokenTime = Date.now();

      synth.speak(utterance);
      return true;
    } catch {
      // Audio/speech failure must never crash the workout loop
      return false;
    }
  }

  speakEvent(event: 'start' | 'ready' | 'workout_complete' | string): boolean {
    if (event === 'start') return this.speak('Start.');
    if (event === 'ready') return this.speak('Ready.');
    if (event === 'workout_complete') return this.speak('Workout complete.');
    return this.speak(event);
  }

  speakRep(feedback: { spokenMessage?: string | null }, assessment?: { valid?: boolean }): boolean {
    if (feedback && feedback.spokenMessage) {
      return this.speak(feedback.spokenMessage);
    }
    if (this.mode === 'ACTIVE' && assessment?.valid) {
      return this.speak('Good rep.');
    }
    return false;
  }

  cancel(): void {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {}
    }
  }

  stop(): void {
    this.cancel();
  }
}
