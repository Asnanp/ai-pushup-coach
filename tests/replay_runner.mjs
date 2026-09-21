#!/usr/bin/env node
/**
 * tests/replay_runner.mjs
 *
 * Replays REAL video data through the REAL TypeScript pipeline.
 *
 * Every other cross-language test in this repo runs on synthetic input:
 * `tests/fixtures/pose_frames.json` is 24 hand-made frames, and
 * `ml/models/parity_fixture.json` is 200 feature vectors. Neither exercises the
 * rep segmenter or the feature aggregator against the noisy, gappy landmark
 * streams that real footage produces.
 *
 * This runner consumes `tests/fixtures/real_video_replay.json` (built by
 * `tests/make_replay_fixture.py` from the cached MediaPipe extractions of the
 * actual dataset clips) and measures three things, deliberately separated so a
 * mismatch is diagnosable:
 *
 *   1. `smoothing`   — the same raw elbow series through Python's centered
 *                      boxcar (`smooth_signal`) vs the TypeScript causal ring
 *                      buffer (`CausalSmoother`).
 *   2. `calibration` — thresholds derived from each smoothed series.
 *   3. `aggregation` — given Python's rep windows, does `aggregateRepWindow`
 *                      produce the same 37-dim vector?
 *
 * `repCount` is reported too, but it is downstream of (1) and (2), so a
 * mismatch there is a symptom rather than a diagnosis.
 *
 * Imports the SHIPPED runtime rather than reimplementing it. A reimplementation
 * would pass this test while the shipped code stayed broken.
 *
 * Usage:  node tests/replay_runner.mjs [fixture.json]
 * Exit:   0 ok, 2 bad usage, 3 no runtime, 4 refused to load, 5 case error
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const fixturePath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(here, 'fixtures', 'real_video_replay.json');

const repCounterDist = path.join(repoRoot, 'packages', 'rep-counter', 'dist', 'index.js');
const biomechanicsDist = path.join(repoRoot, 'packages', 'biomechanics', 'dist', 'index.js');

for (const p of [repCounterDist, biomechanicsDist]) {
  if (!existsSync(p)) {
    process.stderr.write(
      `replay_runner: compiled package missing at ${p}\n` +
        'Run `npm run build:packages` first.\n',
    );
    process.exit(3);
  }
}

if (!existsSync(fixturePath)) {
  process.stderr.write(
    `replay_runner: fixture missing at ${fixturePath}\n` +
      'Run `python tests/make_replay_fixture.py` first.\n',
  );
  process.exit(3);
}

const repCounter = await import(pathToFileURL(repCounterDist).href);
const biomechanics = await import(pathToFileURL(biomechanicsDist).href);

const {
  RepCounter,
  CausalSmoother,
  MedianFilter,
  calibrateThresholds,
  maskImplausibleAngle,
  SMOOTH_WINDOW,
} = repCounter;
const { aggregateRepWindow, FEATURE_NAMES } = biomechanics;

if (typeof RepCounter !== 'function' || typeof aggregateRepWindow !== 'function') {
  process.stderr.write(
    'replay_runner: the compiled packages do not export the expected symbols; ' +
      'refusing to run rather than testing a stub.\n',
  );
  process.exit(4);
}

/** The fixture stores non-finite values as the string "NaN". */
const num = (v) => (v === 'NaN' || v === null || v === undefined ? Number.NaN : Number(v));

const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

/**
 * Build the FrameFeatures the aggregator consumes, from the 17 stored columns.
 * Column order comes from the fixture so a reordering in the extractor surfaces
 * as a loud mismatch rather than a silent transpose.
 */
function buildFrames(caseData) {
  const idx = Object.fromEntries(caseData.frame_columns.map((c, i) => [c, i]));
  const required = [
    'elbow_angle',
    'elbow_angle_opposite',
    'shoulder_angle',
    'hip_angle',
    'knee_angle',
    'ankle_angle',
    'body_line_deviation',
    'shoulder_hip_ankle_angle',
    'torso_slope',
    'hip_height_rel',
    'shoulder_height_rel',
    'shoulder_elbow_height_delta',
    'shoulder_ankle_height_delta',
    'mean_visibility',
    'min_visibility',
    'jitter',
    'valid',
  ];
  for (const name of required) {
    if (!(name in idx)) {
      throw new Error(`fixture frame_columns is missing "${name}"`);
    }
  }

  return caseData.frames.map((row, i) => ({
    valid: num(row[idx.valid]) === 1,
    // `side` is not stored per frame; the aggregator does not branch on it, and
    // asserting that here is the point of passing a constant.
    side: 'left',
    timestamp: num(caseData.frame_times[i]),
    elbowAngle: num(row[idx.elbow_angle]),
    elbowAngleOpposite: num(row[idx.elbow_angle_opposite]),
    shoulderAngle: num(row[idx.shoulder_angle]),
    hipAngle: num(row[idx.hip_angle]),
    kneeAngle: num(row[idx.knee_angle]),
    ankleAngle: num(row[idx.ankle_angle]),
    bodyLineDeviation: num(row[idx.body_line_deviation]),
    shoulderHipAnkleAngle: num(row[idx.shoulder_hip_ankle_angle]),
    torsoSlope: num(row[idx.torso_slope]),
    hipHeightRel: num(row[idx.hip_height_rel]),
    shoulderHeightRel: num(row[idx.shoulder_height_rel]),
    shoulderElbowHeightDelta: num(row[idx.shoulder_elbow_height_delta]),
    shoulderAnkleHeightDelta: num(row[idx.shoulder_ankle_height_delta]),
    meanVisibility: num(row[idx.mean_visibility]),
    minVisibility: num(row[idx.min_visibility]),
    jitter: num(row[idx.jitter]),
  }));
}

