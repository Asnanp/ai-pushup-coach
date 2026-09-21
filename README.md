# AI Push-Up Coach

A browser-based push-up coach that counts reps with deterministic geometry and grades the form of each rep with a trained machine-learning classifier. Everything runs on the user's machine.

## What this actually does

Point a webcam at yourself, do push-ups, and the app:

1. Finds your body pose in each video frame (MediaPipe Pose, 33 landmarks, in-browser).
2. Normalises the landmarks against your own torso, so distance from the camera and body size stop mattering.
3. Counts reps with a finite-state machine driven by elbow angle — `UP -> DOWN -> UP` with hysteresis.
4. Collects the frames belonging to each completed rep into one feature window.
5. Scores that window with a gradient-boosted classifier exported to plain JSON, producing `P(good form)`.
6. Turns the probability plus the measured geometry into a label, an issue code, a set of component scores (depth / alignment / tempo / consistency / range of motion) and a session score.
7. Saves the session to `localStorage`, and mirrors it to Supabase only if Supabase is configured.

## What it is / what it is not

**It is** two separate, independently testable systems bolted together:

- a **deterministic geometric rep counter** — state machine + thresholds, fully explainable, no model involved;
- a **trained classifier** — a real `GradientBoostingClassifier` fitted on 917 labelled reps from 24 subjects, exported to dependency-free JSON and executed in the browser.

**It is not** an LLM wrapper. There is no language model anywhere in the inference path. No prompt, no API call, no cloud inference, no "AI" as a synonym for "HTTP request to a vendor". The word "AI" in the name refers to the trained classifier in step 5 above.

The rep counter and the classifier are deliberately kept apart. If the classifier were wrong, the rep count would still be right, and vice versa.

## Screenshots

There are **no screenshots committed to this repository** — `apps/web/public/` contains only the exported model files. No image links are included here because none exist to link to.

<!-- SCREENSHOT PLACEHOLDER: add images to apps/web/public/ and replace this block.
![Workout screen](apps/web/public/screenshots/workout.png) -->

## Architecture

```
  webcam (browser, getUserMedia)
        |
        v
  MediaPipe Pose Landmarker (WASM/WebGL, client-side)  ->  33 landmarks + visibility
        |
        v
  landmark smoothing (EMA / One-Euro)
        |
        +-------------------------------+-------------------------------+
        |                                                               |
        v                                                               v
  per-frame biomechanics                     torso-normalised geometry (per frame)
  (17 scalars: joint angles,                 -> rep FSM: UP -> DOWN -> UP
   body-line deviation, torso                 (hysteresis + plausibility masking)
   slope, jitter, visibility)                        |
        |                                            | rep boundary event
        |                                            v
        |                                  per-rep feature window (frames of that rep)
        |                                            |
        |                                            v
        |                                  aggregate -> 34-value feature vector
        |                                            |
        |                                            v
        |                                  GBM classifier (in-browser, JSON weights)
        |                                            -> P(good form)
        |                                            |
        +--------------------+-----------------------+
                             v
                  form assessment engine
                  (ML probability + measured geometry)
                  -> good/bad label, issue codes, component scores
                             |
                             v
                  workout session state (reducer)
                             |
                 +-----------+-----------+
                 v                       v
          React UI                 localStorage  (+ optional Supabase mirror)
```

The full diagram, with the module boundaries and the reasoning behind each stage, is in `docs/ARCHITECTURE.md`.

## Repository layout

```
ai-pushup-coach/
├── apps/
│   ├── web/                 Next.js 15 app (React 19). The whole product UI and the
│   │                        in-browser inference path. Routes: /, /workout, /progress,
│   │                        /challenge, /leaderboard, /tips, /about.
│   └── api/                 Placeholder for an optional server-side inference path.
│                            Currently empty; the app does not depend on it.
├── packages/
│   ├── types/               Shared TypeScript types for the whole pipeline.
│   ├── pose/                MediaPipe landmark handling and smoothing.
│   ├── biomechanics/        The 37-feature extractor. The TS mirror of ml/src/features.py.
│   ├── rep-counter/         The rep state machine.
│   └── form-engine/         Form assessment, score composition, and the JSON model runtime.
│                            Builds to packages/*/dist as CommonJS.
├── ml/
│   ├── src/                 features.py (Python feature extractor), rep_segmenter.py
│   ├── scripts/             The pipeline: inspect, extract, calibrate, train, export,
│   │                        plus the analysis/diagnostic scripts.
│   ├── models/              Exported model JSON, metadata JSON, joblib, parity fixture.
│   ├── reports/             metrics.json, feature_search.json — measured results.
│   └── data/                Dataset manifest, splits, cached per-video features.
├── supabase/
│   └── migrations/          SQL migrations for the optional session mirror
│                            (users, workout_sessions, workout_reps, leaderboard).
├── docs/                    Design and contract documents. See the docs index below.
└── tests/                   Python test suite plus the two Node parity runners.
```

