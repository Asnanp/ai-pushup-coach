'use client';

/**
 * Real-time numerical traces for live-counter lab mode.
 * Never draws camera pixels — only derived signals.
 */

import { useEffect, useRef } from 'react';

export interface TraceSample {
  t: number;
  leftElbow: number;
  rightElbow: number;
  fused: number;
  worldDepth: number;
  shoulderDepth: number;
  phase: number;
  state: string;
  top: number;
  bottom: number;
  rom: number;
}

const MAX = 240;

const CHANNELS: { key: keyof TraceSample; label: string; color: string; min: number; max: number }[] = [
  { key: 'leftElbow', label: 'LEFT ELBOW', color: '#5eead4', min: 40, max: 180 },
  { key: 'rightElbow', label: 'RIGHT ELBOW', color: '#93c5fd', min: 40, max: 180 },
  { key: 'fused', label: 'FUSED ELBOW', color: '#fbbf24', min: 40, max: 180 },
  { key: 'worldDepth', label: 'WORLD DEPTH', color: '#c4b5fd', min: -0.4, max: 0.4 },
  { key: 'shoulderDepth', label: 'SHOULDER DEPTH', color: '#f9a8d4', min: 0.2, max: 0.8 },
  { key: 'phase', label: 'NORMALIZED PHASE', color: '#34d399', min: 0, max: 1 },
];

export function LiveTraceVisualizer({
  sample,
  state,
  top,
  bottom,
  rom,
}: {
  sample: TraceSample | null;
  state: string;
  top: number;
  bottom: number;
  rom: number;
}) {
  const buf = useRef<TraceSample[]>([]);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  if (sample) {
    buf.current.push(sample);
    if (buf.current.length > MAX) buf.current.shift();
  }

  useEffect(() => {
    let id = 0;
    const draw = () => {
      const canvas = canvasRef.current;
      if (!canvas) {
        id = requestAnimationFrame(draw);
        return;
      }
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w > 0 && (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr))) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        id = requestAnimationFrame(draw);
        return;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#0B1117';
      ctx.fillRect(0, 0, w, h);

      const rows = CHANNELS.length;
      const rowH = h / rows;
      const pts = buf.current;
      CHANNELS.forEach((ch, i) => {
        const y0 = i * rowH;
        ctx.fillStyle = '#111827';
        ctx.fillRect(0, y0 + 2, w, rowH - 4);
        ctx.fillStyle = '#9ca3af';
        ctx.font = '11px ui-monospace, monospace';
        ctx.fillText(ch.label, 8, y0 + 16);
        if (pts.length < 2) return;
        ctx.beginPath();
        ctx.strokeStyle = ch.color;
        ctx.lineWidth = 1.5;
        pts.forEach((p, idx) => {
          const raw = p[ch.key];
          const v = typeof raw === 'number' && Number.isFinite(raw) ? raw : ch.min;
          const x = (idx / Math.max(1, MAX - 1)) * w;
          const n = (v - ch.min) / (ch.max - ch.min);
          const y = y0 + rowH - 6 - Math.max(0, Math.min(1, n)) * (rowH - 18);
          if (idx === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
      });
      id = requestAnimationFrame(draw);
    };
    id = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
        <Stat label="STATE" value={state} />
        <Stat label="TOP EST" value={Number.isFinite(top) ? `${top.toFixed(0)}°` : '--'} />
        <Stat label="BOTTOM EST" value={Number.isFinite(bottom) ? `${bottom.toFixed(0)}°` : '--'} />
        <Stat label="ROM" value={Number.isFinite(rom) ? `${rom.toFixed(0)}°` : '--'} />
        <Stat label="FRAMES" value={String(buf.current.length)} />
      </div>
      <canvas ref={canvasRef} className="h-[420px] w-full rounded-card border border-base-border bg-base" />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-card border border-base-border bg-base-raised px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-ink-faint">{label}</div>
      <div className="font-mono text-sm text-ink">{value}</div>
    </div>
  );
}
