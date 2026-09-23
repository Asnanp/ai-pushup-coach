import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CaptureErrorCode } from '@ai-pushup-coach/types';
import { CameraEngine, makeCaptureError } from '@/lib/camera';

/**
 * Compile-time exhaustive list: adding a code to `CaptureErrorCode` without
 * covering it here is a TypeScript error, which is the point.
 */
const COVERAGE: Record<CaptureErrorCode, true> = {
  PERMISSION_DENIED: true,
  NO_CAMERA: true,
  CAMERA_IN_USE: true,
  INSECURE_CONTEXT: true,
  INIT_FAILED: true,
  MODEL_UNAVAILABLE: true,
  NO_PERSON: true,
  MULTIPLE_PEOPLE: true,
  FEET_OUT_OF_FRAME: true,
  MOVE_FARTHER: true,
  LOW_CONFIDENCE: true,
  TURN_SIDEWAYS: true,
  BACKEND_UNAVAILABLE: true,
  PAUSED: true,
  UNKNOWN: true,
};

const ALL_CODES = Object.keys(COVERAGE) as CaptureErrorCode[];

const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

function setNavigator(value: unknown): void {
  Object.defineProperty(globalThis, 'navigator', {
    value,
    configurable: true,
    writable: true,
  });
}

function fakeVideo(overrides: Record<string, unknown> = {}): HTMLVideoElement {
  return {
    srcObject: null,
    muted: false,
    playsInline: false,
    videoWidth: 1280,
    videoHeight: 720,
    play: async () => {},
    addEventListener: () => {},
    ...overrides,
  } as unknown as HTMLVideoElement;
}

function fakeStream(readyState: string = 'live') {
  const track = {
    readyState,
    stop: vi.fn(function stop(this: { readyState: string }) {
      this.readyState = 'ended';
    }),
  };
  const stream = {
    getVideoTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
  return { stream, track };
}

function mediaDevices(getUserMedia: unknown, enumerateDevices?: unknown) {
  return { getUserMedia, enumerateDevices };
}

afterEach(() => {
  if (originalNavigatorDescriptor) {
    Object.defineProperty(globalThis, 'navigator', originalNavigatorDescriptor);
  }
});

describe('makeCaptureError', () => {
  it('produces non-empty title and detail copy for every error code', () => {
    expect(ALL_CODES).toHaveLength(15);

    for (const code of ALL_CODES) {
      const err = makeCaptureError(code);
      expect(err.code, code).toBe(code);
      expect(err.title.length, `title for ${code}`).toBeGreaterThan(0);
      expect(err.detail.length, `detail for ${code}`).toBeGreaterThan(0);
      expect(typeof err.recoverable, `recoverable for ${code}`).toBe('boolean');
    }
  });

  it('marks only the insecure-context failure as unrecoverable', () => {
    expect(makeCaptureError('INSECURE_CONTEXT').recoverable).toBe(false);
    for (const code of ALL_CODES) {
      if (code === 'INSECURE_CONTEXT') continue;
      expect(makeCaptureError(code).recoverable, code).toBe(true);
    }
  });

  it('falls back to the UNKNOWN copy but preserves the requested code', () => {
    const err = makeCaptureError('TOTALLY_MADE_UP' as CaptureErrorCode);
    expect(err.code).toBe('TOTALLY_MADE_UP');
    expect(err.title).toBe(makeCaptureError('UNKNOWN').title);
    expect(err.detail).toBe(makeCaptureError('UNKNOWN').detail);
  });

  it('writes distinct, actionable copy for the common failure modes', () => {
    const titles = new Set(ALL_CODES.map((c) => makeCaptureError(c).title));
    // Every code should have its own headline; duplicates mean copy was pasted.
    expect(titles.size).toBe(ALL_CODES.length);
    expect(makeCaptureError('PERMISSION_DENIED').detail).toMatch(/allow/i);
    expect(makeCaptureError('CAMERA_IN_USE').detail).toMatch(/zoom|teams/i);
  });
});

describe('CameraEngine.isSupported', () => {
  it('is false when getUserMedia is unavailable (insecure context)', () => {
    setNavigator({});
    expect(CameraEngine.isSupported()).toBe(false);
    setNavigator({ mediaDevices: {} });
    expect(CameraEngine.isSupported()).toBe(false);
  });

  it('is true when getUserMedia is a function', () => {
    setNavigator({ mediaDevices: mediaDevices(async () => fakeStream().stream) });
    expect(CameraEngine.isSupported()).toBe(true);
  });
});

describe('CameraEngine.start', () => {
  it('throws INSECURE_CONTEXT when the browser cannot do getUserMedia', async () => {
    setNavigator({});
    const engine = new CameraEngine();
    await expect(engine.start(fakeVideo())).rejects.toMatchObject({
      code: 'INSECURE_CONTEXT',
    });
  });

  it.each([
    ['NotAllowedError', 'PERMISSION_DENIED'],
    ['SecurityError', 'PERMISSION_DENIED'],
    ['NotFoundError', 'NO_CAMERA'],
    ['DevicesNotFoundError', 'NO_CAMERA'],
    ['OverconstrainedError', 'NO_CAMERA'],
    ['NotReadableError', 'CAMERA_IN_USE'],
    ['TrackStartError', 'CAMERA_IN_USE'],
    ['SomethingElseError', 'UNKNOWN'],
  ])('classifies a %s DOMException as %s', async (name, expected) => {
    const err = Object.assign(new Error('boom'), { name });
    setNavigator({ mediaDevices: mediaDevices(async () => Promise.reject(err)) });
    const engine = new CameraEngine();
    await expect(engine.start(fakeVideo())).rejects.toMatchObject({ code: expected });
    expect(engine.getStream()).toBeNull();
  });

  it('classifies a non-Error rejection as UNKNOWN', async () => {
    setNavigator({ mediaDevices: mediaDevices(async () => Promise.reject('nope')) });
    const engine = new CameraEngine();
    await expect(engine.start(fakeVideo())).rejects.toMatchObject({ code: 'UNKNOWN' });
  });

  it('attaches the stream and becomes active on success', async () => {
    const { stream } = fakeStream();
    setNavigator({ mediaDevices: mediaDevices(async () => stream) });

    const video = fakeVideo();
    const engine = new CameraEngine();
    await engine.start(video);

    expect(video.srcObject).toBe(stream);
    expect(video.muted).toBe(true);
    expect(video.playsInline).toBe(true);
    expect(engine.getStream()).toBe(stream);
    expect(engine.isActive).toBe(true);
  });

  it('retries without the device constraint when a stale deviceId fails', async () => {
    const { stream } = fakeStream();
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('gone'), { name: 'NotReadableError' }))
      .mockResolvedValueOnce(stream);
    setNavigator({ mediaDevices: mediaDevices(getUserMedia) });

    const engine = new CameraEngine();
    await expect(engine.start(fakeVideo(), { deviceId: 'stale-id' })).resolves.toBeUndefined();

    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(engine.getStream()).toBe(stream);
    // The retry must drop the stale device constraint.
    const retryConstraints = getUserMedia.mock.calls[1][0] as MediaStreamConstraints;
    expect(JSON.stringify(retryConstraints)).not.toContain('stale-id');
  });

  it('reports the classified error when the retry also fails', async () => {
    const getUserMedia = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('busy'), { name: 'NotReadableError' }));
    setNavigator({ mediaDevices: mediaDevices(getUserMedia) });

    const engine = new CameraEngine();
    await expect(engine.start(fakeVideo(), { deviceId: 'x' })).rejects.toMatchObject({
      code: 'CAMERA_IN_USE',
    });
  });

  it('throws INIT_FAILED when the video element refuses to play', async () => {
    const { stream, track } = fakeStream();
    setNavigator({ mediaDevices: mediaDevices(async () => stream) });
    const engine = new CameraEngine();
    const video = fakeVideo({ play: async () => Promise.reject(new Error('blocked')) });
    await expect(
      engine.start(video),
    ).rejects.toMatchObject({ code: 'INIT_FAILED' });
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(engine.getStream()).toBeNull();
    expect(video.srcObject).toBeNull();
  });
});

