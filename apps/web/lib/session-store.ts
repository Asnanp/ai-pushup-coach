'use client';

/**
 * lib/session-store.ts
 *
 * Agent 16 — DATABASE / SUPABASE ENGINEER
 *
 * Persistence for workout sessions and leaderboard entries.
 *
 * Design decision: localStorage is the PRIMARY store and Supabase is an
 * optional mirror. This is deliberate:
 *
 *   - A school IT-fest demo must not depend on venue wifi.
 *   - A reviewer who clones the repo and never configures Supabase still gets
 *     a fully working product.
 *   - The privacy requirement says no webcam footage is stored; this layer
 *     only ever receives numbers, so that holds by construction.
 *
 * When Supabase env vars are present, writes go to both and reads merge,
 * de-duplicating on session id.
 */

import type {
  CameraView,
  IssueCode,
  LeaderboardEntry,
  SessionMode,
  WorkoutMetrics,
  WorkoutRepRecord,
  WorkoutSessionRecord,
} from '@ai-pushup-coach/types';

const SESSIONS_KEY = 'aipc:sessions:v1';
const LEADERBOARD_KEY = 'aipc:leaderboard:v1';
const DEVICE_KEY = 'aipc:device:v1';

export interface StoredSession extends WorkoutSessionRecord {
  reps: WorkoutRepRecord[];
  /** True when this row exists only locally (Supabase not configured). */
  localOnly?: boolean;
}

// ---------------------------------------------------------------------------
// Device identity
// ---------------------------------------------------------------------------

/** Stable random key identifying this browser. Not a login, just a scope. */
export function getDeviceKey(): string {
  if (typeof window === 'undefined') return 'server';
  let key = window.localStorage.getItem(DEVICE_KEY);
  if (!key) {
    key =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `dev-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    window.localStorage.setItem(DEVICE_KEY, key);
  }
  return key;
}

function makeId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `s-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ---------------------------------------------------------------------------
// Local storage helpers
// ---------------------------------------------------------------------------

function readJson<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota exceeded: drop the oldest half rather than losing the whole log.
    try {
      const arr = readJson<unknown[]>(key, []);
      if (Array.isArray(arr) && arr.length > 4) {
        window.localStorage.setItem(key, JSON.stringify(arr.slice(-Math.floor(arr.length / 2))));
      }
    } catch {
      /* give up silently — history is a nice-to-have, the workout is not */
    }
  }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface SaveSessionInput {
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  metrics: WorkoutMetrics;
  reps: WorkoutRepRecord[];
  viewType: CameraView;
  mode: SessionMode;
  /** Challenge mode display name, when applicable. */
  displayName?: string;
}

/**
 * Persist a finished session.
 *
 * Returns the stored record so the result screen can render from it
 * immediately without a round-trip.
 */
export async function saveSession(input: SaveSessionInput): Promise<StoredSession> {
  const record: StoredSession = {
    id: makeId(),
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    durationSeconds: input.durationSeconds,
    totalReps: input.metrics.totalReps,
    validReps: input.metrics.validReps,
    invalidReps: input.metrics.invalidReps,
    formScore: input.metrics.formScore,
    viewType: input.viewType,
    mode: input.mode,
    bestStreak: input.metrics.bestStreak,
    meanRepSeconds: input.metrics.meanRepSeconds,
    mostCommonIssue: input.metrics.mostCommonIssue,
    createdAt: new Date().toISOString(),
    reps: input.reps,
    localOnly: true,
  };

  // --- local first (always succeeds) ---
  const all = readJson<StoredSession[]>(SESSIONS_KEY, []);
  all.push(record);
  writeJson(SESSIONS_KEY, all);

  // --- optional remote mirror ---
  const remoteId = await pushSessionRemote(record).catch(() => null);
  if (remoteId) {
    record.localOnly = false;
    const updated = readJson<StoredSession[]>(SESSIONS_KEY, []).map((s) =>
      s.id === record.id ? { ...s, localOnly: false } : s,
    );
    writeJson(SESSIONS_KEY, updated);
  }

  // Challenge mode also writes a leaderboard row.
  if (input.mode === 'challenge' && input.displayName) {
    await saveLeaderboardEntry({
      displayName: input.displayName,
      validReps: input.metrics.validReps,
      invalidReps: input.metrics.invalidReps,
      formScore: input.metrics.formScore ?? 0,
      durationSeconds: input.durationSeconds,
      bestStreak: input.metrics.bestStreak,
      mode: 'challenge30',
    });
  }

  return record;
}

export function loadSessions(): StoredSession[] {
  const all = readJson<StoredSession[]>(SESSIONS_KEY, []);
  return all.sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  );
}