## Quick start

Everything below is run from the repository root:

```
C:\Users\USER\Downloads\Dataset Exercise Quality-wise\Dataset Exercise Quality-wise\ai-pushup-coach
```

### 1. Install dependencies

```bash
npm install
```

This is an npm-workspaces monorepo (`packages/*` and `apps/web`), so one install covers both. `apps/web/node_modules` may already exist in your checkout — that is expected and fine, leave it in place.

### 2. Fetch the pose assets (once)

```bash
npm run fetch:pose-assets
```

This copies the MediaPipe WASM runtime out of `node_modules` and downloads the
pose landmarker into `apps/web/public/` — about 28 MB, and the reason the app
can be demonstrated with the network unplugged. It is idempotent, so re-running
it is free.

Skip this and the app still works: `POSE_ASSET_SOURCES` falls through to the
CDN. It just needs the network again.

### 3. Run the app

```bash
npm run dev
```

Then open **http://localhost:3000**.

`npm run dev` delegates to `apps/web` (`next dev`). You do **not** need to build the packages first: `apps/web/tsconfig.json` maps `@ai-pushup-coach/*` to `../../packages/*/src/index.ts`, so Next.js compiles the package sources directly. The browser needs camera permission — the app requests `camera=(self)` only, and denies microphone.

### 4. Run the tests

```bash
"C:\Users\USER\anaconda3\envs\pushup\Scripts\python.exe" -m pytest tests -q
```

Expected: `34 passed, 0 skipped`.

Use an **existing** interpreter that already has `numpy`, `scipy`, `scikit-learn`, `mediapipe` and `pytest` installed — the path above is the one verified on this checkout. Do not create a new Python environment for this project.

The root `npm run test:py` script runs `python -m pytest tests -q`, which uses whichever `python` is first on your `PATH`. If that interpreter lacks the ML dependencies, call the explicit path above instead.

### 5. Type-check

```bash
npm run typecheck
```

Runs `tsc --noEmit` over `apps/web` and currently passes.

### 6. Build

```bash
npm --prefix apps/web run build
```

This produces the production Next.js build and currently succeeds — 14/14 static
pages generated. Start it with `npm --prefix apps/web run start`.

Or from the repo root, which also builds the packages first:

```bash
npm run build      # build:packages, then next build
```

**Build notes, verified on this checkout:**

- **TypeScript is not on `PATH`.** It is installed under `apps/web/node_modules`,
  and the root `node_modules/.bin` has no `tsc`. A bare `tsc` therefore fails, and
  so does `npm run build --workspaces`. `scripts/build-packages.mjs` exists to
  solve exactly this: it locates the compiler explicitly and drives it, so
  `npm run build:packages` works from the root with no PATH setup.
- **The packages compile to CommonJS, deliberately.** The parity runners in
  `tests/*.mjs` are Node ESM and import `packages/*/dist/index.js` directly. With
  `moduleResolution: bundler` TypeScript emits extensionless specifiers
  (`from './geometry'`) that Node's ESM loader refuses to resolve. CommonJS output
  is what makes the cross-language parity gate runnable, so do not switch
  `tsconfig.packages.json` back.
- The web app does **not** consume `dist`: `apps/web/tsconfig.json` maps
  `@ai-pushup-coach/*` at package **sources** via `paths`. So `next dev` works
  before any package build, but the parity tests will silently self-skip without
  one. `npm run test:py` builds first for that reason.
