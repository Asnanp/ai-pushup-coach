import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LeaderboardEntry, WorkoutMetrics } from '@ai-pushup-coach/types';
import {
  clearLeaderboard,
  clearSessions,
  getDeviceKey,
  isRemoteEnabled,
  loadLeaderboard,
  loadSessions,
  rankEntries,
  sanitizeName,
  saveLeaderboardEntry,
  saveSession,
} from '@/lib/session-store';

const SESSIONS_KEY = 'aipc:sessions:v1';
const LEADERBOARD_KEY = 'aipc:leaderboard:v1';
const DEVICE_KEY = 'aipc:device:v1';

/**
 * jsdom (when installed) already provides `window` + `localStorage`. When it
 * is not, install a deterministic in-memory Storage so the persistence layer
 * is exercised for real rather than skipped.
 */
function installStorageShim(): void {
  if (typeof globalThis.localStorage === 'undefined') {
    const store = new Map<string, string>();
    const storage: Storage = {
      get length() {
        return store.size;
      },
      clear: () => store.clear(),
      getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
      key: (i: number) => [...store.keys()][i] ?? null,
      removeItem: (k: string) => {
        store.delete(k);
      },
      setItem: (k: string, v: string) => {
        store.set(k, String(v));
      },
    };
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  }
  if (typeof (globalThis as { window?: unknown }).window === 'undefined') {
    Object.defineProperty(globalThis, 'window', { value: globalThis, configurable: true });
  }
}

function makeMetrics(overrides: Partial<WorkoutMetrics> = {}): WorkoutMetrics {
  return {
    totalReps: 10,
    validReps: 8,
    invalidReps: 2,
    formScore: 77.5,
    bestStreak: 5,
    meanRepSeconds: 1.9,
    mostCommonIssue: 'INCOMPLETE_DEPTH',
    scoreStatus: 'ok',
    ...overrides,
  };
}

function entry(overrides: Partial<LeaderboardEntry> = {}): LeaderboardEntry {
  return {
    id: 'x',
    displayName: 'A',
    validReps: 10,
    invalidReps: 0,
    formScore: 80,
    durationSeconds: 60,
    bestStreak: 5,
    mode: 'challenge30',
    createdAt: '2026-01-01T00:00:00.000Z',
    local: true,
    ...overrides,
  };
}

beforeEach(() => {
  installStorageShim();
  globalThis.localStorage.clear();
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getDeviceKey', () => {
  it('mints a key once and returns the same key afterwards', () => {
    const first = getDeviceKey();
    expect(first.length).toBeGreaterThan(0);
    expect(getDeviceKey()).toBe(first);
    expect(globalThis.localStorage.getItem(DEVICE_KEY)).toBe(first);
  });

  it('returns "server" when there is no window (SSR)', () => {
    Object.defineProperty(globalThis, 'window', { value: undefined, configurable: true });
    expect(getDeviceKey()).toBe('server');
    installStorageShim();
  });
});

describe('sanitizeName', () => {
  it('collapses runs of whitespace and trims', () => {
    expect(sanitizeName('  Ada   Lovelace  ')).toBe('Ada Lovelace');
    expect(sanitizeName('a   b')).toBe('a b');
  });

  it('strips control characters outright rather than turning them into spaces', () => {
    expect(sanitizeName('a\u0000b')).toBe('ab');
    expect(sanitizeName('line\nbreak')).toBe('linebreak');
    expect(sanitizeName('tab\there')).toBe('tabhere');
    expect(sanitizeName('\u0001\u0002\u007F')).toBe('');
  });

  it('truncates to 24 characters after normalisation', () => {
    expect(sanitizeName('x'.repeat(30))).toHaveLength(24);
    expect(sanitizeName('x'.repeat(30))).toBe('x'.repeat(24));
    expect(sanitizeName('x'.repeat(25))).toHaveLength(24);
    expect(sanitizeName('x'.repeat(24))).toHaveLength(24);
  });

  it('leaves a clean short name untouched', () => {
    expect(sanitizeName('Sam')).toBe('Sam');
  });
});

describe('rankEntries', () => {
  it('orders by valid reps, then form score, then duration, then creation time', () => {
    const ranked = rankEntries([
      entry({ id: 'few', validReps: 5, formScore: 99, durationSeconds: 10 }),
      entry({ id: 'many-slow', validReps: 20, formScore: 50, durationSeconds: 90 }),
      entry({ id: 'many-fast', validReps: 20, formScore: 50, durationSeconds: 30 }),
      entry({ id: 'many-fast-better', validReps: 20, formScore: 70, durationSeconds: 80 }),
    ]);

    expect(ranked.map((e) => e.id)).toEqual([
      'many-fast-better',
      'many-fast',
      'many-slow',
      'few',
    ]);
  });

  it('breaks a full tie deterministically by createdAt ascending', () => {
    const ranked = rankEntries([
      entry({ id: 'later', createdAt: '2026-01-02T00:00:00.000Z' }),
      entry({ id: 'earlier', createdAt: '2026-01-01T00:00:00.000Z' }),
    ]);
    expect(ranked.map((e) => e.id)).toEqual(['earlier', 'later']);
  });

  it('does not mutate the caller\'s array', () => {
    const input = [entry({ id: 'a', validReps: 1 }), entry({ id: 'b', validReps: 2 })];
    const ranked = rankEntries(input);
    expect(ranked).not.toBe(input);
    expect(input.map((e) => e.id)).toEqual(['a', 'b']);
  });
});

