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

        // Landmarks are normalized [0,1]. Match the contained video bounds so
        // the skeleton remains aligned even when the camera is letterboxed.
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
          if (la.visibility < 0.25 || lb.visibility < 0.25) continue;

          const p = px(a);
          const q = px(b);
          const conf = Math.min(la.visibility, lb.visibility);

          // The active side is drawn brighter — it is the side the angles are
          // actually computed from.
          const isActive =
            (activeSide === 'left' && isLeftIndex(a) && isLeftIndex(b)) ||
            (activeSide === 'right' && isRightIndex(a) && isRightIndex(b));

          ctx.strokeStyle = isActive
            ? `rgba(125, 216, 125, ${0.6 + 0.38 * conf})`
            : `rgba(125, 216, 125, ${0.28 + 0.3 * conf})`;
          ctx.lineWidth = isActive ? 3.5 : 2.5;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(q.x, q.y);
          ctx.stroke();
        }

        // ---- Front-View Foot & Ground Anchor System ----
        // In front view, feet are physically 2m behind the torso in 3D depth,
        // making MediaPipe ankle/foot visibility low (<0.25). We project a clean,
        // high-tech ground anchor so the body is grounded and never looks amputated.
        const shL = landmarks[11];
        const shR = landmarks[12];
        const hipL = landmarks[23];
        const hipR = landmarks[24];
        const ankleL = landmarks[27];
        const ankleR = landmarks[28];
        const footL = landmarks[31];
        const footR = landmarks[32];

        if (shL && shR && hipL && hipR) {
          const pShL = px(11);
          const pShR = px(12);
          const pHipL = px(23);
          const pHipR = px(24);

          const shMid = { x: (pShL.x + pShR.x) / 2, y: (pShL.y + pShR.y) / 2 };
          const hipMid = { x: (pHipL.x + pHipR.x) / 2, y: (pHipL.y + pHipR.y) / 2 };
          const shWidth = Math.hypot(pShL.x - pShR.x, pShL.y - pShR.y);
          const torsoH = Math.hypot(shMid.x - hipMid.x, shMid.y - hipMid.y) || 1e-5;
          const isFrontView = shWidth / torsoH > 0.82;

          const feetFaint =
            (!ankleL || ankleL.visibility < 0.3) &&
            (!ankleR || ankleR.visibility < 0.3) &&
            (!footL || footL.visibility < 0.3) &&
            (!footR || footR.visibility < 0.3);

          if (isFrontView && feetFaint) {
            // Project grounded plank base backward along spine vector
            const spineDx = (hipMid.x - shMid.x) / torsoH;
            const spineDy = (hipMid.y - shMid.y) / torsoH;
            const legProjDist = Math.max(torsoH * 0.9, H * 0.14);

            const anchorLX = pHipL.x + spineDx * legProjDist - shWidth * 0.12;
            const anchorLY = pHipL.y + spineDy * legProjDist;
            const anchorRX = pHipR.x + spineDx * legProjDist + shWidth * 0.12;
            const anchorRY = pHipR.y + spineDy * legProjDist;

            // Dashed depth lines from hips to ground anchors
            ctx.save();
            ctx.setLineDash([5, 4]);
            ctx.strokeStyle = 'rgba(94, 234, 212, 0.45)';
            ctx.lineWidth = 2;

            ctx.beginPath();
            ctx.moveTo(pHipL.x, pHipL.y);
            ctx.lineTo(anchorLX, anchorLY);
            ctx.stroke();

            ctx.beginPath();
            ctx.moveTo(pHipR.x, pHipR.y);
            ctx.lineTo(anchorRX, anchorRY);
            ctx.stroke();

            // Ground base cross-beam connecting feet
            ctx.setLineDash([]);
            ctx.strokeStyle = 'rgba(94, 234, 212, 0.7)';
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            ctx.moveTo(anchorLX, anchorLY);
            ctx.lineTo(anchorRX, anchorRY);
            ctx.stroke();

            // Glowing foot contact pads
            for (const pt of [{ x: anchorLX, y: anchorLY }, { x: anchorRX, y: anchorRY }]) {
              ctx.beginPath();
              ctx.arc(pt.x, pt.y, 6, 0, Math.PI * 2);
              ctx.fillStyle = 'rgba(94, 234, 212, 0.85)';
              ctx.fill();
              ctx.strokeStyle = 'rgba(11, 17, 23, 0.9)';
              ctx.lineWidth = 1.5;
              ctx.stroke();
            }

            // Tag badge
            const tagX = (anchorLX + anchorRX) / 2;
            const tagY = (anchorLY + anchorRY) / 2 + 14;
            ctx.font = `${Math.max(10, Math.round(W * 0.01))}px ui-monospace, monospace`;
            ctx.fillStyle = 'rgba(94, 234, 212, 0.9)';
            ctx.textAlign = 'center';
            ctx.fillText('PLANK BASE · GROUNDED', tagX, tagY);
            ctx.restore();
          } else if (ankleL && ankleR && (ankleL.visibility >= 0.25 || ankleR.visibility >= 0.25)) {
            // When ankles are visible, emphasize foot contact
            const pAnkL = px(27);
            const pAnkR = px(28);
            ctx.save();
            ctx.strokeStyle = 'rgba(125, 216, 125, 0.5)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(pAnkL.x, pAnkL.y);
            ctx.lineTo(pAnkR.x, pAnkR.y);
            ctx.stroke();
            ctx.restore();
          }
        }

        // ---- joints ----
        for (const i of JOINTS) {
          const lm = landmarks[i];
          if (!lm || lm.visibility < 0.25) continue;
          const p = px(i);
          const conf = lm.visibility;
          const unreliable = conf < LOW_CONFIDENCE;
          const r = unreliable ? 3.5 : 5;

          ctx.beginPath();
          ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
          ctx.fillStyle = unreliable
            ? 'rgba(138, 153, 168, 0.55)'
            : 'rgba(232, 237, 242, 0.95)';
          ctx.fill();

          ctx.strokeStyle = 'rgba(11, 17, 23, 0.9)';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }

        // ---- Live Dynamic Elbow Angles & Arcs (Bilateral Aware) ----
        // Instead of a static text label, compute and render the actual joint angle
        // arc with real-time degrees right at the elbow joint.
        const sh11 = landmarks[11];
        const el13 = landmarks[13];
        const wr15 = landmarks[15];
        const sh12 = landmarks[12];
        const el14 = landmarks[14];
        const wr16 = landmarks[16];

        const leftElbowAngle =
          sh11 && el13 && wr15 && el13.visibility >= 0.3
            ? computeJointAngle(px(11), px(13), px(15))
            : null;

        const rightElbowAngle =
          sh12 && el14 && wr16 && el14.visibility >= 0.3
            ? computeJointAngle(px(12), px(14), px(16))
            : null;

        const elbowsToDraw: Array<{
          idx: number;
          angle: number;
          shIdx: number;
          wrIdx: number;
          side: 'left' | 'right';
        }> = [];

        if (leftElbowAngle !== null) {
          elbowsToDraw.push({
            idx: 13,
            angle: leftElbowAngle,
            shIdx: 11,
            wrIdx: 15,
            side: 'left',
          });
        }
        if (rightElbowAngle !== null) {
          elbowsToDraw.push({
            idx: 14,
            angle: rightElbowAngle,
            shIdx: 12,
            wrIdx: 16,
            side: 'right',
          });
        }

        for (const item of elbowsToDraw) {
          const isCurrentActive =
            item.side === activeSide ||
            (sh11 && sh12 && Math.hypot(px(11).x - px(12).x, px(11).y - px(12).y) > 0.15 * W);

          if (!isCurrentActive && elbowsToDraw.length > 1) continue;

          const pCenter = px(item.idx);
          const pSh = px(item.shIdx);
          const pWr = px(item.wrIdx);
          const deg = Math.round(item.angle);

          // Color based on biomechanical depth phase
          const atDepth = deg <= 95;
          const atLockout = deg >= 155;
          const arcColor = atDepth
            ? 'rgba(125, 216, 125, 0.95)'
            : atLockout
              ? 'rgba(94, 234, 212, 0.95)'
              : 'rgba(245, 197, 24, 0.95)';

          // Draw the angle arc
          drawAngleArc(ctx, pCenter, pSh, pWr, Math.max(16, W * 0.02), arcColor, 2.5);

          // Render degree badge
          const offsetSign = item.side === 'left' ? -1 : 1;
          const labelX = pCenter.x + offsetSign * (W * 0.02 + 8);
          const labelY = pCenter.y - 6;

          ctx.save();
          ctx.font = `bold ${Math.max(11, Math.round(W * 0.013))}px ui-monospace, monospace`;
          ctx.fillStyle = arcColor;
          ctx.textAlign = item.side === 'left' ? 'right' : 'left';
          ctx.fillText(`${deg}°`, labelX, labelY);

          if (atDepth) {
            ctx.font = `bold ${Math.max(9, Math.round(W * 0.009))}px sans-serif`;
            ctx.fillStyle = 'rgba(125, 216, 125, 1)';
            ctx.fillText('DEPTH ✓', labelX, labelY + 12);
          }
          ctx.restore();
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

function computeJointAngle(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
): number {
  const v1x = a.x - b.x;
  const v1y = a.y - b.y;
  const v2x = c.x - b.x;
  const v2y = c.y - b.y;
  const dot = v1x * v2x + v1y * v2y;
  const len1 = Math.hypot(v1x, v1y);
  const len2 = Math.hypot(v2x, v2y);
  if (len1 < 1e-6 || len2 < 1e-6) return 180;
  const cos = Math.max(-1, Math.min(1, dot / (len1 * len2)));
  return (Math.acos(cos) * 180) / Math.PI;
}

function drawAngleArc(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  radius: number,
  color: string,
  lineWidth = 2.5,
): void {
  const angle1 = Math.atan2(p1.y - center.y, p1.x - center.x);
  const angle2 = Math.atan2(p2.y - center.y, p2.x - center.x);
  let diff = angle2 - angle1;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  const anticlockwise = diff < 0;

  ctx.save();
  ctx.beginPath();
  ctx.arc(center.x, center.y, radius, angle1, angle2, anticlockwise);
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.stroke();
  ctx.restore();
}

function isLeftIndex(i: number): boolean {
  return (i >= 11 && i <= 21 && i % 2 === 1) || i === 23 || i === 25 || i === 27 || i === 29 || i === 31;
}
function isRightIndex(i: number): boolean {
  return (i >= 12 && i <= 22 && i % 2 === 0) || i === 24 || i === 26 || i === 28 || i === 30 || i === 32;
}

/**
 * Compute the box a video occupies inside a container under `object-fit: contain`.
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
    // video is wider: letterbox above and below
    const h = cw / videoRatio;
    return { x: 0, y: (ch - h) / 2, w: cw, h };
  }
  // video is taller: letterbox left and right
  const w = ch * videoRatio;
  return { x: (cw - w) / 2, y: 0, w, h: ch };
}
