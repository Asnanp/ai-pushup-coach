# AGENTS.md — 20-Agent Roster & Coordination Protocol

This document defines who owns what in the AI Push-Up Coach repository, how agents
hand work to each other, and which gates a change must clear before anyone may call
it done.

Every path below exists in the repository. The roster is derived from the real module
boundaries in `docs/ARCHITECTURE.md §3`, not from an org chart.

Repository root: `ai-pushup-coach/`

---

## 1. Roster

Twenty agents. "Owns" means the agent is the only writer for those paths (see §3.3).

| ID | Role | Owns (paths) | Responsibility | Key deliverable |
|---|---|---|---|---|
| A01 | Program Lead | `package.json`, `docs/BUILD_STATUS.md` | Owns the build order, the script surface, and the single status document. Adjudicates contract disputes between agents and blocks a merge that breaks a gate. | `docs/BUILD_STATUS.md` with a PASS/FAIL line per gate. |
| A02 | UX Architect | `docs/UX_FLOW.md`, `apps/web/lib/workout-session.ts`, `apps/web/lib/camera.ts` | Owns `SessionPhase` (`idle \| calibrating \| active \| paused \| finished`), the 250 ms snapshot throttle, the `CaptureErrorCode` → `ERROR_COPY` mapping, and camera lifecycle. | The workout state machine and the error-copy table. |
| A03 | UI Design System | `apps/web/app/globals.css`, `apps/web/tailwind.config.ts`, `apps/web/components/Logo.tsx`, `apps/web/components/AppHeader.tsx`, `apps/web/components/AppFooter.tsx`, `apps/web/components/MetricCard.tsx` | Owns tokens, typography, focus-visible styling, the skip link, and the shared shell. Guarantees no information is conveyed by colour alone. | The shared component shell and design tokens. |
| A04 | Pose Estimation Engineer | `packages/pose/src/pose-engine.ts`, `packages/pose/src/one-euro.ts`, `packages/pose/src/side-selection.ts`, `docs/POSE_SCHEMA.md` | Owns the MediaPipe Tasks wrapper, the 20 FPS inference throttle, `MIN_VISIBILITY = 0.5` frame gating, the One-Euro smoother, and sticky side selection. | `packages/pose` emitting valid, smoothed, normalized landmarks. |
| A05 | Biomechanics / Feature Engineer | `packages/biomechanics/src/extract.ts`, `packages/biomechanics/src/geometry.ts`, `ml/src/features.py`, `docs/FEATURE_SCHEMA.md` | Owns the 37-feature specification and **both** implementations of it (TS runtime + Python training). The single highest-risk seam in the project. | Two extractors that agree to `1e-6` under the feature-parity test. |
| A06 | Rep Counter Engineer | `packages/rep-counter/src/rep-counter.ts`, `packages/rep-counter/src/index.ts`, `ml/src/rep_segmenter.py`, `tests/test_rep_counter.py` | Owns the UP→DOWN→UP state machine, hysteresis, `calibrateThresholds()`, the median-of-3 pre-filter, and rep-boundary events. | A counter that never returns zero reps for a real subject (see §4.1). |
| A07 | ML Training Engineer | `ml/scripts/inspect_dataset.py`, `ml/scripts/extract_pose_features.py`, `ml/scripts/train_classifier.py`, `ml/scripts/tune_features.py`, `ml/models/pushup_form_model.joblib` | Owns the training pipeline: dataset inspection, pose-feature extraction to `ml/data/processed/*.npz`, model selection, and the subject-independent split. | A fitted estimator plus `ml/data/splits/dataset_split.json`. |
| A08 | Model Export & Runtime Engineer | `ml/scripts/export_model.py`, `ml/models/pushup_form_model.json`, `ml/models/pushup_form_model.metadata.json`, `ml/models/parity_fixture.json`, `packages/form-engine/src/model-runtime.ts`, `docs/MODEL_CONTRACT.md` | Owns the JSON tree export, the parity fixture, `positive_class` semantics, and the in-browser tree walker. | Two artifacts from one estimator that score identically. |
| A09 | Real-Time Inference Engineer | `packages/form-engine/src/assessment.ts`, `packages/form-engine/src/geometry-scores.ts`, `packages/form-engine/src/feedback.ts`, `docs/FORM_SCORE.md` | Owns the fusion of ML probability with geometric component scores, the `geometry_score >= 55` validity floor, issue attribution, and `buildFeedback()`. | The per-rep assessment object and the honest-uncertainty copy. |
| A10 | Frontend Pages Engineer | `apps/web/app/page.tsx`, `apps/web/app/workout/page.tsx`, `apps/web/app/challenge/page.tsx`, `apps/web/app/tips/page.tsx`, `apps/web/app/about/page.tsx`, `apps/web/app/layout.tsx` | Owns the App Router pages, the `Screen` union, the calibration gate on the Start button, and the challenge wall-clock countdown. | Seven responding routes. |
| A11 | Data Visualization Engineer | `apps/web/app/progress/page.tsx` | Owns the four summary tiles, the three Recharts line series, the history table, and the `--` rendering rule when a score is `null`. | Progress page charts driven by real stored sessions. |
| A12 | Frontend Testing Engineer | `apps/web/package.json` (`test`, `test:watch`), the Vitest harness for `apps/web` | Owns the frontend unit-test surface. **Current state: no `*.test.*` files or Vitest config exist under `apps/web`**, so `npm run test:js` has no coverage to report. Closing that gap is this agent's open task. | A populated Vitest suite. |
| A13 | Backend API Engineer | `apps/api/app/main.py`, `apps/api/app/config.py`, `apps/api/app/schemas.py`, `apps/api/app/paths.py`, `apps/api/app/routers/`, `apps/api/app/services/`, `apps/api/tests/`, `docs/API_CONTRACT.md` | Owns FastAPI app assembly, the `/health`, `/api/v1/form/predict`, `/api/v1/form/predict/batch`, `/api/v1/model/info`, `/api/v1/sessions` and `/api/v1/leaderboard` routes, and the `400` version-mismatch hard failure. | A running service whose scoring matches the browser. |
| A14 | Database Engineer | `supabase/migrations/0001_init.sql`, `supabase/migrations/0002_leaderboard.sql`, `supabase/migrations/0003_rls.sql`, `supabase/seed.sql`, `docs/DATABASE_SCHEMA.md` | Owns the four tables, the `valid_reps + invalid_reps = total_reps` check constraint, the leaderboard ordering, RLS policies, and the indexes. | Additive-only migrations that make bad-rep discarding structurally impossible. |
| A15 | ML Evaluation Engineer | `ml/scripts/calibrate_thresholds.py`, `ml/scripts/audit_rep_counts.py`, `ml/scripts/diagnose_generalisation.py`, `ml/reports/metrics.json`, `ml/reports/feature_search.json` | Owns the held-out TEST metrics, the per-view and per-subject breakdowns, threshold tuning on validation, and the rep-count audit. | `ml/reports/metrics.json` with the real split each number comes from. |
| A16 | Temporal Modelling Engineer | `ml/scripts/train_classifier.py` (`--compare-sequence`), `ml/src/rep_segmenter.py` (window construction) | Owns the sequence-model comparison against the hand-designed aggregate vector, and the written justification for why aggregates won on 144 clips. | The `strategy_comparison` block in `ml/reports/metrics.json`. |
| A17 | Demo / Presentation Engineer | `apps/web/app/challenge/page.tsx`, `apps/web/app/leaderboard/page.tsx`, `apps/web/lib/session-store.ts` | Owns the IT-fest exhibition path: 30-second challenge, `sanitizeName()`, `saveLeaderboardEntry()`, `rankEntries()`, and the localStorage-first persistence that survives venue wifi. | A working challenge → leaderboard loop. |
| A18 | Technical Writer | `docs/ARCHITECTURE.md`, `docs/UX_FLOW.md`, `docs/API_CONTRACT.md`, `docs/DATABASE_SCHEMA.md`, `docs/FEATURE_SCHEMA.md`, `docs/FORM_SCORE.md`, `docs/MODEL_CONTRACT.md`, `docs/POSE_SCHEMA.md` | Owns prose accuracy: every claim traceable to a file, every doc/code discrepancy recorded rather than hidden. | Contracts a reviewer can check against source. |
| A19 | DevOps Engineer | `scripts/build-packages.mjs`, `scripts/typecheck.mjs`, `scripts/run-tests.mjs`, `scripts/ml-pipeline.mjs`, `scripts/python-env.mjs`, `docs/DEPLOYMENT.md` | Owns the cross-platform toolchain: resolving `tsc` from `apps/web/node_modules`, building packages in dependency order, and refusing to let a skipped parity test look like a pass. Also owns the run/build/ship instructions and the recorded environment facts. | Scripts that work from a clean checkout on Windows/macOS/Linux, plus a verified deployment guide. |
| A20 | QA / Acceptance Engineer | `tests/test_rep_counter.py`, `tests/test_feature_parity.py`, `tests/test_model_parity.py`, `tests/parity_runner.mjs`, `tests/model_parity_runner.mjs`, `tests/fixtures/pose_frames.json`, `docs/ACCEPTANCE_TEST.md` | Owns the end-to-end acceptance procedure, the three pytest suites, and the two Node runners that bridge Python to the compiled TypeScript. | `docs/ACCEPTANCE_TEST.md` and a PASS/FAIL verdict per component. |

