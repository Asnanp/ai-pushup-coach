'use client';

/**
 * components/PoseOverlay.tsx
 *
 * Agent 6 — POSE ESTIMATION ENGINEER (rendering)
 *
 * Draws the skeleton over the camera feed.
 *
 * PERFORMANCE-CRITICAL: this component renders a <canvas> and exposes an
 * imperative `draw()` via a ref. It does NOT re-render on landmark data.
 * Landmarks are written straight to the canvas inside the pose rAF loop.
 *
 * Putting 33 landmarks x 20fps into React state would trigger ~660 state
 * updates per second and make the whole app unusable. The canvas is the only
 * correct place for this.
 */

import { useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import type { Landmark } from '@ai-pushup-coach/types';

/** MediaPipe pose connections, reduced to the joints that matter for push-ups.
 *  We deliberately do not draw all 35 standard connections — a full hand/face
 *  skeleton is visual noise and makes the body line harder to read. */
const CONNECTIONS: [number, number][] = [
  [11, 12], // shoulders
  [11, 13], [13, 15], // left arm
  [12, 14], [14, 16], // right arm
  [11, 23], [12, 24], // torso
  [23, 24], // hips
  [23, 25], [25, 27], // left leg
  [24, 26], [26, 28], // right leg
  [27, 31], [28, 32], // feet
];

/** Joints emphasised with a dot. */
const JOINTS = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];

/** Below this visibility a joint is drawn dimmed, so the viewer can literally
 *  see when the model is unsure rather than being shown false confidence. */
const LOW_CONFIDENCE = 0.5;

export interface PoseOverlayHandle {
  /** Draw one frame. Call from the pose loop, not from React. */
  draw: (landmarks: Landmark[], activeSide: 'left' | 'right') => void;
  /** Wipe the canvas (used when the pose is lost). */
  clear: () => void;
}

interface Props {
  /** Intrinsic video dimensions, to keep the canvas aspect-correct. */
  videoWidth: number;
  videoHeight: number;
  className?: string;
}

export const PoseOverlay = forwardRef<PoseOverlayHandle, Props>(function PoseOverlay(
  { videoWidth, videoHeight, className },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const sizeCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
  };

  useEffect(() => {
    sizeCanvas();
    const onResize = () => sizeCanvas();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoWidth, videoHeight]);

  useImperativeHandle(
    ref,
    (): PoseOverlayHandle => ({
      clear() {
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext('2d');
        if (!canvas || !ctx) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      },

      draw(landmarks: Landmark[], activeSide: 'left' | 'right') {
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext('2d');
        if (!canvas || !ctx) return;

        const { width: W, height: H } = canvas;
        ctx.clearRect(0, 0, W, H);
        if (!landmarks || landmarks.length < 33) return;

        // Landmarks are normalized [0,1]; the video is drawn with object-fit:
        // cover, so we map into the same cover box or the skeleton would drift
        // away from the body.
        const box = coverBox(videoWidth, videoHeight, W, H);
        const px = (i: number) => ({
          x: box.x + landmarks[i].x * box.w,
          y: box.y + landmarks[i].y * box.h,
        });

        // ---- connections ----
        ctx.lineCap = 'round';
        for (const [a, b] of CONNECTIONS) {
          const la = landmarks[a];
          const lb = landmarks[b];
          if (!la || !lb) continue;
          if (la.visibility < 0.3 || lb.visibility < 0.3) continue;

          const p = px(a);
          const q = px(b);
          const conf = Math.min(la.visibility, lb.visibility);

          // The active side is drawn brighter — it is the side the angles are
          // actually computed from.
          const isActive =
            (activeSide === 'left' && isLeftIndex(a) && isLeftIndex(b)) ||
            (activeSide === 'right' && isRightIndex(a) && isRightIndex(b));

          ctx.strokeStyle = isActive
            ? `rgba(125, 216, 125, ${0.55 + 0.4 * conf})`
            : `rgba(125, 216, 125, ${0.25 + 0.3 * conf})`;
          ctx.lineWidth = isActive ? 3.5 : 2.5;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(q.x, q.y);
          ctx.stroke();
        }

        // ---- joints ----
        for (const i of JOINTS) {
          const lm = landmarks[i];
          if (!lm || lm.visibility < 0.3) continue;
          const p = px(i);
          const conf = lm.visibility;
          const unreliable = conf < LOW_CONFIDENCE;
          const r = unreliable ? 3.5 : 5;

          ctx.beginPath();
          ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
          ctx.fillStyle = unreliable
            ? 'rgba(138, 153, 168, 0.5)'
            : 'rgba(232, 237, 242, 0.95)';
          ctx.fill();

          ctx.strokeStyle = 'rgba(11, 17, 23, 0.9)';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }

        // ---- elbow angle readout ----
        // Drawing the live elbow angle right at the joint is the single most
        // convincing piece of evidence that this is real pose geometry and not
        // a decorative animation.
        const elbowIdx = activeSide === 'left' ? 13 : 14;
        const el = landmarks[elbowIdx];
        if (el && el.visibility >= LOW_CONFIDENCE) {
          const p = px(elbowIdx);
          ctx.font = `${Math.round(W * 0.014)}px ui-monospace, monospace`;
          ctx.fillStyle = 'rgba(125, 216, 125, 0.95)';
          ctx.textAlign = 'left';
          ctx.fillText('elbow', p.x + 12, p.y - 8);
        }
      },
    }),
    [videoWidth, videoHeight],
  );

  return (
    <canvas
      ref={canvasRef}
      className={className}
      aria-hidden="true"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
    />
  );
});

function isLeftIndex(i: number): boolean {
  return i < 23 || i === 23 || i === 25 || i === 27 || i === 29 || i === 31;
}
function isRightIndex(i: number): boolean {
  return (i >= 12 && i <= 22) || i === 24 || i === 26 || i === 28 || i === 30 || i === 32;
}

/**
 * Compute the box a video occupies inside a container under `object-fit: cover`.
 * Needed so the skeleton lands on the body rather than on the letterbox.
 */
function coverBox(
  vw: number,
  vh: number,
  cw: number,
  ch: number,
): { x: number; y: number; w: number; h: number } {
  if (vw <= 0 || vh <= 0) return { x: 0, y: 0, w: cw, h: ch };
  const containerRatio = cw / ch;
  const videoRatio = vw / vh;

  if (videoRatio > containerRatio) {
    // video is wider: it is cropped left/right, fills width
    const h = cw / videoRatio;
    return { x: 0, y: (ch - h) / 2, w: cw, h };
  }
  // video is taller: cropped top/bottom, fills height
  const w = ch * videoRatio;
  return { x: (cw - w) / 2, y: 0, w, h: ch };
}