/**
 * Reproduce the live pipeline's filtering exactly: mask implausible, causal
 * push, then median de-spike — the same chain `RepCounter.observe()` runs.
 *
 * The median stage is part of the live signal and has no Python counterpart, so
 * it is reported separately from the smoothing comparison. Comparing the causal
 * smoother alone against Python's boxcar would attribute the median's effect to
 * the wrong stage.
 */
function liveFilter(frames) {
  const s = new CausalSmoother();
  const m = new MedianFilter();
  return frames.map((f) => {
    const raw = maskImplausibleAngle(f.elbowAngle);
    if (!Number.isFinite(raw)) return Number.NaN;
    return m.push(s.push(raw));
  });
}

/** The causal smoother only, with no median — the closest analogue of Python's boxcar. */
function causalSmoothOnly(frames) {
  const s = new CausalSmoother();
  return frames.map((f) => s.push(maskImplausibleAngle(f.elbowAngle)));
}

/** How many calibration samples the live app collects before it will start. */
const CALIBRATION_SAMPLES = 60;
/** Rolling-window cap, matching CALIBRATION_WINDOW_MAX in workout-session.ts. */
const CALIBRATION_WINDOW_MAX = 300;
/** How often the adaptive variant refreshes its thresholds, in frames. */
const ADAPTIVE_REFRESH_EVERY = 30;

function maxAbsDiff(a, b) {
  let worst = 0;
  let worstIdx = -1;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (Number.isNaN(d)) {
      // A NaN on exactly one side is an infinite disagreement, not a zero one.
      if (Number.isNaN(a[i]) !== Number.isNaN(b[i])) return { worst: Infinity, worstIdx: i };
      continue;
    }
    if (d > worst) {
      worst = d;
      worstIdx = i;
    }
  }
  return { worst, worstIdx };
}

const out = { fixture: path.relative(repoRoot, fixturePath), cases: [], errors: [] };

