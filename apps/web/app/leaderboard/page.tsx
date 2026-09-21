'use client';

/**
 * app/leaderboard/page.tsx
 *
 * Agent 10 — FRONTEND PAGE ENGINEER
 *
 * The IT-fest scoreboard: 30-second Challenge results, ranked.
 *
 * Why this is a client component: every row lives in localStorage (see
 * lib/session-store.ts), so the server has no board to render. The first render
 * is a neutral skeleton and the real data is read in an effect after mount —
 * reading storage during render would produce server/client markup that
 * disagrees and trip a hydration error in Next 15.
 *
 * Ordering is NOT defined here. It is whatever `rankEntries()` in the store
 * does, and the rule is spelled out in the card below the table so a booth
 * judge can check it against the code.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import {
  clearLeaderboard,
  fetchLeaderboardMerged,
  getDeviceKey,
  isRemoteEnabled,
  loadLeaderboard,
  loadSessions,
  rankEntries,
  sanitizeName,
  type StoredSession,
} from '@/lib/session-store';
import type { LeaderboardEntry } from '@ai-pushup-coach/types';
import { formatDateShort, formatDateTime, formatInt, formatPercent } from '@/lib/format';

/**
 * Page title and description.
 *
 * Deliberately NOT an `export const metadata` object: Next.js rejects the
 * metadata API in a Client Component (see
 * next/dist/server/typescript/rules/metadata.js — "The Next.js 'metadata' API is
 * not allowed in a Client Component"), and this page has to be a client
 * component because it reads localStorage. Next's documented alternative for
 * client components is to render the tags in JSX, which React 19 hoists into
 * <head>. Same result, and the build stays green.
 */
const pageMeta = (
  <>
    <title>Leaderboard — AI Push-Up Coach</title>
    <meta
      name="description"
      content="Challenge mode scores, ranked by valid reps, then form score, then the shortest run."
    />
  </>
);

