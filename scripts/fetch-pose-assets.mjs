#!/usr/bin/env node
/**
 * scripts/fetch-pose-assets.mjs
 *
 * Copies the MediaPipe vision WASM runtime out of node_modules and downloads
 * the pose landmarker model into apps/web/public, so the app can run with no
 * network access at all.
 *
 * Why this matters more than it looks: the app is demonstrated live at a booth,
 * and venue wifi is the least reliable part of the system. Without local
 * assets, a failed CDN fetch presents to the audience as "the app is broken"
 * when only the network is. The pose engine prefers these local copies and
 * falls back to the CDN only if they are missing.
 *
 * The WASM is ~19 MB and the model ~9 MB, which is why they are not committed
 * by default. Run this once after `npm --prefix apps/web install`.
 *
 * Usage:
 *   node scripts/fetch-pose-assets.mjs            # fetch anything missing
 *   node scripts/fetch-pose-assets.mjs --force    # re-copy and re-download
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const webRoot = path.join(repoRoot, 'apps', 'web');

const force = process.argv.includes('--force');

const WASM_SRC = path.join(webRoot, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const WASM_DEST = path.join(webRoot, 'public', 'mediapipe', 'wasm');

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task';
const MODEL_DEST = path.join(webRoot, 'public', 'models', 'pose_landmarker_full.task');

/** Rough sanity floor: the real model is ~9 MB, so anything tiny is an error page. */
const MIN_MODEL_BYTES = 1_000_000;

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

// ---------------------------------------------------------------------------
// WASM runtime
// ---------------------------------------------------------------------------

if (!existsSync(WASM_SRC)) {
  console.error(
    `MediaPipe WASM not found at ${path.relative(repoRoot, WASM_SRC)}.\n` +
      'Install web dependencies first:\n' +
      '  npm --prefix apps/web install\n',
  );
  process.exit(1);
}

mkdirSync(WASM_DEST, { recursive: true });

const wasmFiles = readdirSync(WASM_SRC);
let copied = 0;

for (const file of wasmFiles) {
  const src = path.join(WASM_SRC, file);
  const dest = path.join(WASM_DEST, file);
  if (!statSync(src).isFile()) continue;
  if (!force && existsSync(dest)) continue;
  copyFileSync(src, dest);
  copied++;
}

log(
  copied > 0
    ? `Copied ${copied} WASM file(s) to public/mediapipe/wasm`
    : `WASM already present (${wasmFiles.length} files); use --force to re-copy`,
);

// ---------------------------------------------------------------------------
// Pose landmarker model
// ---------------------------------------------------------------------------

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength < MIN_MODEL_BYTES) {
    throw new Error(
      `downloaded only ${buf.byteLength} bytes, which is too small to be the model`,
    );
  }
  await writeFile(dest, buf);
  return buf.byteLength;
}

if (!force && existsSync(MODEL_DEST)) {
  const size = statSync(MODEL_DEST).size;
  if (size >= MIN_MODEL_BYTES) {
    log(`Pose model already present (${(size / 1e6).toFixed(1)} MB); use --force to re-download`);
    process.exit(0);
  }
  log(`Pose model at ${size} bytes looks truncated; re-downloading.`);
}

mkdirSync(path.dirname(MODEL_DEST), { recursive: true });

try {
  log('Downloading pose landmarker model (~9 MB)...');
  const bytes = await download(MODEL_URL, MODEL_DEST);
  log(`Saved ${(bytes / 1e6).toFixed(1)} MB to public/models/pose_landmarker_full.task`);
} catch (err) {
  console.error(
    `\nCould not download the pose model: ${err.message}\n\n` +
      'The app still works: packages/pose falls back to the CDN when the local\n' +
      'copy is absent. Re-run this script on a machine with network access to\n' +
      'make the demo fully offline-capable.\n',
  );
  // Non-fatal: the CDN fallback covers this case.
  process.exit(0);
}

log('\nDone. The app now loads MediaPipe assets locally and needs no network.');
