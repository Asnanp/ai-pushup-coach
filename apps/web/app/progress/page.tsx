'use client';

/**
 * app/progress/page.tsx
 *
 * Workout history and trend charts.
 *
 * Original page: Agent 17 — PROGRESS / ANALYTICS ENGINEER.
 * Recharts hardening: Agent 11 — DATA VISUALIZATION ENGINEER.
 *
 * Rules this file holds itself to:
 *
 *   1. Every series is driven by `loadSessions()`. There is no sample data in
 *      this file, not even behind a flag, and no "preview" series invented to
 *      make an empty chart look populated.
 *   2. Missing metrics are SKIPPED, never coerced to 0. A gap in the form-score
 *      line means "no score was recorded for that session", which is a
 *      different statement from "that session scored 0" (FORM_SCORE.md §3.1).
 *   3. Recharts never runs during SSR. The page returns a neutral skeleton until
 *      the post-mount effect has read localStorage — see `sessions === null`
 *      below. That is the mount guard; no `next/dynamic` indirection is needed
 *      because the data itself is client-only, so there is nothing meaningful
 *      for the server to render anyway.
 *
 * All chart colour comes from the design tokens in tailwind.config.ts. Recharts
 * ships light-mode defaults, which read as a bug against this surface, so every
 * stroke/fill/grid/tick is set explicitly.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipProps,
} from 'recharts';
import { fetchSessionsMerged, isRemoteEnabled, type StoredSession } from '@/lib/session-store';
import {
  formatClock,
  formatDateShort,
  formatDateTime,
  formatInt,
  formatPercent,
  formatSeconds,
} from '@/lib/format';
import { issueLabel } from '@ai-pushup-coach/form-engine';

// ---------------------------------------------------------------------------
// Palette — mirrors tailwind.config.ts so SVG attributes and CSS classes agree.
// ---------------------------------------------------------------------------

/** base-border */
const GRID_STROKE = '#E4E4E7';
/** ink-muted — axis ticks and non-semantic series */
const AXIS_TICK = '#71717A';
/** success — form / valid series */
const ACCENT = '#16A34A';
/** danger — invalid reps */
const DANGER = '#DC2626';
/** cyan — secondary telemetry */
const CYAN = '#0891B2';

const AXIS_PROPS = {
  stroke: 'transparent',
  tick: { fill: AXIS_TICK, fontSize: 11 },
  tickLine: false,
  axisLine: false,
} as const;

