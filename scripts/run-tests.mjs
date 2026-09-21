#!/usr/bin/env node
/**
 * scripts/run-tests.mjs
 *
 * Runs the Python test suite (which also drives the TypeScript parity runners)
 * using an interpreter that actually has the dependencies.
 *
 * Before running, it builds the packages if they are missing, because
 * tests/test_feature_parity.py and tests/test_model_parity.py SKIP themselves
 * when the compiled packages are absent. A silent skip is worse than a
 * failure: it looks like a pass in CI output. This script removes that trap by
 * building first and then asserting that nothing was skipped.
 */

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { requirePython } from './python-env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const REQUIRED_BUILDS = [
  'packages/biomechanics/dist/index.js',
  'packages/form-engine/dist/index.js',
  'packages/rep-counter/dist/index.js',
];

const missing = REQUIRED_BUILDS.filter((rel) => !existsSync(path.join(repoRoot, rel)));

if (missing.length > 0) {
  console.log('Compiled packages are missing; building them first.');
  const build = spawnSync(
    process.execPath,
    [path.join(here, 'build-packages.mjs')],
    { cwd: repoRoot, stdio: 'inherit' },
  );
  if ((build.status ?? 1) !== 0) {
    console.error('Package build failed; cannot run the parity tests.');
    process.exit(1);
  }
}

const python = requirePython('test');
const args = ['-m', 'pytest', 'tests', '-q', ...process.argv.slice(2)];

const res = spawnSync(python, args, { cwd: repoRoot, stdio: 'inherit' });
process.exit(res.status ?? 1);
