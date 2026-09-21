/**
 * packages/rep-counter/src/event-matching.ts
 *
 * True event-level evaluation. Do not infer TP from total counts.
 */

import type { DetectedRepInterval, EventMatchReport, GroundTruthRep } from '@ai-pushup-coach/types';

function overlap(a: { start: number; end: number }, b: { start: number; end: number }): number {
  const lo = Math.max(a.start, b.start);
  const hi = Math.min(a.end, b.end);
  return Math.max(0, hi - lo);
}

function duration(a: { start: number; end: number }): number {
  return Math.max(1e-6, a.end - a.start);
}

export function matchRepEvents(
  truth: GroundTruthRep[],
  detected: DetectedRepInterval[],
): EventMatchReport {
  const usedDet = new Set<number>();
  let tp = 0;
  for (const g of truth) {
    let best = -1;
    let bestScore = 0;
    for (let i = 0; i < detected.length; i++) {
      if (usedDet.has(i)) continue;
      const d = detected[i];
      const ov = overlap(g, d);
      const score = ov / Math.max(duration(g), duration(d));
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best >= 0 && bestScore >= 0.25) {
      usedDet.add(best);
      tp += 1;
    }
  }
  const fp = detected.length - tp;
  const fn = truth.length - tp;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 1;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 1;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const abs = Math.abs(detected.length - truth.length);
  return {
    tp,
    fp,
    fn,
    precision,
    recall,
    f1,
    mae: abs,
    medianAbsError: abs,
    exactCountRate: detected.length === truth.length ? 1 : 0,
    within1Rate: abs <= 1 ? 1 : 0,
  };
}

export function summarizeEventReports(reports: EventMatchReport[]): EventMatchReport {
  if (reports.length === 0) {
    return {
      tp: 0,
      fp: 0,
      fn: 0,
      precision: 0,
      recall: 0,
      f1: 0,
      mae: 0,
      medianAbsError: 0,
      exactCountRate: 0,
      within1Rate: 0,
    };
  }
  const n = reports.length;
  const sum = reports.reduce(
    (a, r) => ({
      tp: a.tp + r.tp,
      fp: a.fp + r.fp,
      fn: a.fn + r.fn,
      precision: a.precision + r.precision,
      recall: a.recall + r.recall,
      f1: a.f1 + r.f1,
      mae: a.mae + r.mae,
      medianAbsError: a.medianAbsError + r.medianAbsError,
      exactCountRate: a.exactCountRate + r.exactCountRate,
      within1Rate: a.within1Rate + r.within1Rate,
    }),
    {
      tp: 0,
      fp: 0,
      fn: 0,
      precision: 0,
      recall: 0,
      f1: 0,
      mae: 0,
      medianAbsError: 0,
      exactCountRate: 0,
      within1Rate: 0,
    },
  );
  const errors = reports.map((r) => r.mae).sort((a, b) => a - b);
  const mid = Math.floor(errors.length / 2);
  const medianAbsError =
    errors.length % 2 ? errors[mid] : (errors[mid - 1] + errors[mid]) / 2;
  const tp = sum.tp;
  const fp = sum.fp;
  const fn = sum.fn;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 1;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 1;
  return {
    tp,
    fp,
    fn,
    precision,
    recall,
    f1: precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0,
    mae: sum.mae / n,
    medianAbsError,
    exactCountRate: sum.exactCountRate / n,
    within1Rate: sum.within1Rate / n,
  };
}
