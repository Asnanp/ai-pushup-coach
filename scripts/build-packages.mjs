#!/usr/bin/env node
/**
 * scripts/build-packages.mjs
 *
 * Builds every package under packages/ in dependency order.
 *
 * Why this exists instead of a plain `tsc -b packages/*`:
 *   TypeScript is installed under apps/web/node_modules, not at the repo root,
 *   so a bare `tsc` is not on PATH. Relying on `npm run build --workspaces`
 *   also fails, because the workspace links here are created by hand rather
 *   than by a root `npm install`.
 *
 * Resolving the compiler explicitly keeps `npm run build` working from a clean
 * checkout on Windows, macOS and Linux without any extra setup step.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

/** tsc lives wherever TypeScript was installed; try the known locations. */
const TSC_CANDIDATES = [
  'apps/web/node_modules/typescript/bin/tsc',
  'node_modules/typescript/bin/tsc',
];

let tscPath = null;
for (const rel of TSC_CANDIDATES) {
  const abs = path.join(repoRoot, rel);
  if (existsSync(abs)) {
    tscPath = abs;
    break;
  }
}

if (!tscPath) {
  console.error(
    'Could not find the TypeScript compiler.\n' +
      'Looked in:\n' +
      TSC_CANDIDATES.map((c) => `  - ${c}`).join('\n') +
      '\n\nInstall web dependencies first (the compiler ships with them):\n' +
      '  npm --prefix apps/web install\n',
  );
  process.exit(1);
}

/*
 * Build order matters. `tsc -b` understands project references and will build
 * dependencies automatically, but passing them explicitly makes the intended
 * order obvious and keeps the failure output readable.
 */
const PACKAGES = ['types', 'pose', 'biomechanics', 'rep-counter', 'form-engine'];

const projects = PACKAGES.map((p) => `packages/${p}`).filter((p) =>
  existsSync(path.join(repoRoot, p, 'tsconfig.json')),
);

if (projects.length === 0) {
  console.error('No package tsconfig.json files found under packages/.');
  process.exit(1);
}

console.log(`Building ${projects.length} packages with ${path.relative(repoRoot, tscPath)}`);

const result = spawnSync(
  process.execPath,
  [tscPath, '-b', ...projects],
  { cwd: repoRoot, stdio: 'inherit' },
);

if (result.error) {
  console.error(`Failed to run the TypeScript compiler: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