describe('CameraEngine.stop', () => {
  it('stops every track, detaches, and is safe to call repeatedly', async () => {
    const { stream, track } = fakeStream();
    setNavigator({ mediaDevices: mediaDevices(async () => stream) });

    const engine = new CameraEngine();
    await engine.start(fakeVideo());
    expect(engine.isActive).toBe(true);

    await engine.stop();
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(engine.getStream()).toBeNull();
    expect(engine.isActive).toBe(false);

    await expect(engine.stop()).resolves.toBeUndefined();
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it('does nothing when no stream was ever acquired', async () => {
    await expect(new CameraEngine().stop()).resolves.toBeUndefined();
  });

  it('is not active when the only track is already ended', async () => {
    const { stream } = fakeStream('ended');
    setNavigator({ mediaDevices: mediaDevices(async () => stream) });
    const engine = new CameraEngine();
    await engine.start(fakeVideo());
    expect(engine.isActive).toBe(false);
  });
});

describe('CameraEngine.listDevices', () => {
  it('returns only video inputs and invents labels for unlabelled cameras', async () => {
    setNavigator({
      mediaDevices: mediaDevices(async () => fakeStream().stream, async () => [
        { kind: 'videoinput', deviceId: 'a', label: '' },
        { kind: 'audioinput', deviceId: 'b', label: 'Built-in Mic' },
        { kind: 'videoinput', deviceId: 'c', label: 'USB Webcam' },
      ]),
    });

    await expect(CameraEngine.listDevices()).resolves.toEqual([
      { deviceId: 'a', label: 'Camera 1' },
      { deviceId: 'c', label: 'USB Webcam' },
    ]);
  });

  it('returns an empty list when enumeration fails or is unsupported', async () => {
    setNavigator({
      mediaDevices: mediaDevices(async () => fakeStream().stream, async () => {
        throw new Error('denied');
      }),
    });
    await expect(CameraEngine.listDevices()).resolves.toEqual([]);

    setNavigator({});
    await expect(CameraEngine.listDevices()).resolves.toEqual([]);
  });
});