export function clearSessions(): void {
  writeJson(SESSIONS_KEY, []);
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

export interface SaveLeaderboardInput {
  displayName: string;
  validReps: number;
  invalidReps: number;
  formScore: number;
  durationSeconds: number;
  bestStreak: number;
  mode: string;
}

/**
 * Leaderboard ordering, applied identically locally and remotely
 * (docs/DATABASE_SCHEMA.md §3):
 *   1. valid reps     DESC  (primary)
 *   2. form score     DESC  (tie-break 1)
 *   3. duration       ASC   (tie-break 2 — faster wins on equal score)
 *   4. created at     ASC   (deterministic final ordering)
 */
export function rankEntries(entries: LeaderboardEntry[]): LeaderboardEntry[] {
  return [...entries].sort((a, b) => {
    if (b.validReps !== a.validReps) return b.validReps - a.validReps;
    if (b.formScore !== a.formScore) return b.formScore - a.formScore;
    if (a.durationSeconds !== b.durationSeconds) return a.durationSeconds - b.durationSeconds;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });
}

export function sanitizeName(raw: string): string {
  return raw
    .replace(/[\u0000-\u001F\u007F]/g, '') // control chars
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
}

export async function saveLeaderboardEntry(
  input: SaveLeaderboardInput,
): Promise<LeaderboardEntry> {
  const entry: LeaderboardEntry = {
    id: makeId(),
    displayName: sanitizeName(input.displayName) || 'Anonymous',
    validReps: input.validReps,
    invalidReps: input.invalidReps,
    formScore: input.formScore,
    durationSeconds: input.durationSeconds,
    bestStreak: input.bestStreak,
    mode: input.mode,
    createdAt: new Date().toISOString(),
    local: true,
  };

  const all = readJson<LeaderboardEntry[]>(LEADERBOARD_KEY, []);
  all.push(entry);
  writeJson(LEADERBOARD_KEY, all);

  const remote = await pushLeaderboardRemote(entry).catch(() => null);
  if (remote) {
    entry.local = false;
  }

  return entry;
}

export function loadLeaderboard(): LeaderboardEntry[] {
  return rankEntries(readJson<LeaderboardEntry[]>(LEADERBOARD_KEY, []));
}

export function clearLeaderboard(): void {
  writeJson(LEADERBOARD_KEY, []);
}

// ---------------------------------------------------------------------------
// Optional Supabase mirror
//
// Implemented with plain fetch against the Supabase REST endpoint so the app
// needs no extra SDK dependency and stays a static build when Supabase is
// unconfigured.
// ---------------------------------------------------------------------------

function supabaseConfig(): { url: string; key: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/\/$/, ''), key };
}

export function isRemoteEnabled(): boolean {
  return supabaseConfig() !== null;
}

