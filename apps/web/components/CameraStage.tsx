'use client';

/**
 * components/CameraStage.tsx
 *
 * The camera panel: <video> + <canvas> overlay + sports HUD viewfinder brackets.
 *
 * Integration contract:
 *   - PoseOverlay is driven imperatively through a ref (no React re-render per
 *     frame). The pose loop calls overlayRef.current.draw(...) directly.
 *   - The pose engine's onFrame callback is passed straight through to the
 *     session, which does its own throttled React updates.
 *   - Nothing in this component re-renders at frame rate.
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import clsx from 'clsx';
import { PoseOverlay, type PoseOverlayHandle } from './PoseOverlay';
import type { PoseFrame } from '@ai-pushup-coach/types';

export interface CameraStageHandle {
  getVideo: () => HTMLVideoElement | null;
}

interface Props {
  /** Called for every pose frame — connect to the workout session. */
  onPoseFrame: (frame: PoseFrame) => void;
  /** Live indicator. */
  isLive: boolean;
  /** Overlay message (e.g. "Pose lost"). */
  overlayMessage?: string | null;
  videoWidth: number;
  videoHeight: number;
  className?: string;
  /** Aspect ratio class for the container. */
  aspect?: string;
}

export const CameraStage = forwardRef<CameraStageHandle, Props>(function CameraStage(
  {
    onPoseFrame,
    isLive,
    overlayMessage,
    videoWidth,
    videoHeight,
    className,
    aspect = 'aspect-video',
  },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayRef = useRef<PoseOverlayHandle | null>(null);
  const onPoseFrameRef = useRef(onPoseFrame);

  // Keep the callback fresh without re-subscribing the engine each render.
  useEffect(() => {
    onPoseFrameRef.current = onPoseFrame;
  }, [onPoseFrame]);

  useImperativeHandle(ref, () => ({
    getVideo: () => videoRef.current,
  }));

  /**
   * Bridge used by the pose engine: lands a frame, draws the skeleton, and
   * forwards to the session. Kept as a stable callback so it can be handed to
   * PoseEngine once at construction.
   */
  const handlePoseFrame = useCallback((frame: PoseFrame) => {
    if (frame.valid && frame.landmarks.length >= 33) {
      overlayRef.current?.draw(frame.landmarks, frame.side);
    } else {
      overlayRef.current?.clear();
    }
    onPoseFrameRef.current(frame);
  }, []);

  // Expose the bridge on a ref so the parent can wire the engine to it.
  useEffect(() => {
    poseBridgeRef.current = handlePoseFrame;
    return () => {
      poseBridgeRef.current = null;
    };
  }, [handlePoseFrame]);

  return (
    <div
      className={clsx(
        'relative overflow-hidden rounded-card border border-base-border/90 bg-base-sunken shadow-2xl hud-bracket',
        aspect,
        className,
      )}
    >
      <video
        ref={videoRef}
        className="absolute inset-0 h-full w-full object-cover"
        playsInline
        muted
        aria-label="Live camera feed for push-up analysis"
      />

      <PoseOverlay
        ref={overlayRef}
        videoWidth={videoWidth}
        videoHeight={videoHeight}
      />

      {/* Top-left: LIVE indicator with glow */}
      <div className="pointer-events-none absolute left-3 sm:left-4 top-3 sm:top-4 flex items-center gap-2 z-20">
        <span
          className={clsx(
            'flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-mono font-bold tracking-wide backdrop-blur-md shadow-sm',
            isLive
              ? 'border-accent/50 bg-base/85 text-accent shadow-glow-sm'
              : 'border-base-border bg-base/85 text-ink-muted',
          )}
        >
          <span
            className={clsx(
              'h-2 w-2 rounded-full',
              isLive ? 'animate-pulse-dot bg-accent' : 'bg-ink-faint',
            )}
            aria-hidden="true"
          />
          {isLive ? 'LIVE MOTION AI' : 'STANDBY'}
        </span>
      </div>

      {/* Top-right: Camera & Vision Engine specs */}
      <div className="pointer-events-none absolute right-3 sm:right-4 top-3 sm:top-4 flex items-center gap-1.5 z-20">
        <span className="hidden sm:flex items-center gap-1.5 rounded-full border border-cyan/30 bg-base/85 px-2.5 py-1 text-[11px] font-mono text-cyan backdrop-blur-md">
          <span className="h-1.5 w-1.5 rounded-full bg-cyan" />
          WASM 60 FPS
        </span>
        <span className="flex items-center gap-1.5 rounded-full border border-base-border bg-base/85 px-2.5 py-1 text-xs font-mono text-ink-muted backdrop-blur-md">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="1.5" y="4" width="9" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
            <path d="M10.5 7.2 L14 5.2 v5.6 L10.5 8.8" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          </svg>
          CAMERA ON
        </span>
      </div>

      {/*
        Centre overlay message (pose lost, paused, etc.).
      */}
      {overlayMessage && (
        <div
          className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-base/65 backdrop-blur-sm"
          role="status"
          aria-live="polite"
        >
          <div className="animate-fade-in rounded-card border border-accent/40 bg-base-raised/95 px-6 py-4 text-center shadow-2xl">
            <p className="text-base font-bold text-ink">{overlayMessage}</p>
            <p className="mt-1 text-xs text-ink-muted">Tracking resumes automatically when visible</p>
          </div>
        </div>
      )}
    </div>
  );
});

/**
 * Module-level bridge so the parent can hand a stable frame callback to the
 * pose engine without prop-drilling it into the pose loop.
 */
export const poseBridgeRef: { current: ((frame: PoseFrame) => void) | null } = {
  current: null,
};