- To rebuild a single package by hand:

  ```bash
  node apps/web/node_modules/typescript/bin/tsc -b packages/biomechanics
  ```

  `-b` (build mode) honours the project references. Substitute any package name
  under `packages/`. This is verified working.

## ML pipeline

Scripts live in `ml/scripts/` and run in this order:

| # | Script | What it does |
|---|---|---|
| 1 | `inspect_dataset.py` | Validates every video in the dataset, extracts subject IDs, and writes the authoritative subject-independent train/val/test split to `ml/data/splits/dataset_split.json` plus a manifest CSV. |
| 2 | `extract_pose_features.py` | Decodes each video, samples frames through MediaPipe Pose, computes per-frame features, segments reps, and caches per-rep feature vectors to `ml/data/processed/*.npz`. Supports `--limit` and `--workers`. |
| 3 | `calibrate_thresholds.py` | Diagnostic. Sweeps the rep-state-machine parameters against real clips and reports per-clip rep counts, so the thresholds in `ml/src/rep_segmenter.py` come from measurements instead of guesses. Supports `--view` and `--sweep`. |
| 4 | `train_classifier.py` | Builds the training set from the cached per-rep vectors and fits the classifier. Splits by **subject**, never by rep or frame; the decision threshold is tuned on validation only; test data is not touched. Supports `--compare-sequence`. |
| 5 | `export_model.py` | Exports the fitted estimator into two artifacts from one object: `ml/models/pushup_form_model.json` (pure-JSON weights the browser can score with, no ML library required) and `ml/models/pushup_form_model.metadata.json`. Also writes `ml/models/parity_fixture.json` and **refuses to ship** if its own scoring does not reproduce sklearn to within `1e-6`. |

Analysis and diagnostic scripts, not part of the main path:

| Script | What it does |
|---|---|
| `audit_rep_counts.py` | Audits rep segmentation across the whole dataset, reporting per-clip rep counts alongside tracking quality so silent zero-rep clips are visible. Supports `--replay`. |
| `diagnose_generalisation.py` | Tests the competing explanations for the validation-to-test generalisation gap directly — label noise, subject confound, view confound, and per-feature effect size — instead of guessing. |
| `tune_features.py` | Searches for the best feature subset and decision policy, using the same discipline as the real trainer: choose on validation, report on test, never touch test during the search. |

The model is exported to **dependency-free JSON** — the browser ships no ML library and runs no Python. That export is verified against sklearn by a parity test (`tests/test_model_parity.py`), which is what makes the JSON safe to trust.

## Model card summary

Values below are read from `ml/models/pushup_form_model.metadata.json` and `ml/reports/metrics.json`.

| Field | Value |
|---|---|
| Estimator | `GradientBoostingClassifier` (scikit-learn) |
| Task | Binary classification of one **completed rep**, not one frame |
| Features consumed | 34 of the 37-feature contract |
| Decision threshold | 0.58 |
| Positive class | `0` = `P(good form)` |
| Trained at | 2026-09-20T18:32:00Z |
| Exported at | 2026-09-20T18:33:51Z |

**Features.** The 34 consumed features cover joint angles (elbow, shoulder, hip, knee), body-line deviation, torso slope, range of motion, depth ratio, angular and vertical velocities, rep/descent/ascent durations, pause at bottom, and jitter. The three capture-quality features in the contract — `mean_visibility`, `min_visibility`, `tracking_gap_ratio` — are **excluded** from the model; the metadata records seven capture-quality diagnostics in total, which are kept at runtime for UI purposes but never fed to the classifier. The recorded reason: including them let the classifier read capture conditions as a proxy for subject identity, and excluding them raised test macro-F1 from 0.587 to 0.670.

**Training data.** 917 reps from 24 subjects, split by subject using a sha256-hash-banded strategy: 569 train / 143 validation / 205 test reps (16 / 4 / 4 subjects). No subject appears in more than one split.

**Model selection.** Four candidates were compared on the person-independent validation split. Gradient boosting was selected on validation macro-F1:

| Candidate | Val accuracy | Val macro-F1 | Threshold | Val ROC-AUC |
|---|---|---|---|---|
| Logistic regression | 0.776 | 0.764 | 0.56 | 0.810 |
| Random forest | 0.790 | 0.780 | 0.52 | 0.860 |
| **Gradient boosting (selected)** | **0.832** | **0.819** | **0.58** | **0.862** |
| XGBoost | 0.804 | 0.793 | 0.57 | 0.855 |