### 1.1 Coverage check against the required role list

Program lead (A01) · UX architect (A02) · UI design system (A03) · pose estimation (A04) ·
biomechanics/feature engineering (A05) · rep-counter (A06) · ML training (A07) ·
model export/runtime (A08) · real-time inference (A09) · frontend pages (A10) ·
data visualization (A11) · frontend testing (A12) · backend API (A13) · database (A14) ·
ML evaluation (A15) · temporal modelling (A16) · demo/presentation (A17) ·
technical writing (A18) · DevOps (A19) · QA/acceptance (A20).

---

## 2. Coordination Protocol

### 2.1 Shared contracts are the interface between agents

Agents do not call each other's functions across a boundary; they agree on a document.
The `docs/` contracts are the interface. Each contract has exactly one owner (A-column
above) and every other agent is a consumer.

| Contract file | Owner | What it freezes |
|---|---|---|
| `docs/ARCHITECTURE.md` | A18 | Module boundaries and the in-browser-first inference decision |
| `docs/POSE_SCHEMA.md` | A04 | Landmark indices, the four-stage normalization pipeline, visibility handling |
| `docs/FEATURE_SCHEMA.md` | A05 | The 37-feature ordering, `FEATURE_SPEC_VERSION = 1`, side-selection rule |
| `docs/FORM_SCORE.md` | A09 | Component formulas, `MODEL_WEIGHT = 0.35`, the validity rule, issue codes |
| `docs/MODEL_CONTRACT.md` | A08 | Split discipline, `metadata.json` schema, runtime guardrails |
| `docs/API_CONTRACT.md` | A13 | Routes, payloads, error codes |
| `docs/DATABASE_SCHEMA.md` | A14 | Tables, constraints, ordering, RLS |
| `docs/UX_FLOW.md` | A02 | State names, error codes, routes, the `--` rule |

