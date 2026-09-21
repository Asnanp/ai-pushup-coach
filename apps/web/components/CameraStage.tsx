'use client';

/**
 * components/CameraStage.tsx
 *
 * Minimalist camera panel: clean video feed with pose canvas overlay.
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import clsx from 'clsx';
import { PoseOverlay, type PoseOverlayHandle } from './PoseOverlay';
import type { PoseFrame } from '@ai-pushup-coach/types';

export interface CameraStageHandle {
  getVideo: () => HTMLVideoElement | null;
}

interface Props {
  onPoseFrame: (frame: PoseFrame) => void;
  isLive: boolean;
  overlayMessage?: string | null;
  videoWidth: number;
  videoHeight: number;
  className?: string;
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

  useEffect(() => {
    onPoseFrameRef.current = onPoseFrame;
  }, [onPoseFrame]);

  useImperativeHandle(ref, () => ({
    getVideo: () => videoRef.current,
  }));

  const handlePoseFrame = useCallback((frame: PoseFrame) => {
    if (frame.valid && frame.landmarks.length >= 33) {
      overlayRef.current?.draw(frame.landmarks, frame.side);
    } else {
      overlayRef.current?.clear();
    }
    onPoseFrameRef.current(frame);
  }, []);

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

      {/* Minimal Live Indicator */}
      <div className="pointer-events-none absolute left-3 top-3 z-20">
        <span
          className={clsx(
            'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium backdrop-blur-sm',
            isLive
              ? 'border-accent/40 bg-base/80 text-accent'
              : 'border-base-border bg-base/80 text-ink-muted',
          )}
        >
          <span
            className={clsx(
              'h-1.5 w-1.5 rounded-full',
              isLive ? 'bg-accent' : 'bg-ink-faint',
            )}
            aria-hidden="true"
          />
          {isLive ? 'Live' : 'Standby'}
        </span>
      </div>

      {/* Center overlay message */}
      {overlayMessage && (
        <div
          className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-base/60 backdrop-blur-sm"
          role="status"
          aria-live="polite"
        >
          <div className="rounded-card border border-base-border bg-base-raised px-5 py-3 text-center shadow-lg">
            <p className="text-sm font-semibold text-ink">{overlayMessage}</p>
            <p className="mt-1 text-xs text-ink-muted">Tracking resumes when in view</p>
          </div>
        </div>
      )}
    </div>
  );
});

export const poseBridgeRef: { current: ((frame: PoseFrame) => void) | null } = {
  current: null,
};
