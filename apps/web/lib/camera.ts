'use client';

/**
 * lib/camera.ts
 *
 * Agent 5 — CAMERA ENGINEER
 *
 * Owns the MediaStream lifecycle.
 *
 * The failure modes we must handle are all real and all observed in practice:
 *   - permission denied (user clicked "Block", or a previous denial is sticky)
 *   - no camera present
 *   - camera already in use by another app (very common with Zoom/Teams open)
 *   - insecure context (http:// on a LAN IP — getUserMedia is undefined)
 *
 * Critically: every stream must be stopped on unmount. A leaked MediaStream
 * keeps the camera LED on after the user leaves the page, which looks like
 * spyware and would be a legitimate complaint at a public demo.
 */

import type { CaptureError, CaptureErrorCode } from '@ai-pushup-coach/types';

export interface CameraDevice {
  deviceId: string;
  label: string;
}

const ERROR_COPY: Record<CaptureErrorCode, { title: string; detail: string; recoverable: boolean }> = {
  PERMISSION_DENIED: {
    title: 'Camera permission denied',
    detail:
      'Your browser blocked camera access. Click the camera icon in the address bar and allow access, then try again.',
    recoverable: true,
  },
  NO_CAMERA: {
    title: 'No camera found',
    detail: 'We could not find a camera on this device. Connect a webcam and reload the page.',
    recoverable: true,
  },
  CAMERA_IN_USE: {
    title: 'Camera is in use',
    detail:
      'Another application (Zoom, Teams, or another tab) is using the camera. Close it and try again.',
    recoverable: true,
  },
  INSECURE_CONTEXT: {
    title: 'Camera requires a secure connection',
    detail:
      'Camera access only works over https:// or on localhost. Open the app at http://localhost:3000.',
    recoverable: false,
  },
  INIT_FAILED: {
    title: 'Could not start the camera',
    detail: 'The camera started but no video arrived. Try reloading, or select a different camera.',
    recoverable: true,
  },
  MODEL_UNAVAILABLE: {
    title: 'Pose model unavailable',
    detail:
      'The pose detection model could not be loaded. Rep counting is disabled. Check your internet connection and reload.',
    recoverable: true,
  },
  NO_PERSON: {
    title: 'No person detected',
    detail: 'Step into the frame so we can see your full body.',
    recoverable: true,
  },
  MULTIPLE_PEOPLE: {
    title: 'Multiple people detected',
    detail:
      'More than one person is in view. Make sure only the person exercising is visible in the frame.',
    recoverable: true,
  },
  FEET_OUT_OF_FRAME: {
    title: 'Your feet are outside the frame',
    detail: 'Move further from the camera so your whole body, including your feet, is visible.',
    recoverable: true,
  },
  MOVE_FARTHER: {
    title: 'Move further from the camera',
    detail: 'We need to see your full body to measure form accurately.',
    recoverable: true,
  },
  LOW_CONFIDENCE: {
    title: 'Pose confidence is low',
    detail:
      'We can see you but cannot track your joints reliably. Improve the lighting, or move away from a busy background.',
    recoverable: true,
  },
  TURN_SIDEWAYS: {
    title: 'Please turn sideways',
    detail:
      'Side view gives the most accurate push-up analysis. Turn so the camera sees you from the side.',
    recoverable: true,
  },
  BACKEND_UNAVAILABLE: {
    title: 'Analysis service unavailable',
    detail: 'Running with on-device form scoring. Your workout still counts.',
    recoverable: true,
  },
  PAUSED: {
    title: 'Workout paused',
    detail: 'Counting has stopped until your pose is tracked again.',
    recoverable: true,
  },
  UNKNOWN: {
    title: 'Something went wrong',
    detail: 'An unexpected camera error occurred. Reload the page to try again.',
    recoverable: true,
  },
};

export function makeCaptureError(code: CaptureErrorCode): CaptureError {
  const copy = ERROR_COPY[code] ?? ERROR_COPY.UNKNOWN;
  return { code, ...copy };
}

/** Map a getUserMedia DOMException to our error vocabulary. */
function classifyError(err: unknown): CaptureErrorCode {
  if (!(err instanceof Error)) return 'UNKNOWN';
  const name = err.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'PERMISSION_DENIED';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'NO_CAMERA';
  if (name === 'NotReadableError' || name === 'TrackStartError') return 'CAMERA_IN_USE';
  if (name === 'OverconstrainedError') return 'NO_CAMERA';
  return 'UNKNOWN';
}

export interface StartOptions {
  deviceId?: string;
  /** 1280x720 is plenty for pose; 1080p costs CPU for no accuracy gain. */
  width?: number;
  height?: number;
  fps?: number;
}

export class CameraEngine {
  private stream: MediaStream | null = null;

  get isActive(): boolean {
    return this.stream !== null && this.stream.getVideoTracks().some((t) => t.readyState === 'live');
  }

  getStream(): MediaStream | null {
    return this.stream;
  }

  /** Enumerate cameras. Labels are empty until permission has been granted. */
  static async listDevices(): Promise<CameraDevice[]> {
    if (!CameraEngine.isSupported()) return [];
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices
        .filter((d) => d.kind === 'videoinput')
        .map((d, i) => ({
          deviceId: d.deviceId,
          label: d.label || `Camera ${i + 1}`,
        }));
    } catch {
      return [];
    }
  }

  static isSupported(): boolean {
    return (
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function'
    );
  }

  /**
   * Acquire the stream and attach it to a video element.
   * Throws a classified CaptureError rather than a raw DOMException.
   */
  async start(video: HTMLVideoElement, opts: StartOptions = {}): Promise<void> {
    if (!CameraEngine.isSupported()) {
      throw makeCaptureError('INSECURE_CONTEXT');
    }

    await this.stop(); // never leak a previous stream

    const constraints: MediaStreamConstraints = {
      audio: false,
      video: {
        deviceId: opts.deviceId ? { exact: opts.deviceId } : undefined,
        width: { ideal: opts.width ?? 1280 },
        height: { ideal: opts.height ?? 720 },
        frameRate: { ideal: opts.fps ?? 30 },
        facingMode: 'user',
      },
    };

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      // Retry without the device constraint — a stale saved deviceId is a
      // common cause of failure after a laptop switch or driver update.
      if (opts.deviceId) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { width: 1280, height: 720, frameRate: 30 },
          });
        } catch (retryErr) {
          throw makeCaptureError(classifyError(retryErr));
        }
      } else {
        throw makeCaptureError(classifyError(err));
      }
    }

    this.stream = stream;

    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;

    try {
      await video.play();
    } catch {
      throw makeCaptureError('INIT_FAILED');
    }

    // Wait for real dimensions or the pose loop has nothing to read.
    await new Promise<void>((resolve) => {
      if (video.videoWidth > 0) return resolve();
      const done = () => resolve();
      video.addEventListener('loadedmetadata', done, { once: true });
      setTimeout(done, 4000);
    });

    if (video.videoWidth === 0) {
      await this.stop();
      throw makeCaptureError('INIT_FAILED');
    }
  }

  /** Stop all tracks and detach. Safe to call repeatedly. */
  async stop(): Promise<void> {
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop();
      }
      this.stream = null;
    }
  }
}

/** React helper: stop the camera when the component unmounts. */
export function attachLifecycleStop(engine: CameraEngine): () => void {
  return () => {
    void engine.stop();
  };
}
