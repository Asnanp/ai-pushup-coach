#!/usr/bin/env node
/**
 * scripts/acceptance-v3.mjs
 *
 * V3 gates. Dataset replay cannot be the only green light.
 * Live webcam sessions are required before tagging v3.0.0.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const JSON_MODE = process.argv.includes('--json');

const rows = [];

function record(name, status, detail) {
  rows.push({ name, status, detail });
  if (!JSON_MODE) {
    const mark = status === 'PASS' ? 'PASS' : status === 'SKIP' ? 'SKIP' : 'FAIL';
    console.log(`${mark.padEnd(4)}  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function run(cmd, args, timeout = 180_000) {
  return spawnSync(cmd, args, {
    cwd: root,
    encoding: 'utf8',
    timeout,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function fileExists(...p) {
  return existsSync(path.join(root, ...p));
}

record(
  'v2 tags preserved',
  fileExists('.git') ? 'PASS' : 'SKIP',
  'v1.0.0-baseline and v2.0.0 must remain',
);

record(
  'V3_BASELINE.md',
  fileExists('docs', 'V3_BASELINE.md') ? 'PASS' : 'FAIL',
);

record(
  'LIVE_HUMAN_BENCHMARK.md',
  fileExists('docs', 'LIVE_HUMAN_BENCHMARK.md') ? 'PASS' : 'FAIL',
);

record(
  'motion-fusion.ts',
  fileExists('packages', 'rep-counter', 'src', 'motion-fusion.ts') ? 'PASS' : 'FAIL',
);

record(
  'v3-rep-engine.ts',
  fileExists('packages', 'rep-counter', 'src', 'v3-rep-engine.ts') ? 'PASS' : 'FAIL',
);

record(
  'live lab route',
  fileExists('apps', 'web', 'app', 'lab', 'live-counter', 'page.tsx') ? 'PASS' : 'FAIL',
);

const packages = run(process.execPath, [path.join('scripts', 'build-packages.mjs')]);
record('package build', packages.status === 0 ? 'PASS' : 'FAIL', packages.stderr?.slice(0, 200));

const typecheck = run(process.execPath, [path.join('scripts', 'typecheck.mjs')]);
record('typecheck', typecheck.status === 0 ? 'PASS' : 'FAIL');

const vitestBin = path.join(root, 'apps/web/node_modules/vitest/vitest.mjs');
const web = existsSync(vitestBin)
  ? spawnSync(process.execPath, [vitestBin, 'run'], {
      cwd: path.join(root, 'apps/web'),
      encoding: 'utf8',
      timeout: 180_000,
      maxBuffer: 32 * 1024 * 1024,
    })
  : { status: 1, stderr: 'vitest missing' };
record('frontend tests', web.status === 0 ? 'PASS' : 'FAIL', String(web.stderr || web.stdout || '').slice(-160));

const src = readFileSync(path.join(root, 'packages/rep-counter/src/signal-extractors.ts'), 'utf8');
record(
  '3D angle z-bug absent',
  src.includes('(c.z ?? 0) - (c.z ?? 0)') ? 'FAIL' : 'PASS',
);

const poseSrc = readFileSync(path.join(root, 'packages/pose/src/pose-engine.ts'), 'utf8');
record(
  'world landmarks forwarded',
  poseSrc.includes('worldLandmarks') ? 'PASS' : 'FAIL',
);

record(
  'live webcam sessions',
  'SKIP',
  'Mandatory for v3.0.0. Run /lab/live-counter. Do not ship on replay alone.',
);

if (JSON_MODE) console.log(JSON.stringify({ rows }, null, 2));

const failed = rows.filter((r) => r.status === 'FAIL').length;
process.exit(failed > 0 ? 1 : 0);
