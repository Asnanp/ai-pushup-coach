/**
 * components/MetricCard.tsx
 *
 * Minimalist metric card and meter row:
 * Clean, readable numbers with clear semantic tones.
 */

import clsx from 'clsx';

interface MetricCardProps {
  label: string;
  value: number | string | null;
  tone?: 'default' | 'good' | 'bad' | 'neutral';
  caption?: string;
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

  const cardBorder =
    tone === 'good'
      ? 'border-accent/40'
      : tone === 'bad'
        ? 'border-danger/40'
        : 'border-base-border';

  return (
    <div className={clsx('card p-4 transition-colors', cardBorder)}>
      <div className="flex items-center justify-between gap-1.5">
        <span className="metric-label">{label}</span>
        {tone !== 'default' && <ToneDot tone={tone} />}
      </div>
      <div
        className={clsx(
          'mt-1 tabular font-bold tracking-tight',
          emphasis ? 'text-metric' : 'text-metricSm',
          valueTone,
        )}
      >
        {display}
      </div>
      {caption && (
        <div className="mt-0.5 text-xs text-ink-faint">
          {caption}
        </div>
      )}
    </div>
  );
}

function ToneDot({ tone }: { tone: 'good' | 'bad' | 'neutral' }) {
  const dotColor =
    tone === 'good'
      ? 'bg-accent'
      : tone === 'bad'
        ? 'bg-danger'
        : 'bg-ink-faint';

  return (
    <span
      className={clsx('h-1.5 w-1.5 rounded-full', dotColor)}
      aria-hidden="true"
    />
  );
}

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

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs text-ink-muted">{label}</span>
        <span className="tabular font-mono text-xs text-ink">
          {hasValue ? `${Math.round(value)}%` : '--'}
        </span>
      </div>
      <div className="meter mt-1" role="presentation">
        <div
          className={clsx(
            isLow ? 'meter-fill-warn' : 'meter-fill',
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