export default function ProgressPage() {
  const [sessions, setSessions] = useState<StoredSession[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchSessionsMerged().then((rows) => {
      if (!cancelled) setSessions(rows);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const stats = useMemo(() => summarise(sessions ?? []), [sessions]);

  /**
   * Oldest-first, one point per session. `at` is the ISO start timestamp: it is
   * unique per session (unlike a short date, which two sessions can share), and
   * both the axis and the tooltip can be derived from it with lib/format.
   */
  const points = useMemo<SessionPoint[]>(
    () =>
      [...(sessions ?? [])]
        .sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime())
        .map((s) => ({
          id: s.id,
          at: s.startedAt,
          // null when the session produced no usable score — a real gap.
          score: finiteOrNull(s.formScore),
          valid: s.validReps,
          invalid: s.invalidReps,
          total: s.totalReps,
        })),
    [sessions],
  );

  /** Rep-score breakdown for the most recent session (newest first from the store). */
  const latest = sessions?.[0] ?? null;
  const repPoints = useMemo<RepPoint[]>(() => {
    const reps = latest && Array.isArray(latest.reps) ? latest.reps : [];
    return reps.map((r) => ({
      rep: `#${r.repNumber}`,
      validScore: r.valid ? finiteOrNull(r.repScore) : null,
      invalidScore: r.valid ? null : finiteOrNull(r.repScore),
    }));
  }, [latest]);

  const hasScore = points.some((p) => p.score !== null);
  const hasReps = points.some((p) => p.total > 0);
  const hasRepScores = repPoints.some((p) => p.validScore !== null || p.invalidScore !== null);

  if (sessions === null) {
    return <Skeleton />;
  }

  return (
    <div className="mx-auto max-w-[1400px] overflow-x-hidden px-4 py-8 sm:px-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between sm:gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-ink sm:text-display">Progress</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Your workout history and trends.
            {isRemoteEnabled() ? (
              <span className="ml-1 text-ink-faint">Cloud history is on for this device.</span>
            ) : (
              <span className="ml-1 text-ink-faint">Stored locally on this device.</span>
            )}
          </p>
        </div>
        <Link href="/workout" className="btn-primary inline-flex min-h-11 w-full items-center justify-center sm:w-auto">
          New workout
        </Link>
      </header>

      {sessions.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          {/* Summary tiles */}
          <section aria-label="Totals" className="mt-7 grid grid-cols-2 gap-2 sm:gap-4 md:grid-cols-3 lg:grid-cols-6">
            <Tile label="Sessions" value={formatInt(stats.sessions)} />
            <Tile label="Total reps" value={formatInt(stats.totalReps)} />
            <Tile label="Valid reps" value={formatInt(stats.validReps)} tone="good" />
            <Tile
              label="Invalid reps"
              value={formatInt(stats.invalidReps)}
              tone={stats.invalidReps > 0 ? 'bad' : undefined}
            />
            <Tile label="Valid rate" value={formatPercent(stats.validRate)} />
            <Tile
              label="Avg form score"
              value={stats.avgScore === null ? '--' : formatInt(stats.avgScore)}
            />
          </section>

          {/* Charts */}
          <section aria-label="Trend charts" className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-2">
            <ChartCard
              title="Form score over time"
              subtitle="Session form score, 0–100. A gap means no score was recorded."
              ariaLabel="Line chart of session form score out of 100, plotted oldest to newest. Gaps indicate sessions with no recorded score."
            >
              {hasScore ? (
                <LineChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke={GRID_STROKE} vertical={false} />
                  <XAxis
                    dataKey="at"
                    {...AXIS_PROPS}
                    tickFormatter={shortDate}
                    interval="preserveStartEnd"
                    minTickGap={28}
                  />
                  <YAxis {...AXIS_PROPS} domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} width={32} />
                  <Tooltip
                    content={<ChartTooltip labelFormat={longDate} />}
                    cursor={{ stroke: GRID_STROKE, strokeWidth: 1 }}
                  />
                  <Line
                    type="monotone"
                    dataKey="score"
                    name="Form score"
                    stroke={ACCENT}
                    strokeWidth={2}
                    connectNulls={false}
                    dot={{ r: 3, fill: ACCENT, strokeWidth: 0 }}
                    activeDot={{ r: 5 }}
                  />
                </LineChart>
              ) : (
                <ChartNote>
                  No session has a form score yet. A score is recorded once a session contains at
                  least one rep.
                </ChartNote>
              )}
            </ChartCard>

            <ChartCard
              title="Valid vs invalid reps"
              subtitle="Rep count per session, split by verdict."
              ariaLabel="Stacked bar chart of valid and invalid rep counts per session, oldest to newest."
            >
              {hasReps ? (
                <BarChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke={GRID_STROKE} vertical={false} />
                  <XAxis
                    dataKey="at"
                    {...AXIS_PROPS}
                    tickFormatter={shortDate}
                    interval="preserveStartEnd"
                    minTickGap={28}
                  />
                  <YAxis {...AXIS_PROPS} allowDecimals={false} width={32} />
                  <Tooltip content={<ChartTooltip labelFormat={longDate} />} cursor={{ fill: 'rgba(138,153,168,0.08)' }} />
                  <Legend {...LEGEND_PROPS} />
                  <Bar dataKey="valid" name="Valid reps" stackId="reps" fill={ACCENT} maxBarSize={28} />
                  <Bar
                    dataKey="invalid"
                    name="Invalid reps"
                    stackId="reps"
                    fill={DANGER}
                    maxBarSize={28}
                  />
                </BarChart>
              ) : (
                <ChartNote>
                  None of these sessions recorded a completed rep, so there is nothing to split into
                  valid and invalid yet.
                </ChartNote>
              )}
            </ChartCard>

            <ChartCard
              title="Training volume"
              subtitle="Total reps per session (valid + invalid)."
              ariaLabel="Area chart of total reps completed per session, oldest to newest."
            >
              {hasReps ? (
                <AreaChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke={GRID_STROKE} vertical={false} />
                  <XAxis
                    dataKey="at"
                    {...AXIS_PROPS}
                    tickFormatter={shortDate}
                    interval="preserveStartEnd"
                    minTickGap={28}
                  />
                  <YAxis {...AXIS_PROPS} allowDecimals={false} width={32} />
                  <Tooltip content={<ChartTooltip labelFormat={longDate} />} cursor={{ stroke: GRID_STROKE, strokeWidth: 1 }} />
                  <Area
                    type="monotone"
                    dataKey="total"
                    name="Total reps"
                    stroke={AXIS_TICK}
                    strokeWidth={2}
                    fill={AXIS_TICK}
                    fillOpacity={0.14}
                    dot={{ r: 3, fill: AXIS_TICK, strokeWidth: 0 }}
                    activeDot={{ r: 5 }}
                  />
                </AreaChart>
              ) : (
                <ChartNote>No reps have been completed in these sessions yet.</ChartNote>
              )}
            </ChartCard>

            <ChartCard
              title="Latest session breakdown"
              subtitle={
                latest
                  ? `${formatDateTime(latest.startedAt)} · ${formatInt(latest.totalReps)} reps`
                  : 'Per-rep score'
              }
              ariaLabel="Bar chart of the per-rep form score in the most recent session, split into valid and invalid reps."
            >
              {latest && hasRepScores ? (
                <BarChart data={repPoints} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke={GRID_STROKE} vertical={false} />
                  <XAxis dataKey="rep" {...AXIS_PROPS} interval="preserveStartEnd" minTickGap={20} />
                  <YAxis {...AXIS_PROPS} domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} width={32} />
                  <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(138,153,168,0.08)' }} />
                  <Legend {...LEGEND_PROPS} />
                  <Bar
                    dataKey="validScore"
                    name="Valid rep score"
                    stackId="rep"
                    fill={ACCENT}
                    maxBarSize={24}
                  />
                  <Bar
                    dataKey="invalidScore"
                    name="Invalid rep score"
                    stackId="rep"
                    fill={DANGER}
                    maxBarSize={24}
                  />
                </BarChart>
              ) : (
                <ChartNote>
                  {latest
                    ? 'The most recent session has no scored reps to break down.'
                    : 'No session to break down yet.'}
                </ChartNote>
              )}
            </ChartCard>
          </section>

          {/* History table — the accessible, exact-value view of the same data. */}
          <section className="mt-6">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-muted">
              Workout history
            </h2>
            <div className="card mt-3 overflow-x-auto">
              <table className="w-full min-w-[820px] text-sm">
                <caption className="sr-only">
                  Every stored workout session, newest first, with rep counts, form score, pace and
                  the most common issue.
                </caption>
                <thead>
                  <tr className="border-b border-base-border text-left">
                    <Th>Date</Th>
                    <Th>Duration</Th>
                    <Th>Total reps</Th>
                    <Th>Valid</Th>
                    <Th>Invalid</Th>
                    <Th>Form score</Th>
                    <Th>Pace</Th>
                    <Th>Common issue</Th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((s) => (
                    <tr
                      key={s.id}
                      className="border-b border-base-border/60 last:border-0 hover:bg-base-hover/40"
                    >
                      <Td>
                        <span title={formatDateTime(s.startedAt)}>{formatDateShort(s.startedAt)}</span>
                      </Td>
                      <Td mono>{formatClock(s.durationSeconds)}</Td>
                      <Td mono>{formatInt(s.totalReps)}</Td>
                      <Td mono className="text-success">
                        {formatInt(s.validReps)}
                      </Td>
                      <Td mono className={s.invalidReps > 0 ? 'text-danger' : ''}>
                        {formatInt(s.invalidReps)}
                      </Td>
                      <Td mono>{s.formScore === null ? '--' : formatInt(s.formScore)}</Td>
                      <Td mono>
                        {s.meanRepSeconds === null ? '--' : `${formatSeconds(s.meanRepSeconds)}s`}
                      </Td>
                      <Td className="text-ink-muted">
                        {s.mostCommonIssue ? issueLabel(s.mostCommonIssue) : '—'}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chart theming helpers
// ---------------------------------------------------------------------------

/**
 * Legend labels are forced to ink-muted. Recharts colours legend text with the
 * series colour, and the danger red only reaches ~4.4:1 against base-raised —
 * below AA for 11px text. The swatch keeps the colour; the label keeps the
 * contrast, so the series is still named and not distinguished by colour alone.
 */
const LEGEND_PROPS = {
  verticalAlign: 'top',
  align: 'right',
  height: 22,
  iconType: 'square',
  iconSize: 8,
  wrapperStyle: { fontSize: 11, paddingBottom: 6 },
  formatter: (value: unknown) => <span style={{ color: AXIS_TICK }}>{String(value)}</span>,
} as const;

function shortDate(value: string): string {
  return formatDateShort(String(value));
}

function longDate(value: unknown): string {
  return formatDateTime(String(value));
}

/**
 * Dark tooltip. Typed with Recharts' own `TooltipProps`, every field of which is
 * optional — so it can be handed to `content` as an element without a cast.
 * The panel reuses the same surface tokens as every card on the page.
 *
 * Note: Recharts only applies `labelFormatter` inside its own default content.
 * Because we supply custom content, we carry the formatter ourselves as
 * `labelFormat` — Recharts merges injected props over the element's own via
 * `cloneElement`, so this prop survives.
 */
function ChartTooltip({
  active,
  label,
  payload,
  labelFormat,
}: TooltipProps<number, string> & {
  labelFormat?: (label: unknown) => string;
}) {
  if (!active || !payload || payload.length === 0) return null;

  // Skip absent metrics rather than printing a fabricated 0.
  const rows = payload.filter((p) => p.value !== null && p.value !== undefined);
  if (rows.length === 0) return null;

  const heading =
    label === null || label === undefined
      ? null
      : labelFormat
        ? labelFormat(label)
        : String(label);

  return (
    <div className="rounded-control border border-base-border bg-base-raised px-3 py-2 shadow-raised">
      {heading !== null && (
        <div className="mb-1.5 text-xs font-medium text-ink-muted">{heading}</div>
      )}
      <ul className="space-y-1">
        {rows.map((row, i) => (
          <li key={`${String(row.name ?? 'series')}-${i}`} className="flex items-center gap-2 text-xs">
            <span
              aria-hidden="true"
              className="h-2 w-2 shrink-0 rounded-sm"
              style={{ background: row.color ?? AXIS_TICK }}
            />
            <span className="text-ink-muted">{row.name}</span>
            <span className="tabular ml-auto pl-4 font-semibold text-ink">{String(row.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ChartCard({
  title,
  subtitle,
  ariaLabel,
  children,
}: {
  title: string;
  subtitle: string;
  /** Accessible name for the figure — states what is plotted and in what unit. */
  ariaLabel: string;
  children: React.ReactElement;
}) {
  return (
    <figure className="card p-4" aria-label={ariaLabel}>
      <figcaption className="mb-3">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        <p className="text-xs text-ink-faint">{subtitle}</p>
      </figcaption>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          {children}
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

/** Honest stand-in for a chart whose series would otherwise be empty. */
function ChartNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center">
      <p className="max-w-xs text-center text-xs leading-relaxed text-ink-faint">{children}</p>
    </div>
  );
}

function Tile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'good' | 'bad';
}) {
  const borderTone =
    tone === 'good'
      ? 'border-success/30 bg-success/[0.04]'
      : tone === 'bad'
        ? 'border-danger/30 bg-danger/[0.04]'
        : 'border-base-border bg-base-raised';

  return (
    <div className={clsx('card p-2.5 sm:p-4 transition-all duration-200', borderTone)}>
      <div className="metric-label text-[10px] sm:text-label truncate">{label}</div>
      <div
        className={clsx(
          'mt-1.5 tabular font-display text-metricSm font-black',
          tone === 'good' ? 'text-success' : tone === 'bad' ? 'text-danger' : 'text-ink',
        )}
      >
        {value}
      </div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th scope="col" className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-ink-muted">
      {children}
    </th>
  );
}

function Td({
  children,
  mono,
  className = '',
}: {
  children: React.ReactNode;
  mono?: boolean;
  className?: string;
}) {
  return (
    <td className={`px-4 py-3 ${mono ? 'tabular' : ''} ${className}`}>{children}</td>
  );
}

/** Neutral pre-mount placeholder. Contains no fabricated values. */
function Skeleton() {
  return (
    <div className="mx-auto max-w-[1400px] overflow-x-hidden px-4 py-8 sm:px-5">
      <div className="h-9 w-48 animate-pulse rounded bg-base-raised" />
      <div className="mt-3 h-4 w-72 animate-pulse rounded bg-base-raised" />
      <div className="mt-7 grid grid-cols-2 gap-2 sm:gap-4 md:grid-cols-3 lg:grid-cols-6">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="h-20 sm:h-24 animate-pulse rounded-card bg-base-raised" />
        ))}
      </div>
      <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-72 animate-pulse rounded-card bg-base-raised" />
        ))}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="card mt-7 p-10 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-base-border">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M4 16 L10 10 L15 13 L20 8"
            stroke="#8A99A8"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="20" cy="8" r="2" fill="#8A99A8" />
        </svg>
      </div>
      <h2 className="mt-4 text-base font-semibold text-ink">No workouts yet</h2>
      <p className="mx-auto mt-1.5 max-w-md text-sm text-ink-muted">
        Your form score trend, rep breakdown and training volume will appear here once you finish
        your first set. Nothing is charted until there is a real session to chart.
      </p>
      <div className="mt-5 flex w-full flex-col gap-3 sm:flex-row sm:justify-center">
        <Link href="/workout" className="btn-primary inline-flex min-h-11 w-full items-center justify-center sm:w-auto">
          Start your first workout
        </Link>
        <Link href="/tips" className="btn-secondary inline-flex min-h-11 w-full items-center justify-center sm:w-auto">
          Read form tips
        </Link>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

interface SessionPoint {
  id: string;
  /** ISO start timestamp — unique per session; the category axis key. */
  at: string;
  /** null when the session recorded no usable score. */
  score: number | null;
  valid: number;
  invalid: number;
  total: number;
}

interface RepPoint {
  rep: string;
  validScore: number | null;
  invalidScore: number | null;
}

/** null for anything that is not a finite number — never 0. */
function finiteOrNull(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

interface Summary {
  sessions: number;
  totalReps: number;
  validReps: number;
  invalidReps: number;
  /** Valid reps as a percentage of total reps, or null when there are no reps. */
  validRate: number | null;
  avgScore: number | null;
}

function summarise(sessions: StoredSession[]): Summary {
  if (sessions.length === 0) {
    return {
      sessions: 0,
      totalReps: 0,
      validReps: 0,
      invalidReps: 0,
      validRate: null,
      avgScore: null,
    };
  }

  let totalReps = 0;
  let validReps = 0;
  let invalidReps = 0;
  const scores: number[] = [];

  for (const s of sessions) {
    totalReps += s.totalReps;
    validReps += s.validReps;
    invalidReps += s.invalidReps;
    const score = finiteOrNull(s.formScore);
    if (score !== null) scores.push(score);
  }

  return {
    sessions: sessions.length,
    totalReps,
    validReps,
    invalidReps,
    validRate: totalReps > 0 ? (validReps / totalReps) * 100 : null,
    avgScore: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
  };
}