### 2.2 The contract-change rule

> An agent may not change a shared contract without updating every consumer in the same
> change set, and re-running the gate that covers that contract.

Concretely:

- Changing the feature vector (`FEATURE_SCHEMA.md`) requires touching **both**
  `packages/biomechanics/src/extract.ts` and `ml/src/features.py`, re-exporting the model,
  and re-running the feature-parity gate. A one-sided edit is a rejected change.
- Changing an API response field requires updating `apps/api/app/schemas.py`,
  `docs/API_CONTRACT.md`, and any client reader.
- Changing a DB column requires a **new** migration file. Migrations are additive-only
  (`DATABASE_SCHEMA.md §1`); editing `0001_init.sql` after demo day is forbidden.
- Bumping `FEATURE_SPEC_VERSION` requires a re-export and a re-run of the model-parity
  gate. The browser refuses to load a model whose version does not match
  (`MODEL_CONTRACT.md §8`), so a stale version is a hard error, not a warning.

If an owner and a consumer disagree about a contract, A01 (Program Lead) decides and
A18 (Technical Writer) records the resolution in the contract file.

### 2.3 File ownership avoids write conflicts

- One writer per path. The "Owns" column in §1 is exclusive.
- Two agents never hold the same file open for edit. A change that spans two owners is
  split into two change sets, each passing its own gate, in dependency order.
