'use client';

/**
 * components/CameraStage.tsx
 *
 * Agent 5 — CAMERA ENGINEER + Agent 6 — POSE ENGINEER (integration)
 *
 * The camera panel: <video> + <canvas> overlay + status chrome.
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
        'relative overflow-hidden rounded-card border border-base-border bg-base-sunken',
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

      {/* Top-left: LIVE indicator */}
      <div className="pointer-events-none absolute left-4 top-4 flex items-center gap-2">
        <span
          className={clsx(
            'flex items-center gap-2 rounded-chip border px-2.5 py-1 text-xs font-medium backdrop-blur-sm',
            isLive
              ? 'border-accent-deep bg-base/80 text-accent'
              : 'border-base-border bg-base/80 text-ink-muted',
          )}
        >
          <span
            className={clsx(
              'h-1.5 w-1.5 rounded-full',
              isLive ? 'animate-pulse-dot bg-accent' : 'bg-ink-faint',
            )}
            aria-hidden="true"
          />
          {isLive ? 'Live' : 'Standby'}
        </span>
      </div>

      {/* Top-right: camera status */}
      <div className="pointer-events-none absolute right-4 top-4">
        <span className="flex items-center gap-1.5 rounded-chip border border-base-border bg-base/80 px-2.5 py-1 text-xs text-ink-muted backdrop-blur-sm">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="1.5" y="4" width="9" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
            <path d="M10.5 7.2 L14 5.2 v5.6 L10.5 8.8" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          </svg>
          Camera On
        </span>
      </div>

      {/*
        Centre overlay message (pose lost, paused, etc.). This appears without
        any user action — pose loss auto-pauses the session — so it is a polite
        live region: a screen-reader user must learn that counting has stopped.
      */}
      {overlayMessage && (
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center bg-base/55"
          role="status"
          aria-live="polite"
        >
          <div className="animate-fade-in rounded-card border border-base-border bg-base-raised px-5 py-3 text-center">
            <p className="text-sm font-medium text-ink">{overlayMessage}</p>
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