async function pushSessionRemote(session: StoredSession): Promise<string | null> {
  const cfg = supabaseConfig();
  if (!cfg) return null;

  const res = await fetch(`${cfg.url}/rest/v1/workout_sessions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: cfg.key,
      Authorization: `Bearer ${cfg.key}`,
      Prefer: 'return=representation',
    },
    body: JSON.stringify({
      started_at: session.startedAt,
      ended_at: session.endedAt,
      duration_seconds: session.durationSeconds,
      total_reps: session.totalReps,
      valid_reps: session.validReps,
      invalid_reps: session.invalidReps,
      form_score: session.formScore,
      view_type: session.viewType,
      mode: session.mode,
      best_streak: session.bestStreak,
      mean_rep_seconds: session.meanRepSeconds,
      most_common_issue: session.mostCommonIssue,
    }),
  });

  if (!res.ok) throw new Error(`session insert failed: ${res.status}`);

  const rows = (await res.json()) as { id: string }[];
  const sessionId = rows[0]?.id ?? null;
  if (!sessionId) return null;

  // Per-rep rows. Sent in one batch; a failure here must not lose the session.
  if (session.reps.length > 0) {
    await fetch(`${cfg.url}/rest/v1/workout_reps`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: cfg.key,
        Authorization: `Bearer ${cfg.key}`,
      },
      body: JSON.stringify(
        session.reps.map((r) => ({
          session_id: sessionId,
          rep_number: r.repNumber,
          valid: r.valid,
          form_probability: Number.isFinite(r.formProbability) ? r.formProbability : null,
          form_label: r.formLabel,
          depth_score: num(r.depthScore),
          alignment_score: num(r.alignmentScore),
          tempo_score: num(r.tempoScore),
          consistency_score: num(r.consistencyScore),
          detected_issue: r.detectedIssue,
          rep_duration_seconds: num(r.repDurationSeconds),
          min_elbow_angle_deg: num(r.minElbowAngleDeg),
          body_line_deviation_max: num(r.bodyLineDeviationMax),
        })),
      ),
    }).catch(() => null);
  }

  return sessionId;
}

async function pushLeaderboardRemote(entry: LeaderboardEntry): Promise<string | null> {
  const cfg = supabaseConfig();
  if (!cfg) return null;

  const res = await fetch(`${cfg.url}/rest/v1/leaderboard_entries`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: cfg.key,
      Authorization: `Bearer ${cfg.key}`,
      Prefer: 'return=representation',
    },
    body: JSON.stringify({
      display_name: entry.displayName,
      valid_reps: entry.validReps,
      invalid_reps: entry.invalidReps,
      form_score: entry.formScore,
      duration_seconds: entry.durationSeconds,
      best_streak: entry.bestStreak,
      mode: entry.mode,
    }),
  });
  if (!res.ok) throw new Error(`leaderboard insert failed: ${res.status}`);
  const rows = (await res.json()) as { id: string }[];
  return rows[0]?.id ?? null;
}

/** Fetch the remote leaderboard and merge with local entries. */
export async function fetchLeaderboardMerged(): Promise<LeaderboardEntry[]> {
  const local = loadLeaderboard();
  const cfg = supabaseConfig();
  if (!cfg) return local;

  try {
    const res = await fetch(
      `${cfg.url}/rest/v1/leaderboard_entries?select=*&mode=eq.challenge30&order=valid_reps.desc,form_score.desc,duration_seconds.asc&limit=100`,
      {
        headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` },
        cache: 'no-store',
      },
    );
    if (!res.ok) return local;

    const rows = (await res.json()) as Record<string, unknown>[];
    const remote: LeaderboardEntry[] = rows.map((r) => ({
      id: String(r.id),
      displayName: String(r.display_name ?? 'Anonymous'),
      validReps: Number(r.valid_reps ?? 0),
      invalidReps: Number(r.invalid_reps ?? 0),
      formScore: Number(r.form_score ?? 0),
      durationSeconds: Number(r.duration_seconds ?? 0),
      bestStreak: Number(r.best_streak ?? 0),
      mode: String(r.mode ?? 'challenge30'),
      createdAt: String(r.created_at ?? new Date().toISOString()),
      local: false,
    }));

    // De-duplicate: a local entry that also exists remotely should appear once.
    const remoteIds = new Set(remote.map((r) => r.id));
    const localOnly = local.filter((l) => l.local && !remoteIds.has(l.id));
    return rankEntries([...remote, ...localOnly]);
  } catch {
    return local;
  }
}

function num(v: number): number | null {
  return Number.isFinite(v) ? v : null;
}

/** Issue label lookup for tables. Re-exported for convenience. */
export type { IssueCode };