- `docs/BUILD_STATUS.md` is owned solely by A01. No other agent writes it.
- `docs/AGENTS.md` and `docs/ACCEPTANCE_TEST.md` are owned by A01/A20 respectively.
- Generated artifacts (`packages/*/dist/`, `apps/web/.next/`) are never hand-edited.
  They are outputs of `npm run build:packages` and `npm run build`.

### 2.4 No success claim without a verification command

> No agent may report a task as complete without pasting the command it ran and the
> observed result.

Accepted evidence is a command plus its exit status or output, e.g.
`npm run typecheck` → exit 0, or `npm run test:py` → `N passed, 0 skipped`.

Specifically disallowed:

- "The tests should pass" — run them.
- "Parity is fine" — run `pytest tests/test_feature_parity.py tests/test_model_parity.py`
  and confirm **`0 skipped`**. Both parity suites call `pytest.skip()` when the compiled
  packages or Node are absent (`scripts/run-tests.mjs` header explains the trap), so a
  green run with skips is not verification.
- "The page works" — name the route and the HTTP status you observed.

### 2.5 Handoff and escalation

| Situation | Route |
|---|---|
| Contract needs a field added | Owner of the contract, then all consumers, then the covering gate |
| Gate fails | The owning agent fixes it; the gate is not waived |
| Doc and code disagree | Code wins; A18 records the disagreement (as `UX_FLOW.md §11` does) |
| Two agents need the same file | A01 sequences them; the second waits |
| A gate cannot run in the current environment | Report it as `BLOCKED` with the missing dependency, never as `PASS` |

---

## 3. Interface / Ownership Matrix

The five artifacts that cross an agent boundary. This is the table to consult before
changing anything shared.

| Shared artifact | Defined by | Owner | Consumers | Breaks if mismatched |
|---|---|---|---|---|
| **Feature vector** (37 ordered floats, `FEATURE_SPEC_VERSION = 1`) | `docs/FEATURE_SCHEMA.md §8` | A05 | A06 (window construction), A07 (training), A08 (export + runtime), A09 (assessment), A13 (`apps/api/app/services/features.py`), A15 (evaluation), A16 (sequence comparison) | Model trained on one distribution, served another — degrades silently and reads as "the model is just bad" |
| **Model JSON** (`ml/models/pushup_form_model.json` + `metadata.json`) | `docs/MODEL_CONTRACT.md §6–8` | A08 | A09 (`packages/form-engine/src/model-runtime.ts`), A13 (`apps/api/app/services/model_service.py`), A20 (parity runner) | Browser scores differently from sklearn; a class inversion returns `P(bad)` where `P(good)` was expected |
| **API contract** (`/health`, `/api/v1/form/predict[/batch]`, `/api/v1/model/info`, `/api/v1/sessions`, `/api/v1/leaderboard`) | `docs/API_CONTRACT.md` | A13 | A09 (optional server scoring), A11 (progress data), A17 (leaderboard sync), A18 (docs) | Client sends a shape the server rejects with `422`, or scores against a stale `feature_spec_version` |
| **DB schema** (`users`, `workout_sessions`, `workout_reps`, `leaderboard_entries`) | `docs/DATABASE_SCHEMA.md` | A14 | A13 (`supabase_client.py`), A17 (leaderboard insert), A11 (history reads) | `valid_reps + invalid_reps = total_reps` violated; leaderboard ordering diverges from `rankEntries()` |
| **`packages/types`** (shared TS contracts: `SessionPhase`, `CaptureErrorCode`, `RepState`, `PoseFrame`, `IssueCode`) | `packages/types/src/index.ts` | A03 (types package interface), co-signed by A02/A04/A06/A09 per union | Every package and every page | A new state or error code compiles in one place and is unhandled in another; the UI falls through to `UNKNOWN` |

### 3.1 Secondary interfaces