describe('session persistence', () => {
  it('round-trips a saved session and reports it as local-only', async () => {
    const record = await saveSession({
      startedAt: '2026-01-01T10:00:00.000Z',
      endedAt: '2026-01-01T10:01:00.000Z',
      durationSeconds: 60,
      metrics: makeMetrics(),
      reps: [],
      viewType: 'side',
      mode: 'workout',
    });

    expect(record.localOnly).toBe(true);
    expect(record.validReps).toBe(8);
    expect(record.totalReps).toBe(10);

    const loaded = loadSessions();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe(record.id);
    expect(loaded[0].formScore).toBe(77.5);
    expect(loaded[0].reps).toEqual([]);
  });

  it('returns sessions newest-first by startedAt', async () => {
    await saveSession({
      startedAt: '2026-01-01T10:00:00.000Z',
      endedAt: '2026-01-01T10:01:00.000Z',
      durationSeconds: 60,
      metrics: makeMetrics(),
      reps: [],
      viewType: 'side',
      mode: 'workout',
    });
    await saveSession({
      startedAt: '2026-01-03T10:00:00.000Z',
      endedAt: '2026-01-03T10:01:00.000Z',
      durationSeconds: 60,
      metrics: makeMetrics(),
      reps: [],
      viewType: 'front',
      mode: 'workout',
    });

    const loaded = loadSessions();
    expect(loaded).toHaveLength(2);
    expect(loaded[0].startedAt).toBe('2026-01-03T10:00:00.000Z');
    expect(loaded[1].startedAt).toBe('2026-01-01T10:00:00.000Z');
  });

  it('clears stored sessions', async () => {
    await saveSession({
      startedAt: '2026-01-01T10:00:00.000Z',
      endedAt: '2026-01-01T10:01:00.000Z',
      durationSeconds: 60,
      metrics: makeMetrics(),
      reps: [],
      viewType: 'side',
      mode: 'workout',
    });
    expect(loadSessions()).toHaveLength(1);
    clearSessions();
    expect(loadSessions()).toEqual([]);
  });

  it('returns an empty log rather than throwing on corrupt storage', () => {
    globalThis.localStorage.setItem(SESSIONS_KEY, '{not json');
    expect(loadSessions()).toEqual([]);
    globalThis.localStorage.setItem(LEADERBOARD_KEY, 'oops');
    expect(loadLeaderboard()).toEqual([]);
  });

  it('writes a leaderboard row for a challenge session with a display name', async () => {
    await saveSession({
      startedAt: '2026-01-01T10:00:00.000Z',
      endedAt: '2026-01-01T10:01:00.000Z',
      durationSeconds: 60,
      metrics: makeMetrics(),
      reps: [],
      viewType: 'side',
      mode: 'challenge',
      displayName: '  Ada   Lovelace ',
    });

    const board = loadLeaderboard();
    expect(board).toHaveLength(1);
    expect(board[0].displayName).toBe('Ada Lovelace');
    expect(board[0].mode).toBe('challenge30');
    expect(board[0].validReps).toBe(8);
  });

  it('does not write a leaderboard row for a workout without a display name', async () => {
    await saveSession({
      startedAt: '2026-01-01T10:00:00.000Z',
      endedAt: '2026-01-01T10:01:00.000Z',
      durationSeconds: 60,
      metrics: makeMetrics(),
      reps: [],
      viewType: 'side',
      mode: 'workout',
    });
    expect(loadLeaderboard()).toEqual([]);
  });
});

describe('leaderboard persistence', () => {
  it('sanitizes the name and falls back to Anonymous when it is blank', async () => {
    const named = await saveLeaderboardEntry({
      displayName: '  Ada  ',
      validReps: 5,
      invalidReps: 0,
      formScore: 90,
      durationSeconds: 60,
      bestStreak: 5,
      mode: 'challenge30',
    });
    expect(named.displayName).toBe('Ada');
    expect(named.local).toBe(true);

    const blank = await saveLeaderboardEntry({
      displayName: '   \u0000  ',
      validReps: 1,
      invalidReps: 0,
      formScore: 10,
      durationSeconds: 5,
      bestStreak: 1,
      mode: 'challenge30',
    });
    expect(blank.displayName).toBe('Anonymous');
  });

  it('returns entries already ranked', async () => {
    await saveLeaderboardEntry({
      displayName: 'low',
      validReps: 3,
      invalidReps: 0,
      formScore: 90,
      durationSeconds: 30,
      bestStreak: 3,
      mode: 'challenge30',
    });
    await saveLeaderboardEntry({
      displayName: 'high',
      validReps: 30,
      invalidReps: 0,
      formScore: 40,
      durationSeconds: 90,
      bestStreak: 12,
      mode: 'challenge30',
    });

    expect(loadLeaderboard().map((e) => e.displayName)).toEqual(['high', 'low']);
  });

  it('clears the board', async () => {
    await saveLeaderboardEntry({
      displayName: 'Ada',
      validReps: 5,
      invalidReps: 0,
      formScore: 90,
      durationSeconds: 60,
      bestStreak: 5,
      mode: 'challenge30',
    });
    clearLeaderboard();
    expect(loadLeaderboard()).toEqual([]);
  });
});

describe('remote mirror', () => {
  it('is disabled when Supabase env vars are absent', () => {
    expect(isRemoteEnabled()).toBe(false);
  });

  it('is enabled once both env vars are present, without contacting the network', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co/';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    expect(isRemoteEnabled()).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('stays local-only when the remote mirror is unreachable', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );

    const record = await saveSession({
      startedAt: '2026-01-01T10:00:00.000Z',
      endedAt: '2026-01-01T10:01:00.000Z',
      durationSeconds: 60,
      metrics: makeMetrics(),
      reps: [],
      viewType: 'side',
      mode: 'workout',
    });

    expect(record.localOnly).toBe(true);
    expect(loadSessions()).toHaveLength(1);
  });
});
