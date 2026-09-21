import { describe, expect, it } from 'vitest';

import {
  formatClock,
  formatDateShort,
  formatDateTime,
  formatInt,
  formatPercent,
  formatSeconds,
} from '@/lib/format';

describe('formatClock', () => {
  it('renders mm:ss zero-padded', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(9)).toBe('00:09');
    expect(formatClock(59)).toBe('00:59');
    expect(formatClock(60)).toBe('01:00');
    expect(formatClock(61)).toBe('01:01');
    expect(formatClock(599)).toBe('09:59');
    expect(formatClock(3599)).toBe('59:59');
    expect(formatClock(3600)).toBe('60:00');
  });

  it('floors fractional seconds rather than rounding up', () => {
    expect(formatClock(59.99)).toBe('00:59');
    expect(formatClock(60.5)).toBe('01:00');
  });

  it('falls back to 00:00 for missing or nonsensical input', () => {
    expect(formatClock(null)).toBe('00:00');
    expect(formatClock(undefined)).toBe('00:00');
    expect(formatClock(Number.NaN)).toBe('00:00');
    expect(formatClock(Number.POSITIVE_INFINITY)).toBe('00:00');
    expect(formatClock(Number.NEGATIVE_INFINITY)).toBe('00:00');
    expect(formatClock(-1)).toBe('00:00');
  });

  it('does not collapse on very large values', () => {
    expect(formatClock(1_000_000_000)).toBe('16666666:40');
  });
});

describe('formatSeconds', () => {
  it('formats with one decimal by default', () => {
    expect(formatSeconds(0)).toBe('0.0');
    expect(formatSeconds(1.26)).toBe('1.3');
    expect(formatSeconds(-1.44)).toBe('-1.4');
    expect(formatSeconds(1234.567)).toBe('1234.6');
  });

  it('honours the digits argument', () => {
    expect(formatSeconds(1.23456, 3)).toBe('1.235');
    expect(formatSeconds(1.23456, 0)).toBe('1');
  });

  it('returns -- for missing or non-finite input', () => {
    expect(formatSeconds(null)).toBe('--');
    expect(formatSeconds(undefined)).toBe('--');
    expect(formatSeconds(Number.NaN)).toBe('--');
    expect(formatSeconds(Number.POSITIVE_INFINITY)).toBe('--');
    expect(formatSeconds(-Infinity)).toBe('--');
  });

  it('does not switch to exponential notation at large magnitudes', () => {
    expect(formatSeconds(1e20)).toBe('100000000000000000000.0');
  });
});

describe('formatPercent', () => {
  it('appends a percent sign', () => {
    expect(formatPercent(50)).toBe('50.0%');
    expect(formatPercent(0)).toBe('0.0%');
    expect(formatPercent(100)).toBe('100.0%');
    expect(formatPercent(-12.34)).toBe('-12.3%');
  });

  it('honours the digits argument', () => {
    expect(formatPercent(50, 0)).toBe('50%');
    expect(formatPercent(33.333, 2)).toBe('33.33%');
  });

  it('returns -- for missing or non-finite input', () => {
    expect(formatPercent(null)).toBe('--');
    expect(formatPercent(undefined)).toBe('--');
    expect(formatPercent(Number.NaN)).toBe('--');
    expect(formatPercent(Infinity)).toBe('--');
  });
});

describe('formatInt', () => {
  it('rounds to the nearest integer', () => {
    expect(formatInt(1.4)).toBe('1');
    expect(formatInt(1.5)).toBe('2');
    expect(formatInt(2.5)).toBe('3');
    expect(formatInt(0)).toBe('0');
  });

  it('rounds negatives toward positive infinity (Math.round semantics)', () => {
    expect(formatInt(-1.5)).toBe('-1');
    expect(formatInt(-2.5)).toBe('-2');
    expect(formatInt(-1.6)).toBe('-2');
  });

  it('returns -- for missing or non-finite input', () => {
    expect(formatInt(null)).toBe('--');
    expect(formatInt(undefined)).toBe('--');
    expect(formatInt(Number.NaN)).toBe('--');
    expect(formatInt(-Infinity)).toBe('--');
  });

  it('handles very large magnitudes without precision loss in the string', () => {
    expect(formatInt(1e20)).toBe('100000000000000000000');
  });
});

describe('formatDateTime / formatDateShort', () => {
  it('returns -- for unparseable input instead of throwing', () => {
    for (const bad of ['', 'not a date', '2026-13-45T99:99:99Z']) {
      expect(formatDateTime(bad)).toBe('--');
      expect(formatDateShort(bad)).toBe('--');
    }
  });

  it('renders a valid ISO timestamp with the correct year', () => {
    const out = formatDateTime('2026-03-04T10:15:00.000Z');
    expect(out).not.toBe('--');
    expect(out).toContain('2026');

    const short = formatDateShort('2026-03-04T10:15:00.000Z');
    expect(short).not.toBe('--');
    expect(short.length).toBeGreaterThan(0);
  });
});
