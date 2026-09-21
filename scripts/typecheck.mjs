#!/usr/bin/env node
/**
 * scripts/typecheck.mjs
 *
 * Type-checks the whole monorepo: the packages and the web app.
 *
 * TypeScript is installed under apps/web/node_modules, so a bare `tsc` is not
 * on PATH; this resolves the compiler explicitly so the command works from a
 * clean checkout on any platform.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const TSC_CANDIDATES = [
  'apps/web/node_modules/typescript/bin/tsc',
  'node_modules/typescript/bin/tsc',
];

let tsc = null;
for (const rel of TSC_CANDIDATES) {
  const abs = path.join(repoRoot, rel);
  if (existsSync(abs)) {
    tsc = abs;
    break;
  }
}

if (!tsc) {
  console.error(
    'Could not find the TypeScript compiler. Install web dependencies first:\n' +
      '  npm --prefix apps/web install\n',
  );
  process.exit(1);
}

const PACKAGE_PROJECTS = [
  'packages/types',
  'packages/pose',
  'packages/biomechanics',
  'packages/rep-counter',
  'packages/form-engine',
].filter((p) => existsSync(path.join(repoRoot, p, 'tsconfig.json')));

const steps = [
  { label: 'packages', args: ['-b', ...PACKAGE_PROJECTS], cwd: repoRoot },
  { label: 'apps/web', args: ['--noEmit', '-p', 'tsconfig.json'], cwd: path.join(repoRoot, 'apps/web') },
];

let failed = false;

for (const step of steps) {
  console.log(`\n=== typecheck: ${step.label} ===`);
  const res = spawnSync(process.execPath, [tsc, ...step.args], {
    cwd: step.cwd,
    stdio: 'inherit',
  });
  if ((res.status ?? 1) !== 0) failed = true;
}

if (failed) {
  console.error('\nTypecheck FAILED.');
  process.exit(1);
}

console.log('\nTypecheck passed with no errors.');
