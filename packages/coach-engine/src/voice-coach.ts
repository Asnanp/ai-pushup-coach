/**
 * packages/coach-engine/src/voice-coach.ts
 *
 * Agent 14 — VOICE ENGINEER
 *
 * Powerful Motivator Voice Coach:
 * - Powered by ElevenLabs TTS API (Adam / Powerful Motivator voice)
 * - Low-latency in-memory audio caching for zero-delay repetition cues
 * - Robust fallback to browser SpeechSynthesis if offline or API unavailable
 * - Modes: 'OFF' | 'NORMAL' | 'ACTIVE' | 'MOTIVATOR'
 */

export type VoiceCoachMode = 'OFF' | 'NORMAL' | 'ACTIVE' | 'MOTIVATOR';

export interface VoiceCoachOptions {
  mode?: VoiceCoachMode;
  rate?: number;
  pitch?: number;
  lang?: string;
  elevenLabsApiKey?: string;
  voiceId?: string;
  useElevenLabs?: boolean;
}

const DEFAULT_ELEVENLABS_KEY = 'sk_45487bcf08fc95552affe5c541b726d3f8c1d4efcb2b5f39';
// Adam — commanding, deep, powerful athletic trainer voice
const DEFAULT_MOTIVATOR_VOICE_ID = 'pNInz6obpgDQGcFmaJgB';

const MOTIVATOR_PHRASES: Record<string, string> = {
  'Start.': "Let's work! Drive through the floor!",
  'Ready.': "Locked and loaded! Get ready to work!",
  'Ready. Starting in three...': "Locked and ready! Three!",
  'Starting in three...': "Lock in! Three!",
  'Two': "Two! Stay focused!",
  'One': "One! Explode!",
  'Go!': "Let's go! Drive it up!",
  'Good rep.': "Strong rep! Keep that power!",
  'Great form, keep it up.': "Unstoppable! Keep that fire!",
  'Better depth.': "There you go! Deep chest!",
  'Much better alignment.': "Locked in! Clean body line!",
  'Go a little lower.': "Get down! Chest to the deck!",
  'Keep your body straight.': "Tighten that core! Straight line!",
  'Keep your hips aligned.': "Hips down! Keep that line tight!",
  'Complete the lockout.': "Lock out at the top! Full extension!",
  'Control your tempo.': "Own the movement! Smooth power!",
  'Workout complete.': "Workout complete! Incredible heart and power!",
};

export class VoiceCoach {
  private mode: VoiceCoachMode = 'NORMAL';
  private rate = 1.05;
  private pitch = 1.0;
  private lang = 'en-US';
  private lastSpokenText = '';
  private lastSpokenTime = 0;

  // ElevenLabs TTS configuration
  private elevenLabsApiKey: string;
  private voiceId: string;
  private useElevenLabs: boolean;
  private readonly audioCache = new Map<string, string>();
  private activeAudio: HTMLAudioElement | null = null;
  private prewarmed = false;

  constructor(opts: VoiceCoachOptions = {}) {
    if (opts.mode) this.mode = opts.mode;
    if (opts.rate) this.rate = opts.rate;
    if (opts.pitch) this.pitch = opts.pitch;
    if (opts.lang) this.lang = opts.lang;
    this.elevenLabsApiKey = opts.elevenLabsApiKey || DEFAULT_ELEVENLABS_KEY;
    this.voiceId = opts.voiceId || DEFAULT_MOTIVATOR_VOICE_ID;
    this.useElevenLabs = opts.useElevenLabs !== false;

    // Trigger background pre-warming for key countdown cues in browser
    if (typeof window !== 'undefined' && this.useElevenLabs && this.elevenLabsApiKey) {
      this.prewarmCommonCues();
    }
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

  setElevenLabsKey(key: string): void {
    this.elevenLabsApiKey = key;
    this.audioCache.clear();
  }

  setVoiceId(voiceId: string): void {
    this.voiceId = voiceId;
    this.audioCache.clear();
  }

  private transformForMotivator(text: string): string {
    if (this.mode !== 'MOTIVATOR') return text;
    return MOTIVATOR_PHRASES[text] || text;
  }

  speak(text: string, force = false): boolean {
    if (this.mode === 'OFF' && !force) return false;
    if (!text || typeof text !== 'string') return false;

    // Node.js environment safety (Check 19 fallback requirement)
    if (typeof window === 'undefined') {
      return false;
    }

    const targetText = this.transformForMotivator(text);

    // 1. Try ElevenLabs cached audio or stream
    if (this.useElevenLabs && this.elevenLabsApiKey) {
      const cached = this.audioCache.get(targetText);
      if (cached) {
        this.playAudio(cached);
        this.lastSpokenText = targetText;
        this.lastSpokenTime = Date.now();
        return true;
      }

      // Try fetching ElevenLabs audio asynchronously
      this.fetchAndPlayElevenLabs(targetText).catch(() => {
        // Fall back to local speech synthesis if ElevenLabs fails
        this.speakLocal(targetText);
      });

      this.lastSpokenText = targetText;
      this.lastSpokenTime = Date.now();
      return true;
    }

    // 2. Local speech synthesis
    return this.speakLocal(targetText);
  }

  private playAudio(url: string): void {
    try {
      if (this.activeAudio) {
        this.activeAudio.pause();
        this.activeAudio.currentTime = 0;
      }
      const audio = new Audio(url);
      this.activeAudio = audio;
      audio.play().catch(() => {});
    } catch {}
  }

  private async fetchAndPlayElevenLabs(text: string): Promise<void> {
    if (!this.elevenLabsApiKey) throw new Error('No API key');

    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}?output_format=mp3_22050_32`, {
      method: 'POST',
      headers: {
        'xi-api-key': this.elevenLabsApiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_flash_v2_5',
        voice_settings: {
          stability: 0.35,
          similarity_boost: 0.85,
          style: 0.65,
          use_speaker_boost: true,
        },
      }),
    });

    if (!res.ok) {
      throw new Error(`ElevenLabs TTS error: ${res.status}`);
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    this.audioCache.set(text, url);
    this.playAudio(url);
  }

  private prewarmCommonCues(): void {
    if (this.prewarmed) return;
    this.prewarmed = true;

    const commonCues = ['Two', 'One', 'Go!', 'Good rep.'];
    for (const cue of commonCues) {
      const text = this.transformForMotivator(cue);
      if (!this.audioCache.has(text)) {
        this.fetchAndPlayElevenLabs(text).catch(() => {});
      }
    }
  }

  speakLocal(text: string): boolean {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      return false;
    }

    try {
      const synth = window.speechSynthesis;
      synth.cancel();

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = this.mode === 'MOTIVATOR' ? 1.15 : this.rate;
      utterance.pitch = this.mode === 'MOTIVATOR' ? 1.05 : this.pitch;
      utterance.lang = this.lang;

      synth.speak(utterance);
      return true;
    } catch {
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
    if ((this.mode === 'ACTIVE' || this.mode === 'MOTIVATOR') && assessment?.valid) {
      return this.speak('Good rep.');
    }
    return false;
  }

  cancel(): void {
    if (this.activeAudio) {
      try {
        this.activeAudio.pause();
        this.activeAudio.currentTime = 0;
      } catch {}
      this.activeAudio = null;
    }
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
