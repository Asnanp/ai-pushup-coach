/**
 * tests/parity_runner.mjs
 *
 * Runs the TypeScript feature extractor over a JSON fixture of pose frames,
 * aggregates the window into the 37-value feature vector, and prints it as
 * JSON on stdout.
 *
 * Invoked by tests/test_feature_parity.py. Kept as a plain .mjs script so it
 * runs under bare node with no test framework and no separate build step for
 * the harness itself.
 *
 * Usage:
 *     node tests/parity_runner.mjs tests/fixtures/pose_frames.json
 *
 * Exit codes:
 *     0  success, JSON on stdout
 *     2  bad usage
 *     3  no runnable extractor found (Python test treats this as a skip)
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const fixturePath = process.argv[2];
if (!fixturePath) {
  console.error('usage: parity_runner.mjs <pose_frames.json>');
  process.exit(2);
}

/**
 * Locate a loadable build of the biomechanics package.
 *
 * We deliberately do not bundle a TypeScript transpiler here. If the package
 * has not been compiled, we exit 3 and the Python test skips with a clear
 * message, rather than silently passing.
 */
async function loadModule(relativeCandidates) {
  for (const rel of relativeCandidates) {
    const abs = path.join(repoRoot, rel);
    try {
      return await import(pathToFileURL(abs).href);
    } catch {
      // try the next candidate
    }
  }
  return null;
}

const extract = await loadModule([
  'packages/biomechanics/dist/extract.js',
  'packages/biomechanics/dist/index.js',
  'packages/biomechanics/extract.js',
]);

const repCounter = await loadModule([
  'packages/rep-counter/dist/rep-counter.js',
  'packages/rep-counter/dist/index.js',
  'packages/rep-counter/rep-counter.js',
]);

const pose = await loadModule([
  'packages/pose/dist/side-selection.js',
  'packages/pose/dist/index.js',
  'packages/pose/side-selection.js',
]);

if (!extract || typeof extract.extractFrameFeatures !== 'function') {
  console.error(
    'No runnable feature extractor found. Build packages/biomechanics first ' +
      '(e.g. `npm run build:packages`, or `tsc -b packages/biomechanics`).',
  );
  process.exit(3);
}

if (typeof extract.aggregateRepWindow !== 'function') {
  console.error('aggregateRepWindow export missing from biomechanics package.');
  process.exit(3);
}

if (!pose || typeof pose.chooseActiveSide !== 'function') {
  console.error(
    'No runnable side-selection found. Build packages/pose first.',
  );
  process.exit(3);
}

const frames = JSON.parse(readFileSync(fixturePath, 'utf8'));

/*
 * Build real PoseFrames rather than passing raw landmarks to the extractor.
 *
 * extractFrameFeatures() takes a PoseFrame and returns an invalid frame when
 * `pose.valid` is false. Handing it a bare landmark array makes `valid`
 * undefined, every frame is discarded, aggregateRepWindow() returns null, and
 * the comparison degenerates into comparing nothing. Running the genuine
 * side-selection keeps this test honest about what the app actually does.
 */
const MIN_VISIBILITY = extract.MIN_VISIBILITY ?? 0.5;

let currentSide = null;
const window = frames.map((frame, i) => {
  const landmarks = frame.landmarks.map((p) => ({
    x: p.x,
    y: p.y,
    z: p.z,
    visibility: p.visibility,
  }));

  const vis = pose.computeSideVisibility(landmarks);
  const choice = pose.chooseActiveSide(landmarks, currentSide, vis);
  currentSide = choice.side;

  const poseFrame = {
    timestamp: typeof frame.timestamp === 'number' ? frame.timestamp : i / 15,
    landmarks,
    side: choice.side,
    valid: landmarks.length >= 33 && choice.score >= MIN_VISIBILITY,
    sideVisibility: choice.score,
  };

  return extract.extractFrameFeatures(poseFrame, {
    timestamp: poseFrame.timestamp,
    view: 'side',
  });
});

const validFrames = window.filter((f) => f && f.valid).length;
if (validFrames === 0) {
  console.error(
    `All ${window.length} frames were marked invalid by the extractor; ` +
      'the fixture cannot exercise the pipeline.',
  );
  process.exit(3);
}

const aggregated = extract.aggregateRepWindow(window);

if (aggregated === null || aggregated === undefined) {
  console.error(
    `aggregateRepWindow returned ${aggregated} with ${validFrames} valid frames.`,
  );
  process.exit(3);
}

// The aggregation may return either a bare array or { vector, raw }.
let vector;
if (Array.isArray(aggregated)) vector = aggregated;
else if (aggregated && Array.isArray(aggregated.vector)) vector = aggregated.vector;
else if (aggregated && aggregated.vector && typeof aggregated.vector.length === 'number') {
  vector = Array.from(aggregated.vector);
} else {
  console.error('Unrecognised aggregation output shape:', typeof aggregated);
  process.exit(3);
}

vector = Array.from(vector).map((v) => (typeof v === 'number' ? v : Number(v)));

// JSON cannot encode NaN. Emit as the string "NaN" so the Python side can tell
// a missing value apart from a genuine number.
process.stdout.write(
  JSON.stringify(
    {
      vector,
      featureNames: extract.FEATURE_NAMES ?? null,
      nFeatures: vector.length,
      hasRepCounter: Boolean(repCounter),
    },
    (_k, value) =>
      typeof value === 'number' && !Number.isFinite(value) ? 'NaN' : value,
  ),
);