for (const c of fixture.cases) {
  try {
    const frames = buildFrames(c);

    // ---- 1. smoothing ----
    const pySmoothed = c.python_smoothed.map(num);
    const tsSmootherOnly = causalSmoothOnly(frames);
    const tsLive = liveFilter(frames);

    const warm = Math.max(SMOOTH_WINDOW ?? 9, 1);
    const smoothDiffSmootherOnly = maxAbsDiff(tsSmootherOnly.slice(warm), pySmoothed.slice(warm));
    const smoothDiffLive = maxAbsDiff(tsLive.slice(warm), pySmoothed.slice(warm));

    // ---- 2. calibration ----
    // (a) live-faithful: thresholds from the filtered signal of the first N
    //     frames, exactly as WorkoutSession does.
    const counter = new RepCounter();
    const calibrationSamples = [];
    let calibrateFrames = 0;
    for (let i = 0; i < frames.length; i++) {
      const filtered = counter.observe(frames[i].elbowAngle);
      if (Number.isFinite(filtered)) {
        calibrationSamples.push(filtered);
        // Rolling window, mirroring WorkoutSession: stale stationary samples
        // must age out or the band stays pinned to a motionless pose.
        if (calibrationSamples.length > CALIBRATION_WINDOW_MAX) {
          calibrationSamples.splice(0, calibrationSamples.length - CALIBRATION_WINDOW_MAX);
        }
        // The gate is movement, not sample count.
        if (
          calibrationSamples.length >= CALIBRATION_SAMPLES &&
          calibrateThresholds(calibrationSamples).calibrated
        ) {
          calibrateFrames = i + 1;
          break;
        }
      }
    }
    const tsThresholdsLive = calibrateThresholds(calibrationSamples);

    // (b) whole-clip: thresholds from the entire filtered series. This is what
    //     Python does, so it isolates segmentation from the calibration window.
    const tsThresholdsWholeClip = calibrateThresholds(tsLive.filter(Number.isFinite));

    const pyThresholds = c.python_thresholds;
    const deltaVs = (ts) => {
      const out = {};
      for (const [pyKey, tsKey] of [
        ['up_enter', 'upEnter'],
        ['up_exit', 'upExit'],
        ['down_enter', 'downEnter'],
        ['down_exit', 'downExit'],
      ]) {
        const pyVal = num(pyThresholds[pyKey]);
        const tsVal = ts[tsKey];
        out[pyKey] =
          Number.isFinite(pyVal) && Number.isFinite(tsVal) ? Math.abs(tsVal - pyVal) : Infinity;
      }
      return out;
    };

    // ---- 3. rep count via the shipped FSM ----
    // (a) live-faithful replay: calibrate on the first N frames, then count the
    //     remainder. This is what the product actually does.
    counter.setThresholds(tsThresholdsLive);
    counter.resetFilters();
    for (let i = calibrateFrames; i < frames.length; i++) counter.feed(frames[i]);
    const tsRepCountLive = counter.getRepCount();

    // (b) whole-clip calibration, whole series fed. Isolates the segmentation
    //     logic from the calibration-window difference.
    const counter2 = new RepCounter();
    counter2.setThresholds(tsThresholdsWholeClip);
    counter2.resetFilters();
    for (const f of frames) counter2.feed(f);
    const tsRepCountWholeClip = counter2.getRepCount();

    // (c) ADAPTIVE: keep a rolling window of recent samples and refresh the
    //     thresholds periodically while counting. Real clips are not
    //     stationary -- rep depth changes with fatigue -- so a band locked from
    //     the first few reps can become unreachable. This variant measures
    //     whether re-calibration recovers the missing reps.
    const counter3 = new RepCounter();
    counter3.setThresholds(tsThresholdsLive);
    counter3.resetFilters();
    const rolling = [];
    let tsRepCountAdaptive = 0;
    for (let i = 0; i < frames.length; i++) {
      const filtered = counter3.observe(frames[i].elbowAngle);
      if (Number.isFinite(filtered)) {
        rolling.push(filtered);
        if (rolling.length > CALIBRATION_WINDOW_MAX) {
          rolling.splice(0, rolling.length - CALIBRATION_WINDOW_MAX);
        }
        // Mirrors WorkoutSession.refreshThresholdsAdaptively(): only swap the
        // band at a stable point in the cycle, never mid-rep.
        if (
          rolling.length >= CALIBRATION_SAMPLES &&
          i % ADAPTIVE_REFRESH_EVERY === 0
        ) {
          const st = counter3.getState();
          if (st === 'READY' || st === 'UP') {
            const t = calibrateThresholds(rolling);
            if (t.calibrated) counter3.setThresholds(t);
          }
        }
      }
      counter3.feed(frames[i]);
    }
    tsRepCountAdaptive = counter3.getRepCount();

    // ---- 4. aggregation given Python's windows ----
    let aggWorst = 0;
    let aggWorstFeature = null;
    let aggWorstCase = null;
    let aggCompared = 0;
    const perFeature = new Map();
    // Durations are reported separately: they are the feature the timestamp
    // corruption poisoned, and a plausible-range check on them is the cheapest
    // way to catch a regression in the data itself (not just in the code).
    const repDurations = [];
    const durIdx = FEATURE_NAMES.indexOf('rep_duration_s');

    for (let r = 0; r < c.expected_windows.length; r++) {
      const [s, e] = c.expected_windows[r];
      const slice = frames.slice(s, e + 1);
      if (slice.length === 0) continue;

      // Python re-times the window so t=0 at rep start; mirror that exactly.
      const t0 = slice[0].timestamp;
      const reTimed = slice.map((f) => ({ ...f, timestamp: f.timestamp - t0 }));

      const agg = aggregateRepWindow(reTimed, e - s + 1);
      const expected = c.expected_rep_vectors[r].map(num);
      if (!agg) {
        out.errors.push(`${c.name} rep ${r}: aggregateRepWindow returned null`);
        continue;
      }

      aggCompared++;
      if (durIdx >= 0) {
        repDurations.push({
          index: r,
          python: expected[durIdx],
          ts: agg.vector[durIdx],
        });
      }
      for (let i = 0; i < expected.length; i++) {
        const a = agg.vector[i];
        const b = expected[i];
        const d =
          Number.isNaN(a) && Number.isNaN(b)
            ? 0
            : Number.isNaN(a) !== Number.isNaN(b)
              ? Infinity
              : Math.abs(a - b);
        const name = FEATURE_NAMES[i] ?? `feature_${i}`;
        if (!perFeature.has(name) || perFeature.get(name) < d) perFeature.set(name, d);
        if (d > aggWorst) {
          aggWorst = d;
          aggWorstFeature = name;
          aggWorstCase = { rep: r, window: [s, e] };
        }
      }
    }

    const featureRanks = [...perFeature.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, diff]) => ({ name, diff }));

    out.cases.push({
      name: c.name,
      quality: c.quality,
      view: c.view,
      nFrames: c.n_frames,
      tracked: c.tracked,
      smoothing: {
        warmupFrames: warm,
        smootherOnlyMaxAbsDiff: smoothDiffSmootherOnly.worst,
        liveChainMaxAbsDiff: smoothDiffLive.worst,
        smootherOnlyWorstFrame: smoothDiffSmootherOnly.worstIdx,
        liveChainWorstFrame: smoothDiffLive.worstIdx,
      },
      calibration: {
        tsLive: tsThresholdsLive,
        tsWholeClip: tsThresholdsWholeClip,
        python: pyThresholds,
        deltaLive: deltaVs(tsThresholdsLive),
        deltaWholeClip: deltaVs(tsThresholdsWholeClip),
        liveCalibrationFrames: calibrateFrames,
        liveCalibrationSamples: calibrationSamples.length,
      },
      repCount: {
        tsLive: tsRepCountLive,
        tsWholeClip: tsRepCountWholeClip,
        tsAdaptive: tsRepCountAdaptive,
        python: c.expected_n_reps,
      },
      aggregation: {
        repsCompared: aggCompared,
        repsExpected: c.expected_windows.length,
        maxAbsDiff: aggWorst,
        worstFeature: aggWorstFeature,
        worstCase: aggWorstCase,
        topFeatures: featureRanks,
        repDurations,
      },
    });
  } catch (err) {
    out.errors.push(`${c.name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

out.nCases = out.cases.length;

// ---- summary, computed here so callers do not re-derive it ----
// Every variant is reported separately. Collapsing them into one number would
// hide which stage actually diverges.
const all = out.cases;
const maxOf = (pick) => all.reduce((m, c) => Math.max(m, pick(c)), 0);
const sumOf = (pick) => all.reduce((n, c) => n + pick(c), 0);

out.summary = {
  nCases: all.length,
  aggregationRepsCompared: sumOf((c) => c.aggregation.repsCompared),
  durations: (() => {
    const pairs = all.flatMap((c) => c.aggregation.repDurations ?? []);
    const vals = pairs.map((d) => d.python).filter((v) => Number.isFinite(v));
    if (vals.length === 0) return { n: 0 };
    return {
      n: vals.length,
      min: Math.min(...vals),
      max: Math.max(...vals),
      implausible: vals.filter((v) => v < 0.2 || v > 8).length,
    };
  })(),
  aggregationRepsExpected: sumOf((c) => c.aggregation.repsExpected),
  aggregationMaxAbsDiff: maxOf((c) => c.aggregation.maxAbsDiff),
  smoothingSmootherOnlyMaxAbsDiff: maxOf((c) => c.smoothing.smootherOnlyMaxAbsDiff),
  smoothingLiveChainMaxAbsDiff: maxOf((c) => c.smoothing.liveChainMaxAbsDiff),
  thresholdMaxDeltaLive: maxOf((c) => Math.max(...Object.values(c.calibration.deltaLive))),
  thresholdMaxDeltaWholeClip: maxOf(
    (c) => Math.max(...Object.values(c.calibration.deltaWholeClip)),
  ),
  repCount: {
    tsLiveExact: all.filter((c) => c.repCount.tsLive === c.repCount.python).length,
    tsWholeClipExact: all.filter((c) => c.repCount.tsWholeClip === c.repCount.python).length,
    tsAdaptiveExact: all.filter((c) => c.repCount.tsAdaptive === c.repCount.python).length,
    totalTsAdaptive: sumOf((c) => c.repCount.tsAdaptive),
    totalAbsErrAdaptive: sumOf((c) => Math.abs(c.repCount.tsAdaptive - c.repCount.python)),
    totalPython: sumOf((c) => c.repCount.python),
    totalTsLive: sumOf((c) => c.repCount.tsLive),
    totalTsWholeClip: sumOf((c) => c.repCount.tsWholeClip),
    totalAbsErrLive: sumOf((c) => Math.abs(c.repCount.tsLive - c.repCount.python)),
    totalAbsErrWholeClip: sumOf((c) => Math.abs(c.repCount.tsWholeClip - c.repCount.python)),
  },
  worstAggregationFeatures: [
    ...new Map(
      all
        .flatMap((c) => c.aggregation.topFeatures.map((f) => [f.name, f.diff]))
        .sort((a, b) => b[1] - a[1]),
    ).entries(),
  ]
    .slice(0, 10)
    .map(([name, diff]) => ({ name, diff })),
};

process.stdout.write(JSON.stringify(out, null, 2));
process.exit(out.errors.length > 0 ? 5 : 0);
