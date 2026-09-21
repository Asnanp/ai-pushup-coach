/**
 * lib/format.ts — small display formatters.
 *
 * Kept separate so the "--" convention for unavailable data lives in one place.
 */

/** mm:ss, zero-padded. Returns "00:00" for a null/invalid input. */
export function formatClock(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return '00:00';
  }
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Seconds with one decimal, or "--". */
export function formatSeconds(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '--';
  return v.toFixed(digits);
}

/** Percentage with one decimal, or "--". */
export function formatPercent(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '--';
  return `${v.toFixed(digits)}%`;
}

/** Integer with no decimals, or "--". */
export function formatInt(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '--';
  return String(Math.round(v));
}

/** Local date/time for session rows. */
export function formatDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '--';
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '--';
  }
}

export function formatDateShort(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '--';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return '--';
  }
}