**Held-out test metrics** (205 reps, subjects never seen in training):

| Metric | Value |
|---|---|
| Accuracy | 0.688 |
| Macro F1 | 0.672 |
| ROC-AUC | 0.702 |
| Precision (good) | 0.732 |
| Recall (good) | 0.756 |
| F1 (good) | 0.744 |
| Precision (bad) | 0.615 |
| Recall (bad) | 0.585 |
| F1 (bad) | 0.600 |
| Confusion matrix | `[[93, 30], [34, 48]]` |

Accuracy by camera view on test: front 0.631 (n=84), side 0.659 (n=44), diagonal 0.766 (n=77). Accuracy by test subject ranged from 0.444 to 0.861 — the spread is real and is why the limitations below are stated plainly.

## Testing

The suite lives in `tests/` and is run with pytest.

| File | What it covers |
|---|---|
| `test_rep_counter.py` | Unit tests for the rep-counting engine. Each test encodes a specific bug found while building the dataset pipeline — plausibility masking, rep-duration bounds, and threshold calibration — so the same silent failures cannot come back. |
| `test_feature_parity.py` | Cross-language parity for the feature extractor: the TypeScript extractor in `packages/biomechanics` is verified against the Python reference in `ml/src/features.py` over a fixture of pose frames, comparing the 37-value vector that actually crosses the language boundary. |
| `test_model_parity.py` | Cross-language parity for the model runtime: the browser scoring path in `packages/form-engine/model-runtime.ts` is verified against the exported sklearn model over 200 recorded fixture cases. |
| `parity_runner.mjs` | Node runner that executes the TypeScript feature extractor over a pose-frame fixture and prints the aggregated feature vector as JSON. Invoked by `test_feature_parity.py`. |
| `model_parity_runner.mjs` | Node runner that scores the parity fixture with the **real** TypeScript model runtime and prints `P(good)` values as JSON. Invoked by `test_model_parity.py`. It deliberately imports the shipped runtime rather than reimplementing the tree walk, because a reimplementation would pass the test while the shipped code stayed broken. |

**Current result: 34 passed, 0 failed, 0 skipped.**

Both parity tests assert agreement to within `1e-6`. The measured worst-case deviation between the TypeScript runtime and sklearn across the 200 fixture cases is **1.11e-16**, i.e. floating-point noise. This matters because an early version of the runtime returned `P(bad)` where the caller expected `P(good)` — the exact complement, which would have told every user their good reps were bad while looking entirely plausible. `test_model_parity.py` includes a test that fails if that inversion ever returns.

The web app has its own Vitest suite alongside the pytest suite:

```bash
npm --prefix apps/web run test     # 162 passed across 9 files
```

`npm test` chains `test:py` and `test:js`, so both run from the repo root.

Beyond the parity runners, the Vitest suite covers the rep counter's FSM and
threshold calibration, the form-score aggregation, the leaderboard ranking, and
two structural guards worth calling out because they catch failures that have no
runtime symptom:

- `lib/__tests__/pose-wiring.test.ts` asserts that the workout and challenge
  pages actually forward pose frames into the session. Both pages once passed
  `onPoseFrame={() => {}}`, which left the camera, the skeleton overlay and the
  timer all working perfectly while the rep counter never advanced. Rendering
  those pages needs a real webcam, so the test asserts on the source instead.
- The no-fake-data guard, run by `node scripts/acceptance.mjs`, fails the build
  if a fabricated metric literal appears in a live-UI file.

`node scripts/acceptance.mjs` is the single command that runs everything —
structure, model artifacts, the mirror checks, the package build, typecheck,
pytest, cross-language parity, `next build`, route presence, the two source
guards, and the offline pose assets — and prints a PASS/FAIL table. Current
result: **16 PASS / 0 FAIL / 0 SKIP**.

## Docs index

