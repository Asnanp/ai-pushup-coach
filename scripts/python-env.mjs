#!/usr/bin/env node
/**
 * scripts/python-env.mjs
 *
 * Locates a Python interpreter that has the ML dependencies installed.
 *
 * The project deliberately does NOT create its own virtualenv: the machine
 * already has a working environment with numpy / scipy / scikit-learn /
 * mediapipe / pytest, and duplicating it wastes gigabytes and time.
 *
 * So instead of guessing, we probe a short list of candidates and use the
 * first one that can actually import the core scientific stack. Probing beats
 * a hard-coded path because the same repo has to run on the developer's
 * Windows box and on a judge's machine.
 */

import { spawnSync } from 'node:child_process';

const CANDIDATES = [
  // Known-good environment on this checkout.
  'C:\\Users\\USER\\anaconda3\\envs\\pushup\\Scripts\\python.exe',
  // Generic conda / system fallbacks.
  'python',
  'python3',
  'py',
];

/** Modules that must be importable for the ML pipeline and tests to run. */
const REQUIRED = ['numpy', 'sklearn', 'pytest'];

function probe(executable) {
  const code = REQUIRED.map((m) => `import ${m}`).join('; ');
  const res = spawnSync(executable, ['-c', code], {
    stdio: 'ignore',
    timeout: 60_000,
  });
  return res.status === 0;
}

/** Return the first candidate interpreter that satisfies REQUIRED. */
export function findPython() {
  const tried = [];
  for (const candidate of CANDIDATES) {
    try {
      if (probe(candidate)) return candidate;
      tried.push(candidate);
    } catch {
      tried.push(candidate);
    }
  }
  return null;
}

/**
 * Resolve an interpreter or exit with an actionable message.
 * `label` names the caller so the error says what was being attempted.
 */
export function requirePython(label) {
  const python = findPython();
  if (!python) {
    console.error(
      `Could not find a Python interpreter with ${REQUIRED.join(', ')} installed.\n` +
        'This project expects an existing environment (it does not create one).\n' +
        'Activate your environment, or install the dependencies:\n' +
        `  pip install ${REQUIRED.join(' ')}\n`,
    );
    process.exit(1);
  }
  if (label) console.log(`[${label}] using ${python}`);
  return python;
}

/** Run a python module in the repo root, inheriting stdio. */
export function runPythonModule(moduleArgs, { python, cwd }) {
  const res = spawnSync(python, moduleArgs, { cwd, stdio: 'inherit' });
  if (res.error) {
    console.error(`Failed to launch ${python}: ${res.error.message}`);
    process.exit(1);
  }
  return res.status ?? 1;
}
