#!/usr/bin/env node
/**
 * scripts/ml-pipeline.mjs
 *
 * Runs the ML pipeline end to end, in the order the stages depend on each
 * other. Each stage writes artifacts the next one consumes:
 *
 *   1. inspect_dataset       -> dataset_manifest.csv
 *   2. extract_pose_features -> ml/data/processed/*.npz
 *   3. calibrate_thresholds  -> per-view threshold report
 *   4. train_classifier      -> ml/models/pushup_form_model.joblib
 *   5. export_model          -> ml/models/pushup_form_model.json + parity fixture
 *
 * Stage 5 is a hard gate: it refuses to write the JSON artifact unless its own
 * scoring reproduces sklearn to within 1e-6, so a model that the browser would
 * mis-score never ships.
 *
 * Heavy stages (2 especially, which decodes 144 videos through MediaPipe) are
 * skipped unless --full is passed, so the default run is fast enough to use
 * while iterating.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { requirePython } from './python-env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const full = process.argv.includes('--full');

const STAGES = [
  { script: 'inspect_dataset.py', heavy: false },
  { script: 'extract_pose_features.py', heavy: true },
  { script: 'calibrate_thresholds.py', heavy: false },
  { script: 'train_classifier.py', heavy: false },
  { script: 'export_model.py', heavy: false },
];

const python = requirePython('ml');

let failed = null;

for (const stage of STAGES) {
  if (stage.heavy && !full) {
    console.log(`\n--- SKIP ${stage.script} (heavy; pass --full to run it) ---`);
    continue;
  }

  console.log(`\n--- ${stage.script} ---`);
  const res = spawnSync(
    python,
    [path.join('ml', 'scripts', stage.script)],
    { cwd: repoRoot, stdio: 'inherit' },
  );

  if ((res.status ?? 1) !== 0) {
    failed = stage.script;
    break;
  }
}

if (failed) {
  console.error(`\nML pipeline FAILED at ${failed}.`);
  process.exit(1);
}

console.log('\nML pipeline completed.');