export default function LeaderboardPage() {
  // null = not read yet. Distinguishing "not read" from "read and empty" is what
  // lets the skeleton and the empty state stay honest.
  const [entries, setEntries] = useState<LeaderboardEntry[] | null>(null);
  const [ownIds, setOwnIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [deviceKey, setDeviceKey] = useState('');
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    const key = getDeviceKey();
    setDeviceKey(key);
    let cancelled = false;
    void fetchLeaderboardMerged().then((board) => {
      if (cancelled) return;
      const ranked = rankEntries(board);
      const sessions = loadSessions();
      setOwnIds(ownEntryIds(ranked, sessions));
      setEntries(ranked);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const stats = useMemo(() => summarise(entries ?? [], ownIds), [entries, ownIds]);

  const handleClear = useCallback(() => {
    clearLeaderboard();
    setEntries([]);
    setOwnIds(new Set<string>());
    setConfirming(false);
  }, []);

  // ---- pre-mount: neutral skeleton, never a guess at the user's data ----
  if (entries === null) {
    return (
      <div className="mx-auto max-w-[1400px] px-5 py-10">
        {pageMeta}
        <div className="h-8 w-56 animate-pulse rounded bg-base-raised" />
        <div className="mt-3 h-4 w-80 animate-pulse rounded bg-base-raised" />
        <div className="mt-7 grid grid-cols-1 gap-4 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-24 animate-pulse rounded-card bg-base-raised" />
          ))}
        </div>
        <div className="mt-6 h-64 animate-pulse rounded-card bg-base-raised" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1400px] px-5 py-8">
      {pageMeta}
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-display font-semibold tracking-tight text-ink">Leaderboard</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Challenge results — 30 seconds of maximum valid push-ups.
            {isRemoteEnabled() ? (
              <span className="ml-1 text-ink-faint">
                Live board from the cloud.
              </span>
            ) : (
              <span className="ml-1 text-ink-faint">Stored locally on this device.</span>
            )}
          </p>
          <p className="mt-1 text-xs text-ink-faint">
            Device scope <span className="tabular text-ink-muted">{deviceKey.slice(0, 8)}</span>
          </p>
        </div>
        <Link href="/challenge" className="btn-primary">
          Start a challenge
        </Link>
      </header>

      {entries.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <section className="mt-7 grid grid-cols-1 gap-4 sm:grid-cols-3" aria-label="Board summary">
            <Tile label="Entries" value={formatInt(stats.count)} />
            <Tile
              label="Best valid reps"
              value={stats.bestReps === null ? '--' : formatInt(stats.bestReps)}
              tone="good"
            />
            <Tile
              label="Your best"
              value={stats.ownBest === null ? '--' : formatInt(stats.ownBest)}
            />
          </section>

          <section className="mt-6" aria-labelledby="board-heading">
            <h2
              id="board-heading"
              className="text-sm font-semibold uppercase tracking-wider text-ink-muted"
            >
              Challenge board
            </h2>

            <div className="card mt-3 overflow-hidden">
              <div className="border-b border-base-border px-4 py-3">
                <p className="text-xs leading-relaxed text-ink-muted">
                  Ordered by valid reps (highest first), then form score, then the shortest run,
                  then the earliest submission. Rows marked{' '}
                  <span className="text-ink">Your run</span> were recorded in this browser.
                </p>
              </div>

              {/* The table is wide on purpose; the wrapper scrolls so the page
                  itself never overflows a phone viewport. */}
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-sm">
                  <caption className="sr-only">
                    Challenge leaderboard for this device: rank, name, valid reps, form score,
                    bad reps, duration, best streak and date. Ranked by valid reps, then form
                    score, then shortest duration, then earliest submission.
                  </caption>
                  <thead>
                    <tr className="border-b border-base-border">
                      <Th className="w-16">Rank</Th>
                      <Th>Name</Th>
                      <Th align="right">Valid reps</Th>
                      <Th align="right">Form score</Th>
                      <Th align="right">Bad reps</Th>
                      <Th align="right">Duration</Th>
                      <Th align="right">Best streak</Th>
                      <Th>Date</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((entry, index) => {
                      const isOwn = ownIds.has(entry.id);
                      const name = sanitizeName(entry.displayName) || 'Anonymous';
                      const rank = index + 1;
                      const isPodium = rank <= 3;
                      const rankBadge =
                        rank === 1
                          ? 'border-ink bg-ink text-base font-bold'
                          : rank === 2
                            ? 'border-base-border bg-base-sunken text-ink font-semibold'
                            : rank === 3
                              ? 'border-base-border bg-base-sunken text-ink-muted font-medium'
                              : 'text-ink-muted';

                      return (
                        <tr
                          key={entry.id}
                          className={clsx(
                            'border-b border-base-border/60 last:border-0 transition-colors',
                            isOwn ? 'bg-accent/[0.05] border-accent/20' : 'hover:bg-base-hover/50',
                          )}
                        >
                          <Td className="tabular">
                            {isPodium ? (
                              <span className={clsx('inline-flex h-6 w-6 items-center justify-center rounded-full border text-xs font-mono', rankBadge)}>
                                {rank}
                              </span>
                            ) : (
                              <span className="text-ink-muted font-mono">{rank}</span>
                            )}
                          </Td>
                          <Td>
                            <span className="flex flex-wrap items-center gap-2">
                              <span className={clsx('text-ink', isOwn && 'font-bold text-accent')}>
                                {name}
                              </span>
                              {isOwn && (
                                <span className="chip-good text-[10px] py-0 px-1.5">
                                  Your run
                                </span>
                              )}
                            </span>
                          </Td>
                          <Td className="tabular text-right font-display text-base font-black text-accent">
                            {formatInt(entry.validReps)}
                          </Td>
                          <Td className="tabular text-right font-mono font-medium">{formatPercent(entry.formScore, 0)}</Td>
                          <Td
                            className={clsx(
                              'tabular text-right font-mono',
                              entry.invalidReps > 0 ? 'text-danger font-semibold' : 'text-ink-muted',
                            )}
                          >
                            {formatInt(entry.invalidReps)}
                          </Td>
                          <Td className="tabular text-right font-mono text-ink-muted">
                            {formatInt(entry.durationSeconds)}s
                          </Td>
                          <Td className="tabular text-right font-mono text-ink-muted">
                            {formatInt(entry.bestStreak)}
                          </Td>
                          <Td className="whitespace-nowrap font-mono text-xs text-ink-muted">
                            <span title={formatDateTime(entry.createdAt)}>
                              {formatDateShort(entry.createdAt)}
                            </span>
                          </Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        </>
      )}

      {/* The rule is stated in full, in the same order rankEntries() sorts. */}
      <section className="mt-6" aria-labelledby="ranking-heading">
        <div className="card p-5">
          <h2 id="ranking-heading" className="text-sm font-semibold text-ink">
            How this board is ranked
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-ink-muted">
            Four keys, applied in order. The same rule runs locally and in the database, so the
            order here matches the server.
          </p>
          <ol className="mt-4 space-y-3">
            <Rule n={1} title="Valid reps — highest first">
              Only reps that passed the form check score. Bad reps are shown but never count
              toward rank, so a fast sloppy set cannot win.
            </Rule>
            <Rule n={2} title="Form score — highest first">
              Tie-break for equal valid reps: the cleaner set wins.
            </Rule>
            <Rule n={3} title="Duration — shortest first">
              Tie-break for equal reps and equal score: the faster run wins.
            </Rule>
            <Rule n={4} title="Submitted at — earliest first">
              Final tie-break. It makes the ordering total, so the board never reshuffles between
              views.
            </Rule>
          </ol>
        </div>
      </section>

      {entries.length > 0 && (
        <section className="mt-6" aria-labelledby="clear-heading">
          <div className="card p-5">
            <h2 id="clear-heading" className="text-sm font-semibold text-ink">
              Clear this board
            </h2>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-ink-muted">
              Deletes the {formatInt(stats.count)}{' '}
              {stats.count === 1 ? 'entry' : 'entries'} stored in this browser. Workout history on
              the Progress page is not affected.
            </p>

            {confirming ? (
              <div className="mt-4 rounded-control border border-danger-dim bg-danger-wash p-4">
                <p className="text-sm text-ink">
                  Delete all {formatInt(stats.count)} {stats.count === 1 ? 'entry' : 'entries'} from
                  this device? This cannot be undone.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" className="btn-danger" onClick={handleClear}>
                    Yes, clear the board
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => setConfirming(false)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="btn-secondary mt-4"
                onClick={() => setConfirming(true)}
              >
                Clear board…
              </button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Own-row attribution
// ---------------------------------------------------------------------------

/**
 * Which rows belong to this device?
 *
 * Leaderboard rows carry no device field, so `getDeviceKey()` cannot be matched
 * against a row directly. What it does give us is the storage scope: every row
 * loaded here was written in this browser under that device key. A row is
 * therefore attributed to this device when it is still local-only AND a
 * Challenge session with the same numbers exists in this browser's history —
 * which is exactly the pair `saveSession()` writes. Booth browsers are shared,
 * so we only claim the runs we can actually match rather than the whole board.
 */
function ownEntryIds(
  board: LeaderboardEntry[],
  sessions: StoredSession[],
): ReadonlySet<string> {
  const challengeSessions = sessions.filter((s) => s.mode === 'challenge');
  const ids = new Set<string>();

  for (const entry of board) {
    if (!entry.local) continue;
    const match = challengeSessions.some(
      (s) =>
        s.validReps === entry.validReps &&
        (s.formScore ?? 0) === entry.formScore &&
        s.durationSeconds === entry.durationSeconds,
    );
    if (match) ids.add(entry.id);
  }

  return ids;
}

interface BoardStats {
  count: number;
  bestReps: number | null;
  ownBest: number | null;
}

function summarise(entries: LeaderboardEntry[], ownIds: ReadonlySet<string>): BoardStats {
  let bestReps: number | null = null;
  let ownBest: number | null = null;

  for (const entry of entries) {
    if (bestReps === null || entry.validReps > bestReps) bestReps = entry.validReps;
    if (ownIds.has(entry.id) && (ownBest === null || entry.validReps > ownBest)) {
      ownBest = entry.validReps;
    }
  }

  return { count: entries.length, bestReps, ownBest };
}

// ---------------------------------------------------------------------------
// Presentational helpers
// ---------------------------------------------------------------------------

function Tile({ label, value, tone }: { label: string; value: string; tone?: 'good' }) {
  return (
    <div className="card p-4">
      <div className="metric-label">{label}</div>
      <div
        className={clsx(
          'tabular mt-1.5 text-metricSm font-bold',
          tone === 'good' ? 'text-accent' : 'text-ink',
        )}
      >
        {value}
      </div>
    </div>
  );
}

function Rule({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        className="tabular mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-chip border border-base-border text-xs text-ink-muted"
        aria-hidden="true"
      >
        {n}
      </span>
      <div>
        <div className="text-sm text-ink">{title}</div>
        <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{children}</p>
      </div>
    </li>
  );
}

function Th({
  children,
  align = 'left',
  className = '',
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={clsx(
        'px-4 py-3 text-xs font-semibold uppercase tracking-wider text-ink-muted',
        align === 'right' ? 'text-right' : 'text-left',
        className,
      )}
    >
      {children}
    </th>
  );
}

function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={clsx('px-4 py-3', className)}>{children}</td>;
}

function EmptyState() {
  return (
    <div className="card mt-7 p-10 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-base-border">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M7 20V13M12 20V9M17 20V15"
            stroke="#8A99A8"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      </div>
      <h2 className="mt-4 text-base font-semibold text-ink">No scores on this board yet</h2>
      <p className="mx-auto mt-1.5 max-w-md text-sm text-ink-muted">
        Scores appear here when someone finishes a Challenge run: 30 seconds of maximum valid
        push-ups, with a name entered before the countdown starts.
      </p>
      <div className="mt-5 flex justify-center">
        <Link href="/challenge" className="btn-primary">
          Start a 30 second challenge
        </Link>
      </div>
      <p className="mt-4 text-xs text-ink-faint">
        Free-mode workouts are saved to Progress, but they do not post a leaderboard score.
      </p>
    </div>
  );
}