| Artifact | Owner | Consumers | Note |
|---|---|---|---|
| Rep boundary event `{ repIndex, frames[] }` | A06 | A09, A02 | The window A09 aggregates into the feature vector |
| `SessionSnapshot` (throttled to 250 ms) | A02 | A10, A11 | `SNAPSHOT_INTERVAL_MS = 250`; phase changes and reps bypass the throttle |
| `ISSUE_COPY` / issue codes | A09 | A10 (`/tips`), A11 (common issue column), A14 (`detected_issue`) | Imported, never duplicated, so tips cannot drift from live feedback |
| `localStorage` keys `aipc:sessions:v1`, `aipc:leaderboard:v1`, `aipc:device:v1` | A17 | A10, A11, A14 | Primary store; Supabase is an optional mirror |

---

## 4. Verification Gates

Four gates. Every agent's change must leave all four green.

| Gate | Command | Protects against |
|---|---|---|
| **Rep-counter suite** | `npm run test:py` → `tests/test_rep_counter.py` | Threshold and segmentation regressions. Encodes a real failure: a fixed 155° "up" threshold silently produced **zero reps** for an entire subject whose front-view elbow angle peaked at 136°. Calibration from the user's own range of motion exists because of this. |
| **Cross-language feature parity** | `pytest tests/test_feature_parity.py` (via `npm run test:py`) | The TS runtime extractor and the Python training extractor drifting apart. If they disagree, the model is trained on one feature distribution and served another. Requires `0 skipped`. |
| **Model parity** | `pytest tests/test_model_parity.py` (via `npm run test:py`) | The browser tree walker disagreeing with sklearn, tolerance `1e-6`. This gate exists because a class-inversion bug once made the export return `P(bad)` where `P(good)` was expected — the app would have told every user their good reps were bad. |
| **TypeScript typecheck** | `npm run typecheck` | A new `SessionPhase`, `CaptureErrorCode` or `IssueCode` member compiling in one module and being unhandled in another. `scripts/typecheck.mjs` resolves `tsc` from `apps/web/node_modules` and checks all five packages plus `apps/web`. |

Supporting commands:

| Command | Purpose |
|---|---|
| `npm run build:packages` | Compiles `packages/{types,pose,biomechanics,rep-counter,form-engine}` to `dist/` in dependency order. Required before the parity tests, which skip without `dist/`. |
| `npm run build` | `build:packages` then `next build`. |
| `npm run ml:pipeline` | Runs `inspect_dataset` → `extract_pose_features` → `calibrate_thresholds` → `train_classifier` → `export_model`. `export_model.py` refuses to write the JSON unless its own scoring reproduces sklearn within `1e-6`. |
| `npm run test:js` | Vitest for `apps/web`. Currently declares no test files. |

**Gate discipline.** A skip is not a pass. `scripts/run-tests.mjs` builds the packages
first and then runs pytest specifically so that a silent skip cannot masquerade as
verification.

---

## 5. Known Discrepancies Agents Must Not Paper Over

Recorded honestly; each is a real gap between a document and the repository.

| # | Document says | Repository reality |
|---|---|---|
| 1 | `FEATURE_SCHEMA.md §8` defines a **37**-feature vector. | `ml/models/pushup_form_model.metadata.json` ships `"n_features": 34` with `"n_features_contract": 37` and an `excluded_capture_features` list. The shipped model consumes a 34-feature subset. |
| 2 | `UX_FLOW.md §1.3` states `/about` has no `page.tsx` and 404s. | `apps/web/app/about/page.tsx` exists. The route resolves. |
| 3 | `MODEL_CONTRACT.md §7` example shows `RandomForestClassifier` and `positive_class: "good"` as a string. | The shipped metadata records `"model_type": "GradientBoostingClassifier"` and `"positive_class": 0` (integer index), with `"positive_class_meaning": "P(good form)"` alongside it. |
| 4 | `apps/web/package.json` declares `test:js` → `vitest run`. | No Vitest config and no `*.test.*` files exist under `apps/web`. |
| 5 | `ARCHITECTURE.md §4.8` says sessions persist to Supabase. | `apps/web/lib/session-store.ts` makes `localStorage` primary and Supabase an optional mirror. |

Any agent that resolves one of these must update the document and the code in the same
change set, and re-run the covering gate.
