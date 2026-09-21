/**
 * tests/model_parity_runner.mjs
 *
 * Scores the recorded parity fixture with the REAL TypeScript model runtime and
 * prints the resulting P(good) values as JSON on stdout.
 *
 * Invoked by tests/test_model_parity.py. The point is to prove that the browser
 * and the exported sklearn artifact agree, rather than to re-derive the maths
 * here: this script deliberately imports `packages/form-engine/model-runtime`
 * instead of walking the trees itself. A reimplementation would pass the test
 * while the shipped runtime stayed broken.
 *
 * Why this matters concretely: sklearn's binary GradientBoostingClassifier fits
 * its stage trees to `classes_[1]`, so the sigmoid yields P(class 1). An early
 * version of the runtime returned that value directly while the caller expected
 * P(good) — the exact complement. It would have told every user their good reps
 * were bad, and looked plausible while doing it.
 *
 * Usage:
 *     node tests/model_parity_runner.mjs <model.json> <metadata.json> <fixture.json>
 *
 * Exit codes:
 *     0  success, JSON on stdout
 *     2  bad usage
 *     3  no runnable runtime found (Python test treats this as a skip)
 *     4  runtime refused to load the model (contract mismatch)
 *     5  a case could not be scored
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const [modelPath, metaPath, fixturePath] = process.argv.slice(2);
if (!modelPath || !metaPath || !fixturePath) {
  console.error(
    'usage: model_parity_runner.mjs <model.json> <metadata.json> <fixture.json>',
  );
  process.exit(2);
}

/**
 * Locate a loadable build of the form-engine package.
 *
 * No TypeScript transpiler is bundled on purpose. If the package has not been
 * compiled we exit 3 so the Python test SKIPS with a visible reason instead of
 * quietly passing on an untested runtime.
 */
async function loadModule(relativeCandidates) {
  const problems = [];
  for (const rel of relativeCandidates) {
    const abs = path.join(repoRoot, rel);
    try {
      return await import(pathToFileURL(abs).href);
    } catch (err) {
      problems.push(`${rel}: ${err.code ?? err.name ?? 'error'}`);
    }
  }
  return { __failure: problems };
}

const loaded = await loadModule([
  'packages/form-engine/dist/model-runtime.js',
  'packages/form-engine/model-runtime.js',
  'packages/form-engine/dist/index.js',
  'packages/form-engine/index.js',
]);

if (!loaded || loaded.__failure) {
  console.error(
    'No runnable model runtime found. Build packages/form-engine first ' +
      '(e.g. `npm run build`, or `tsc -p packages/form-engine`). ' +
      `Tried: ${(loaded?.__failure ?? []).join('; ')}`,
  );
  process.exit(3);
}

if (typeof loaded.FormModel !== 'function') {
  console.error('FormModel export missing from the form-engine package.');
  process.exit(3);
}

// ---------------------------------------------------------------------------
// Load artifacts
// ---------------------------------------------------------------------------

const readJson = (p, label) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (err) {
    console.error(`Could not read ${label} at ${p}: ${err.message}`);
    process.exit(3);
  }
};

const modelJson = readJson(modelPath, 'model JSON');
const metaJson = readJson(metaPath, 'metadata JSON');
const fixtureRaw = readJson(fixturePath, 'parity fixture');

// The fixture is written as { cases: [...] }; accept a bare array too so the
// runner keeps working if the exporter's wrapper changes.
const cases = Array.isArray(fixtureRaw)
  ? fixtureRaw
  : (fixtureRaw.cases ?? fixtureRaw.fixtures ?? []);

if (!Array.isArray(cases) || cases.length === 0) {
  console.error('Parity fixture contains no cases.');
  process.exit(3);
}

// ---------------------------------------------------------------------------
// Score every case with the shipped runtime
// ---------------------------------------------------------------------------

const model = new loaded.FormModel();
if (!model.load(metaJson, modelJson)) {
  console.error(
    'The TypeScript runtime refused to load the exported model. ' +
      'This usually means a contract mismatch (feature_spec_version, ' +
      'feature_names length, or a GBM export missing sigmoidIsClass).',
  );
  process.exit(4);
}

const probabilities = [];
const labels = [];
const missingCounts = [];
let worstMissing = 0;

for (let i = 0; i < cases.length; i++) {
  const c = cases[i];
  const feats = c.features;
  if (!Array.isArray(feats)) {
    console.error(`Case ${i} has no features array.`);
    process.exit(5);
  }

  // The fixture stores NaN as the string "NaN" because JSON cannot encode it.
  // Convert back so the runtime's imputation path is exercised identically to
  // production, where a missing measurement arrives as a real NaN.
  const vector = Float64Array.from(
    feats,
    (v) => (v === 'NaN' || v === null ? NaN : Number(v)),
  );

  const result = model.predict(vector);
  if (!result) {
    console.error(`Case ${i}: runtime returned null (vector length ${vector.length}).`);
    process.exit(5);
  }

  probabilities.push(result.goodProbability);
  labels.push(result.label);
  missingCounts.push(result.missingFeatureCount);
  if (result.missingFeatureCount > worstMissing) {
    worstMissing = result.missingFeatureCount;
  }
}

process.stdout.write(
  JSON.stringify({
    probabilities,
    labels,
    missingCounts,
    worstMissing,
    nCases: cases.length,
    threshold: model.getThreshold(),
    kind: modelJson.kind,
    classSemantics: {
      sigmoidIsClass: modelJson.sigmoidIsClass ?? null,
      classes: modelJson.classes ?? null,
      positiveClass: metaJson.positive_class,
      positiveClassMeaning: metaJson.positive_class_meaning ?? null,
    },
  }),
);
