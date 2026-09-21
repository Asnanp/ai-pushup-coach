/**
 * components/MetricCard.tsx
 *
 * Agent 3 — UI DESIGN SYSTEM ENGINEER
 *
 * The right-hand metric tiles. Three deliberate rules:
 *
 *  1. Larger type than a normal dashboard. The spec requires these be readable
 *     from several metres away at an IT-fest booth, which a standard 24px
 *     metric is not.
 *  2. Valid/invalid never rely on colour alone — each carries a text label and
 *     a distinct icon, so the distinction survives colour-blindness and a
 *     washed-out projector.
 *  3. When a value is unavailable it shows "--". Never 0, never a guess.
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

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="metric-label">{label}</span>
        {tone !== 'default' && <ToneIcon tone={tone} />}
      </div>
      <div
        className={clsx(
          'mt-2 tabular font-bold tracking-tight',
          emphasis ? 'text-metric' : 'text-metricSm',
          valueTone,
        )}
      >
        {display}
      </div>
      {caption && (
        <div className="mt-1 text-xs text-ink-faint">
          {caption}
        </div>
      )}
    </div>
  );
}

/**
 * Icon paired with each tone. This is what makes the good/bad distinction
 * accessible without colour.
 */
function ToneIcon({ tone }: { tone: 'good' | 'bad' | 'neutral' }) {
  if (tone === 'good') {
    return (
      <span className="text-accent" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path
            d="M3 8.5 L6.5 12 L13 4.5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    );
  }
  if (tone === 'bad') {
    return (
      <span className="text-danger" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path
            d="M4.5 4.5 L11.5 11.5 M11.5 4.5 L4.5 11.5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </span>
    );
  }
  return (
    <span className="text-ink-faint" aria-hidden="true">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
        <path d="M4 8 L12 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </span>
  );
}

/**
 * Labeled progress meter used by the Form Analysis panel.
 * Includes the numeric value as text so the reading does not depend on
 * judging a bar length.
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
  const pct = hasValue ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const low = hasValue && pct < 60;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm text-ink-muted">{label}</span>
        <span className="tabular text-sm font-medium text-ink">
          {hasValue ? `${Math.round(value)}%` : '--'}
        </span>
      </div>
      <div className="meter mt-1.5" role="presentation">
        <div
          className={low ? 'meter-fill-warn' : 'meter-fill'}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="sr-only">
        {label}: {hasValue ? `${Math.round(value)} percent` : 'not available'}
      </span>
    </div>
  );
}
