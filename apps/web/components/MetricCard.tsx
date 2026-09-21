/**
 * components/MetricCard.tsx
 *
 * High-visibility athletic metric cards and telemetry progress meters:
 * - High-contrast numerals readable from across a gym floor or exhibition booth
 * - Dual visual cues: color, typography, and SVG indicators
 * - Sports HUD aesthetic with subtle luminous elevation
 */

import clsx from 'clsx';

interface MetricCardProps {
  label: string;
  value: number | string | null;
  /** Semantic tone; drives both colour and the icon. */
  tone?: 'default' | 'good' | 'bad' | 'neutral';
  /** Small caption under the number. */
  caption?: string;
  /** Render the number at the larger size (used for the hero rep count). */
  emphasis?: boolean;
}

export function MetricCard({
  label,
  value,
  tone = 'default',
  caption,
  emphasis = false,
}: MetricCardProps) {
  const display = value === null || value === undefined || value === '' ? '--' : String(value);

  const valueTone =
    tone === 'good'
      ? 'text-accent'
      : tone === 'bad'
        ? 'text-danger'
        : tone === 'neutral'
          ? 'text-ink-muted'
          : 'text-ink';

  const cardStyle =
    tone === 'good'
      ? 'border-accent/30 bg-gradient-to-b from-base-raised to-accent/[0.04] shadow-glow-sm'
      : tone === 'bad'
        ? 'border-danger/30 bg-gradient-to-b from-base-raised to-danger/[0.04]'
        : 'border-base-border/80 bg-base-raised/90';

  return (
    <div className={clsx('card p-4 transition-all duration-200', cardStyle)}>
      <div className="flex items-center justify-between gap-1.5">
        <span className="metric-label text-[10px] sm:text-label truncate">{label}</span>
        {tone !== 'default' && <ToneIcon tone={tone} />}
      </div>
      <div
        className={clsx(
          'mt-1.5 tabular font-display font-black tracking-tight',
          emphasis ? 'text-metric' : 'text-metricSm',
          valueTone,
        )}
      >
        {display}
      </div>
      {caption && (
        <div className="mt-0.5 text-[11px] font-mono text-ink-faint">
          {caption}
        </div>
      )}
    </div>
  );
}

/**
 * Accessible status icon for tone distinction.
 */
function ToneIcon({ tone }: { tone: 'good' | 'bad' | 'neutral' }) {
  if (tone === 'good') {
    return (
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent/15 text-accent" aria-hidden="true">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
          <path
            d="M3 8.5 L6.5 12 L13 4.5"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    );
  }
  if (tone === 'bad') {
    return (
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-danger/15 text-danger" aria-hidden="true">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
          <path
            d="M4.5 4.5 L11.5 11.5 M11.5 4.5 L4.5 11.5"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
        </svg>
      </span>
    );
  }
  return (
    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-base-border text-ink-muted" aria-hidden="true">
      <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="3" fill="currentColor" />
      </svg>
    </span>
  );
}

/**
 * Labeled sports telemetry progress meter used by the Form Analysis panel.
 */
export function MeterRow({
  label,
  value,
  max = 100,
}: {
  label: string;
  value: number | null;
  max?: number;
}) {
  const hasValue = value !== null && Number.isFinite(value);
  const ratio = hasValue ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const isLow = hasValue && ratio < 60;
  const isOptimal = hasValue && ratio >= 80;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium text-ink-muted">{label}</span>
        <div className="flex items-center gap-2">
          {hasValue && isOptimal && (
            <span className="text-[9px] font-mono font-bold text-accent">OPTIMAL</span>
          )}
          <span className="tabular font-mono text-xs font-bold text-ink">
            {hasValue ? `${Math.round(value)}%` : '--'}
          </span>
        </div>
      </div>
      <div className="meter mt-1.5 relative" role="presentation">
        <div
          className={clsx(
            isLow ? 'meter-fill-warn' : 'meter-fill',
            'relative shadow-sm',
          )}
          style={{ width: `${ratio}%` }}
        />
      </div>
      <span className="sr-only">
        {label}: {hasValue ? `${Math.round(value)} percent` : 'not available'}
      </span>
    </div>
  );
}
