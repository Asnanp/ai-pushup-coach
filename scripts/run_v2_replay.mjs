#!/usr/bin/env node
/**
 * scripts/run_v2_replay.mjs
 *
 * Runs the full real-video replay benchmark across all processed clips in the dataset
 * through the compiled TypeScript RepCounter production pipeline.
 *
 * Outputs ml/reports/v2_rep_replay.json with:
 *   - Ground truth reps
 *   - Counted reps
 *   - False positives
 *   - Missed reps
 *   - MAE, precision, recall, capture rate
 *   - Detailed breakdowns by: view (front, side, diagonal), quality (good, bad), and subject.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const fixturePath = path.join(repoRoot, 'tests', 'fixtures', 'v2_rep_replay_fixture.json');
const repCounterDist = path.join(repoRoot, 'packages', 'rep-counter', 'dist', 'index.js');
const outReportPath = path.join(repoRoot, 'ml', 'reports', 'v2_rep_replay.json');

if (!existsSync(repCounterDist)) {
  console.error(`Error: compiled rep-counter missing at ${repCounterDist}. Run npm run build:packages first.`);
  process.exit(1);
}

if (!existsSync(fixturePath)) {
  console.error(`Error: fixture missing at ${fixturePath}. Run python ml/scripts/make_v2_replay_fixture.py first.`);
  process.exit(1);
}

const {
  RepCounter,
  calibrateThresholds,
  maskImplausibleAngle,
  FALLBACK_THRESHOLDS,
} = await import(pathToFileURL(repCounterDist).href);

const num = (v) => (v === 'NaN' || v === null || v === undefined ? Number.NaN : Number(v));

const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

const CALIBRATION_SAMPLES = 60;
const CALIBRATION_WINDOW_MAX = 300;
const ADAPTIVE_REFRESH_EVERY = 30;

function replayClip(c) {
  const isFront = c.view === 'front';
  const nFrames = c.n_frames;

  // 1. Synthesize view-aware motion signal for each frame
  const signals = [];
  for (let i = 0; i < nFrames; i++) {
    const t = num(c.frame_times[i]);
    const elLeft = num(c.elbow_angles[i]);
    const elRight = num(c.elbow_angles_opposite[i]);
    const valid = c.valid[i];

    let phaseEvidence = Number.NaN;
    if (isFront) {
      const leftOk = Number.isFinite(elLeft);
      const rightOk = Number.isFinite(elRight);
      if (leftOk && rightOk) {
        phaseEvidence = (elLeft + elRight) * 0.5;
      } else if (leftOk) {
        phaseEvidence = elLeft;
      } else if (rightOk) {
        phaseEvidence = elRight;
      }
    } else {
      phaseEvidence = Number.isFinite(elLeft) ? elLeft : elRight;
    }

    signals.push({
      timestamp: t,
      phaseEvidence,
      elbowAngle: phaseEvidence,
      valid,
    });
  }

  // 2. Run calibration on available samples
  const counter = new RepCounter();
  const calibSamples = [];
  let calibFrames = 0;

  for (let i = 0; i < signals.length; i++) {
    const sig = signals[i];
    if (sig.valid && Number.isFinite(sig.phaseEvidence)) {
      const filtered = counter.observe(sig.phaseEvidence);
      if (Number.isFinite(filtered)) {
        calibSamples.push(filtered);
        if (calibSamples.length > CALIBRATION_WINDOW_MAX) {
          calibSamples.splice(0, calibSamples.length - CALIBRATION_WINDOW_MAX);
        }
        if (calibSamples.length >= CALIBRATION_SAMPLES && calibrateThresholds(calibSamples).calibrated) {
          calibFrames = i + 1;
          break;
        }
      }
    }
  }

  // Fallback to whole series calibration if early calibration was insufficient
  let thresholds = calibrateThresholds(calibSamples);
  if (!thresholds.calibrated) {
    const allFiltered = [];
    counter.resetFilters();
    for (const sig of signals) {
      if (sig.valid && Number.isFinite(sig.phaseEvidence)) {
        const f = counter.observe(sig.phaseEvidence);
        if (Number.isFinite(f)) allFiltered.push(f);
      }
    }
    thresholds = calibrateThresholds(allFiltered);
  }

  // 3. Count reps with adaptive recalibration
  counter.setThresholds(thresholds.calibrated ? thresholds : FALLBACK_THRESHOLDS);
  counter.resetFilters();

  const rolling = [];
  let counted = 0;

  for (let i = 0; i < signals.length; i++) {
    const sig = signals[i];
    if (sig.valid && Number.isFinite(sig.phaseEvidence)) {
      const filtered = counter.observe(sig.phaseEvidence);
      if (Number.isFinite(filtered)) {
        rolling.push(filtered);
        if (rolling.length > CALIBRATION_WINDOW_MAX) {
          rolling.splice(0, rolling.length - CALIBRATION_WINDOW_MAX);
        }
        if (rolling.length >= CALIBRATION_SAMPLES && i % ADAPTIVE_REFRESH_EVERY === 0) {
          const st = counter.getState();
          if (st === 'READY' || st === 'UP') {
            const t = calibrateThresholds(rolling);
            if (t.calibrated) counter.setThresholds(t);
          }
        }
      }
    }
    const ev = counter.feed(sig);
    if (ev) counted++;
  }

  const expected = c.expected_n_reps;
  const falsePositives = Math.max(0, counted - expected);
  const missedReps = Math.max(0, expected - counted);
  const absError = Math.abs(counted - expected);

  return {
    name: c.name,
    view: c.view,
    quality: c.quality,
    subject: c.subject,
    nFrames,
    expectedReps: expected,
    countedReps: counted,
    falsePositives,
    missedReps,
    absError,
  };
}

console.log(`Replaying ${fixture.cases.length} clips through TypeScript RepCounter...`);

const caseResults = fixture.cases.map(replayClip);

function computeStats(items) {
  const groundTruth = items.reduce((s, c) => s + c.expectedReps, 0);
  const counted = items.reduce((s, c) => s + c.countedReps, 0);
  const falsePositives = items.reduce((s, c) => s + c.falsePositives, 0);
  const missedReps = items.reduce((s, c) => s + c.missedReps, 0);
  const absError = items.reduce((s, c) => s + c.absError, 0);
  const matchedReps = items.reduce((s, c) => s + Math.min(c.countedReps, c.expectedReps), 0);

  const mae = items.length > 0 ? absError / items.length : 0;
  const precision = counted > 0 ? matchedReps / counted : 1.0;
  const recall = groundTruth > 0 ? matchedReps / groundTruth : 1.0;
  const captureRate = groundTruth > 0 ? 1 - (missedReps / groundTruth) : 1.0;

  return {
    clipsCount: items.length,
    groundTruthReps: groundTruth,
    countedReps: counted,
    falsePositives,
    missedReps,
    absError,
    mae: Number(mae.toFixed(3)),
    precision: Number(precision.toFixed(4)),
    recall: Number(recall.toFixed(4)),
    captureRate: Number(captureRate.toFixed(4)),
  };
}

const overall = computeStats(caseResults);

// Breakdowns
const byView = {};
for (const v of ['front', 'side', 'diagonal']) {
  byView[v] = computeStats(caseResults.filter((c) => c.view === v));
}

const byQuality = {};
for (const q of ['good', 'bad']) {
  byQuality[q] = computeStats(caseResults.filter((c) => c.quality === q));
}

const bySubject = {};
const subjects = [...new Set(caseResults.map((c) => c.subject))].sort();
for (const sub of subjects) {
  bySubject[sub] = computeStats(caseResults.filter((c) => c.subject === sub));
}

// Failing clips analysis
const zeroCountClips = caseResults.filter((c) => c.expectedReps > 0 && c.countedReps === 0);
const highErrorClips = caseResults.filter((c) => c.absError >= 3);

const report = {
  timestamp: new Date().toISOString(),
  target: '>= 0.95 rep capture with controlled false positives',
  achievedOverall: overall,
  breakdownByView: byView,
  breakdownByQuality: byQuality,
  breakdownBySubject: bySubject,
  zeroCountClips: zeroCountClips.map((c) => ({ name: c.name, expected: c.expectedReps, counted: c.countedReps })),
  highErrorClips: highErrorClips.map((c) => ({ name: c.name, expected: c.expectedReps, counted: c.countedReps, err: c.absError })),
  cases: caseResults,
};

mkdirSync(path.dirname(outReportPath), { recursive: true });
writeFileSync(outReportPath, JSON.stringify(report, null, 2), 'utf8');

console.log('\n=== V2 REP REPLAY RESULTS ===');
console.log(`Clips evaluated: ${overall.clipsCount}`);
console.log(`Ground truth reps: ${overall.groundTruthReps}`);
console.log(`Counted reps:      ${overall.countedReps}`);
console.log(`False positives:   ${overall.falsePositives}`);
console.log(`Missed reps:       ${overall.missedReps}`);
console.log(`MAE:               ${overall.mae}`);
console.log(`Recall:            ${(overall.recall * 100).toFixed(1)}%`);
console.log(`Precision:         ${(overall.precision * 100).toFixed(1)}%`);
console.log(`Capture Rate:      ${(overall.captureRate * 100).toFixed(1)}%`);
console.log('\n--- BY VIEW ---');
for (const [v, st] of Object.entries(byView)) {
  console.log(`  ${v.padEnd(9)}: GT=${st.groundTruthReps.toString().padStart(3)}, Counted=${st.countedReps.toString().padStart(3)}, Recall=${(st.recall * 100).toFixed(1)}%, Precision=${(st.precision * 100).toFixed(1)}%, MAE=${st.mae}`);
}
console.log('\n--- BY QUALITY ---');
for (const [q, st] of Object.entries(byQuality)) {
  console.log(`  ${q.padEnd(9)}: GT=${st.groundTruthReps.toString().padStart(3)}, Counted=${st.countedReps.toString().padStart(3)}, Recall=${(st.recall * 100).toFixed(1)}%, Precision=${(st.precision * 100).toFixed(1)}%, MAE=${st.mae}`);
}
console.log(`\nWrote ${path.relative(repoRoot, outReportPath)}`);
