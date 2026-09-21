'use client';

/**
 * components/LiveMotionGraph.tsx
 *
 * Real-time push-up motion waveform graph:
 * - 60fps canvas rendering with zero React re-render overhead
 * - Real-time angle / depth oscilloscope stream
 * - 90° target depth zone (emerald green biofeedback band)
 * - 160° top lockout reference line
 * - Live rep completion spikes with verdict markers
 * - Phase-sensitive gradient curve (descent -> depth -> ascent -> lockout)
 */

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

export interface MotionSample {
  angle: number;
  state?: string;
  progress?: number;
  repCompleted?: {
    repNumber: number;
    score?: number | null;
    valid: boolean;
  } | null;
}

export interface LiveMotionGraphHandle {
  pushSample: (sample: MotionSample) => void;
  reset: () => void;
}

interface Props {
  className?: string;
  height?: number;
  showLabels?: boolean;
}

interface StoredPoint {
  t: number;
  angle: number;
  state: string;
  rep?: {
    repNumber: number;
    score?: number | null;
    valid: boolean;
  };
}

const MAX_POINTS = 160; // ~5-6 seconds of history at 30fps
const MIN_ANGLE_DISPLAY = 60;
const MAX_ANGLE_DISPLAY = 180;

export const LiveMotionGraph = forwardRef<LiveMotionGraphHandle, Props>(
  function LiveMotionGraph({ className = '', height = 150, showLabels = true }, ref) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const pointsRef = useRef<StoredPoint[]>([]);
    const animIdRef = useRef<number | null>(null);
    const lastAngleRef = useRef<number | null>(null);
    const lastStateRef = useRef<string>('TOP');

    // Resize canvas to match display size x devicePixelRatio
    const syncCanvasSize = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (rect.width > 0 && rect.height > 0) {
        canvas.width = Math.round(rect.width * dpr);
        canvas.height = Math.round(rect.height * dpr);
      }
    };

    useEffect(() => {
      syncCanvasSize();
      const handleResize = () => syncCanvasSize();
      window.addEventListener('resize', handleResize);
      return () => window.removeEventListener('resize', handleResize);
    }, []);

    // Continuous rendering loop for ultra-smooth 60fps waveform
    useEffect(() => {
      const render = () => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const W = canvas.width;
        const H = canvas.height;
        ctx.clearRect(0, 0, W, H);

        const pts = pointsRef.current;

        // Coordinate transforms
        const mapY = (angle: number) => {
          const clamped = Math.max(MIN_ANGLE_DISPLAY, Math.min(MAX_ANGLE_DISPLAY, angle));
          // Inverted: higher angle (lockout 160°) near top, lower angle (depth 90°) near bottom
          const norm = (clamped - MIN_ANGLE_DISPLAY) / (MAX_ANGLE_DISPLAY - MIN_ANGLE_DISPLAY);
          return H - norm * H * 0.82 - H * 0.09;
        };

        const mapX = (index: number, total: number) => {
          if (total <= 1) return W;
          return (index / (MAX_POINTS - 1)) * W;
        };

        // 1. Background Grid & Biomechanical Target Zones
        // Depth target band (60° - 90°)
        const y90 = mapY(90);
        const yMin = mapY(MIN_ANGLE_DISPLAY);

        ctx.fillStyle = 'rgba(125, 216, 125, 0.07)';
        ctx.fillRect(0, y90, W, yMin - y90);

        // 90° target depth line
        ctx.save();
        ctx.strokeStyle = 'rgba(125, 216, 125, 0.55)';
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(0, y90);
        ctx.lineTo(W, y90);
        ctx.stroke();

        // 160° lockout line
        const y160 = mapY(160);
        ctx.strokeStyle = 'rgba(94, 234, 212, 0.4)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(0, y160);
        ctx.lineTo(W, y160);
        ctx.stroke();

        // 120° midpoint guide line
        const y120 = mapY(120);
        ctx.strokeStyle = 'rgba(138, 153, 168, 0.15)';
        ctx.setLineDash([2, 6]);
        ctx.beginPath();
        ctx.moveTo(0, y120);
        ctx.lineTo(W, y120);
        ctx.stroke();
        ctx.restore();

        // Zone text labels
        if (showLabels) {
          ctx.save();
          ctx.font = '10px ui-monospace, monospace';
          ctx.fillStyle = 'rgba(94, 234, 212, 0.75)';
          ctx.textAlign = 'right';
          ctx.fillText('160° LOCKOUT', W - 10, y160 - 4);

          ctx.fillStyle = 'rgba(125, 216, 125, 0.85)';
          ctx.fillText('90° TARGET DEPTH', W - 10, y90 - 4);

          ctx.fillStyle = 'rgba(138, 153, 168, 0.4)';
          ctx.fillText('120°', W - 10, y120 - 4);
          ctx.restore();
        }

        if (pts.length < 2) {
          // Placeholder message when waiting for movement
          ctx.save();
          ctx.font = '12px ui-monospace, monospace';
          ctx.fillStyle = 'rgba(138, 153, 168, 0.5)';
          ctx.textAlign = 'center';
          ctx.fillText('Motion waveform waiting for active reps...', W / 2, H / 2);
          ctx.restore();
          animIdRef.current = requestAnimationFrame(render);
          return;
        }

        // 2. Filled Gradient Area Under Waveform
        const startX = mapX(MAX_POINTS - pts.length, MAX_POINTS);
        const grad = ctx.createLinearGradient(0, y160, 0, H);
        grad.addColorStop(0, 'rgba(125, 216, 125, 0.22)');
        grad.addColorStop(0.7, 'rgba(125, 216, 125, 0.05)');
        grad.addColorStop(1, 'rgba(125, 216, 125, 0)');

        ctx.save();
        ctx.beginPath();
        ctx.moveTo(startX, H);

        for (let i = 0; i < pts.length; i++) {
          const x = mapX(MAX_POINTS - pts.length + i, MAX_POINTS);
          const y = mapY(pts[i].angle);
          ctx.lineTo(x, y);
        }
        ctx.lineTo(mapX(MAX_POINTS - 1, MAX_POINTS), H);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.restore();

        // 3. The Waveform Stroke (Colored by Rep Phase)
        ctx.save();
        ctx.lineWidth = 2.5;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';

        for (let i = 1; i < pts.length; i++) {
          const prev = pts[i - 1];
          const curr = pts[i];
          const x0 = mapX(MAX_POINTS - pts.length + i - 1, MAX_POINTS);
          const y0 = mapY(prev.angle);
          const x1 = mapX(MAX_POINTS - pts.length + i, MAX_POINTS);
          const y1 = mapY(curr.angle);

          // Color dynamics:
          // In depth target (<= 95°) -> vibrant emerald green
          // In top lockout (>= 150°) -> cyan
          // In descent/ascent -> golden amber
          let strokeColor = 'rgba(245, 197, 24, 0.9)'; // transition
          if (curr.angle <= 95) {
            strokeColor = 'rgba(125, 216, 125, 1)'; // depth hit
          } else if (curr.angle >= 150) {
            strokeColor = 'rgba(94, 234, 212, 0.95)'; // top
          }

          ctx.strokeStyle = strokeColor;
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
          ctx.stroke();

          // 4. Rep Completion Spikes & Badges
          if (curr.rep) {
            const rep = curr.rep;
            ctx.save();
            ctx.strokeStyle = rep.valid ? 'rgba(125, 216, 125, 0.8)' : 'rgba(248, 113, 113, 0.8)';
            ctx.lineWidth = 2;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(x1, 0);
            ctx.lineTo(x1, H);
            ctx.stroke();

            // Rep marker badge
            const badgeY = Math.max(16, y1 - 18);
            ctx.fillStyle = rep.valid ? 'rgba(125, 216, 125, 0.95)' : 'rgba(248, 113, 113, 0.95)';
            ctx.beginPath();
            ctx.arc(x1, y1, 4.5, 0, Math.PI * 2);
            ctx.fill();

            ctx.font = 'bold 10px ui-monospace, monospace';
            ctx.fillStyle = rep.valid ? '#10b981' : '#f87171';
            ctx.textAlign = 'center';
            ctx.fillText(`#${rep.repNumber}`, x1, badgeY);
            ctx.restore();
          }
        }
        ctx.restore();

        // 5. Leading Edge Live Cursor Dot
        const lastPt = pts[pts.length - 1];
        const curX = mapX(MAX_POINTS - 1, MAX_POINTS);
        const curY = mapY(lastPt.angle);

        ctx.save();
        ctx.beginPath();
        ctx.arc(curX, curY, 6, 0, Math.PI * 2);
        ctx.fillStyle = lastPt.angle <= 95 ? '#7dd87d' : '#5eead4';
        ctx.shadowColor = lastPt.angle <= 95 ? '#7dd87d' : '#5eead4';
        ctx.shadowBlur = 10;
        ctx.fill();

        ctx.strokeStyle = '#0b1117';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.restore();

        animIdRef.current = requestAnimationFrame(render);
      };

      animIdRef.current = requestAnimationFrame(render);
      return () => {
        if (animIdRef.current !== null) cancelAnimationFrame(animIdRef.current);
      };
    }, [showLabels]);

    useImperativeHandle(
      ref,
      (): LiveMotionGraphHandle => ({
        pushSample({ angle, state = 'TOP', repCompleted = null }) {
          if (!Number.isFinite(angle)) return;
          lastAngleRef.current = angle;
          lastStateRef.current = state;

          const pt: StoredPoint = {
            t: performance.now(),
            angle,
            state,
          };
          if (repCompleted) {
            pt.rep = repCompleted;
          }

          pointsRef.current.push(pt);
          if (pointsRef.current.length > MAX_POINTS) {
            pointsRef.current.shift();
          }
        },
        reset() {
          pointsRef.current = [];
          lastAngleRef.current = null;
        },
      }),
      [],
    );

    return (
      <div className={`relative overflow-hidden rounded-card border border-base-border bg-base-sunken/80 backdrop-blur-sm p-3 ${className}`}>
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-accent animate-pulse" aria-hidden="true" />
            <span className="text-xs font-semibold tracking-wider uppercase text-ink">
              Live Motion Waveform
            </span>
            <span className="rounded bg-base-raised px-1.5 py-0.5 text-[10px] font-mono text-ink-muted">
              60 FPS BIOFEEDBACK
            </span>
          </div>
          <div className="flex items-center gap-3 text-xs font-mono">
            <span className="flex items-center gap-1.5 text-accent">
              <span className="inline-block h-2 w-2 rounded-sm bg-accent/40" />
              Target: ≤90°
            </span>
            <span className="flex items-center gap-1.5 text-ink-muted">
              <span className="inline-block h-2 w-2 rounded-sm bg-cyan-400/40" />
              Lockout: ≥160°
            </span>
          </div>
        </div>

        <div style={{ height: `${height}px` }} className="relative w-full">
          <canvas
            ref={canvasRef}
            aria-label="Real-time push-up depth and rep motion oscilloscope curve"
            className="h-full w-full block"
          />
        </div>
      </div>
    );
  },
);