| Document | Description |
|---|---|
| `docs/ARCHITECTURE.md` | System overview: the full pipeline diagram, module boundaries, and the reasoning behind each stage. |
| `docs/API_CONTRACT.md` | The optional server-side inference API — endpoints, payloads, and how the frontend degrades when it is unavailable. |
| `docs/DATABASE_SCHEMA.md` | Supabase schema: `users`, `workout_sessions`, `workout_reps`, leaderboard, and the privacy rules that constrain what may be stored. |
| `docs/FEATURE_SCHEMA.md` | The 37-feature biomechanical contract — the single most important interface in the project, shared by the Python trainer and the TypeScript runtime. |
| `docs/FORM_SCORE.md` | The scoring formula: depth, alignment, tempo, consistency and range-of-motion components, per-rep and session aggregation, valid/invalid decisions, and issue attribution. |
| `docs/MODEL_CONTRACT.md` | The modelling contract: task definition, candidate comparison, subject-independent splitting, and threshold discipline. |
| `docs/POSE_SCHEMA.md` | Pose engine choice, the 33-landmark index table, and the guarantee that Python training and browser inference see identical landmark semantics. |
| `docs/UX_FLOW.md` | User flows and interaction contract: the real routes, the workout session state machine, calibration, the rep feedback loop, error states, and the honest-uncertainty and no-fake-data rules. |

This index lists the documents present in `docs/` at the time of writing. Because other
documents are being added in parallel, run `ls docs/` if you need the current list.

## Privacy

Pose estimation runs **in the browser**. Video frames are read from `getUserMedia`, processed locally by MediaPipe Pose, and discarded. **No video, no frames and no images ever leave the device, and nothing is uploaded.**

- There is no server-side vision component. The optional API path is not required for a workout to run.
- What is stored is numbers only: rep counts, per-rep probabilities, component scores, durations.
- Sessions are persisted to `localStorage` by default. Supabase mirroring is **off** unless you explicitly set the two environment variables below, and even then only numeric summaries and an optional display name are sent.
- No login is required. The app works fully anonymously.
- The only user-supplied text field anywhere is the leaderboard `display_name`, which is sanitised before insert.

## Configuration

All environment variables are **optional**. With none set, the app runs entirely locally and the Supabase mirror is disabled. See `.env.example` for the full list; copy it to `apps/web/.env.local` if you want the mirror enabled.

## Limitations

These are real and measured, not hedging.

- **Accuracy is ~0.69 on held-out subjects.** Four subjects were never seen during training, and accuracy on them ranged from 0.44 to 0.86. Expect noticeably worse results on a person whose movement style is not represented in the dataset.
- **The output is binary good/bad only.** The model predicts `P(good form)` and thresholds it. There is no multi-class fault taxonomy.
- **The model cannot reliably name a specific fault.** Issue codes such as `INCOMPLETE_DEPTH` or `HIPS_DROPPING` come from the *geometric* engine, which emits an issue only when its measured precondition is actually satisfied. They are not the classifier's explanation, and no attempt is made to attribute a bad rep to the model. This is deliberate: it keeps the app from appearing to know more than it does.
- **Predictions near the threshold are uncertain.** When `P(good)` falls within `threshold ± 0.08`, the app says "Borderline — form is close to the threshold" rather than asserting a verdict.
- **Front-view performance is the weakest** (0.63 accuracy) because elbow angles are foreshortened in a front-facing close-up. Diagonal view performs best (0.77).
- **It is not a medical, physiotherapy or professional coaching substitute.** It is a form-feedback tool built for a school IT fest. It does not diagnose injury risk, muscle weakness, or anything clinical, and it should not be used to make training or rehabilitation decisions.
- **Capture-quality features are excluded from the model**, so the app does not degrade its prediction based on how well you were filmed. Visibility and tracking diagnostics are surfaced in the UI instead.
- **The last rep can be dropped if you stop moving abruptly.** The angle smoother is causal — it lags about 6 frames and cannot look ahead — so a rep that ends without a brief pause at the top may not close. Holding the top position for a moment, which is what people do anyway, avoids it. There is a documented expected-failure test for this rather than a silent fix.
- **Offline capability costs about 28 MB of static assets.** The MediaPipe WASM runtime (19.3 MB) and the pose landmarker (9.4 MB) are served from `apps/web/public/` so the app runs with the network unplugged. If that bundle size is unacceptable for your host, delete those files and the app falls back to the CDN — it just needs the network again.
