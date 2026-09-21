# ACCEPTANCE_TEST.md — End-to-End Acceptance Procedure

A 16-step executable acceptance test for the AI Push-Up Coach, followed by a
component-by-component PASS/FAIL sign-off.

This is a **manual-plus-scripted** procedure: steps 1–5 and 14–16 are commands with
objective output; steps 6–13 require a camera and a human performing push-ups. Each step
states the action, the expected result, how to verify it, and the failure mode to watch for.

Repository root: `ai-pushup-coach/`. All commands run from that directory.

---

## 0. Preconditions

| Requirement | Value | Why |
|---|---|---|
| Node.js | `>= 20.9.0` (declared in `package.json` `engines`) | Next.js 15 and the `.mjs` runners |
| Web dependencies | installed via `npm --prefix apps/web install` | `tsc` and Vitest live under `apps/web/node_modules`, not at the repo root |
| Python environment | resolvable by `scripts/python-env.mjs` | `npm run test:py` needs numpy, scikit-learn, joblib, pytest, mediapipe |
| Camera | a working webcam, served over `http://localhost:3000` | `getUserMedia` requires a secure context; a LAN IP yields `INSECURE_CONTEXT` |
| Space | ~3 m of floor, full body visible including feet | Ankles are required for the shoulder–hip–ankle line |
| Test subject | one person, alone in frame | More than one person raises `MULTIPLE_PEOPLE` |
| Model artifacts | present in `ml/models/` | `ml/models/pushup_form_model.json` must exist for the browser path |
| API service dependencies | `fastapi`, `uvicorn`, `pydantic` installed in the Python environment | `docs/DEPLOYMENT.md` records that the ML interpreter used for the pipeline did **not** have these installed. The browser path is unaffected; only the component-9 API row depends on this. |

Run every step in order. A step that fails blocks the steps that depend on it.

### 0.1 Automated harness

`scripts/acceptance.mjs` automates the machine-checkable subset of this procedure —
structure, model artifacts, the package build, typecheck, the Python suite,
cross-language parity, the feature contract, the Next.js production build, route
presence, and two source guards (no fake data, no frame uploads) — and prints a
PASS/FAIL/SKIP table.

```
node scripts/acceptance.mjs          # human-readable table
node scripts/acceptance.mjs --json   # machine-readable
```

It exits `0` on clean, `1` on any FAIL, and `2` when the only problem is a blocking
SKIP. It complements, and does not replace, steps 7–16 below: the harness cannot grant
camera permission, hold a push-up position, or observe the network log during a set.
Those steps are manual by necessity.

---

## 1. The 16-step procedure

| # | Action | Expected result | Verify with | Failure mode to watch for |
|---|---|---|---|---|
| 1 | Confirm environment, typecheck, and the Python baseline. `node -v`, then `npm run typecheck`, then `npm run test:py`. | Node `>= 20.9.0`. `npm run typecheck` exits 0 across the five packages and `apps/web`. `npm run test:py` reports **`0 skipped`**. | `echo $?` after each; read the pytest summary line for `skipped` | A green run with skips. Both parity suites call `pytest.skip()` when `packages/*/dist` or Node is absent, so a skip looks like a pass. `scripts/run-tests.mjs` builds first specifically to defeat this. |
| 2 | Build the packages: `npm run build:packages`. | `dist/index.js` exists for `types`, `pose`, `biomechanics`, `rep-counter`, `form-engine`. | `ls packages/*/dist/index.js` | A package fails to compile because `tsc` was resolved from the wrong location; `scripts/build-packages.mjs` prints the two paths it looked in. |
| 3 | Produce the Next.js production build: `npm run build` (runs `build:packages` then `next build`). | Build succeeds and lists the seven routes. | `ls apps/web/.next/BUILD_ID` | A missing route is silently absent from the manifest. Check the route list for all of `/`, `/workout`, `/progress`, `/tips`, `/about`, `/challenge`, `/leaderboard`. |
| 4 | Verify model artifact presence and internal consistency. Inspect `ml/models/pushup_form_model.json`, `ml/models/pushup_form_model.metadata.json`, `ml/models/pushup_form_model.joblib`, `ml/models/parity_fixture.json`. | All four files exist. `metadata.json` records `feature_spec_version: 1`, a `decision_threshold`, and `positive_class` with `positive_class_meaning: "P(good form)"`. | `ls ml/models/`; read the metadata header | A missing JSON model makes the engine fall back to geometry-only and label scores `rule-based` — the demo would silently lose its ML half. A missing `parity_fixture.json` makes step 5 skip. |
| 5 | Run model parity and feature parity explicitly: `pytest tests/test_model_parity.py tests/test_feature_parity.py -v`. | Both pass with **`0 skipped`**. Model parity agrees within `1e-6` on the fixture vectors; feature parity compares `ml/src/features.py` against `packages/biomechanics/dist/extract.js`. | the pytest summary; confirm `skipped` is `0` | A class inversion: the runtime returns `P(bad)` where `P(good)` is expected. This is the exact bug the gate was written for. Also watch for a silent skip caused by a missing compiled package. |
| 6 | Start the dev server (`npm run dev`) and request every route. `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000<route>` for each of `/`, `/workout`, `/progress`, `/tips`, `/about`, `/challenge`, `/leaderboard`. | Seven `200` responses. `/progress` and `/leaderboard` render their neutral skeleton/empty state on first paint. | the seven status codes | Any non-200, especially `/about` — older documentation claimed it 404s. Confirm against `apps/web/app/about/page.tsx`, which exists. |
| 7 | Camera permission behaviour. Open `/workout`, press **START WORKOUT** with permission **denied**, then retry with permission granted. | Denied: an `ErrorBanner` with `role="alert"` reading "Camera permission denied", and a **Retry** button because `PERMISSION_DENIED` is recoverable. Granted: the stream attaches and the video plays. | visual; `document.querySelector('[role=alert]')` | A recoverable error hiding its Retry button, or a granted stream that never paints because `videoWidth` stayed 0 within the 4 s timeout (`INIT_FAILED`). |
| 8 | Calibration behaviour. Hold a push-up position in side view. | The `CalibrationPanel` shows six checks — `full-body`, `pose`, `view`, `lighting`, `distance`, `stable` — polling at 5 Hz. **Start counting is disabled until all six pass** and carries `aria-describedby` pointing at the waiting hint. | visual; inspect the disabled state on the Start counting button | Starting to count on untrusted geometry. Ankles must be tracked and unclipped; a frame cut at the ankles is useless for the shoulder–hip–ankle line. `INSECURE_CONTEXT` is the only non-recoverable code and must suppress Retry entirely. |
| 9 | Rep counting on a real set. Perform 5 clean push-ups. | The counter increments to 5. Chips show `elbow NN°`, `state <RepState>`, `cycle NN%`. Step fully out of frame for ~0.6 s: the phase becomes `paused` with `pausedReason: 'pose-lost'` after 12 consecutive invalid frames, the overlay reads "Pose lost — step back into frame", and counting auto-resumes on re-entry. | visual; the rep count and the paused overlay | Zero reps for a real subject. The up/down thresholds are derived from the user's own range of motion precisely because a fixed 155° threshold once produced zero reps for a subject whose front-view elbow angle peaked at 136°. Also watch for a pause that inflates `elapsedSeconds` — paused time must be excluded. |
| 10 | Valid vs invalid rep recording. Perform 3 clean reps, then 2 deliberately shallow or sagging reps. | "Valid reps" and "Invalid reps" both display, side by side, with distinct tones. Total equals valid plus invalid. No bad rep is discarded. | visual; cross-check against the persisted session | A bad rep being silently dropped, which would inflate the session score and hide the fault. Validity requires **both** `P(good) >= decision_threshold` **and** `geometry_score >= 55`. |
| 11 | Form score appears with a real value. Complete at least 3 reps and read the score. | A number out of 100 with one decimal, e.g. `78 / 100`. Below 3 reps it is labelled **provisional**; at 0 reps it renders `--` with "Complete a rep to score". If the model is missing, the source is labelled "Rule-based scoring (model not loaded)". | visual; compare against the per-rep meters | A placeholder or hardcoded value. The score must be `0.65 * geometry_score + 0.35 * model_score`, and the four live meters (Depth, Alignment, Tempo, Consistency) must move per rep. Note ROM is folded into `repScore` but has no live meter. |
| 12 | Session persistence across reload. Press **End Workout**, then reload `/workout` and open `/progress`. | The session is present in `/progress` after the reload. The store key is `aipc:sessions:v1`. The header states which store is live — "Stored locally on this device." or "Synced to your account." | `localStorage.getItem('aipc:sessions:v1')` in the console; the `/progress` history table | A session lost on reload because only Supabase was written. `localStorage` is the primary store and Supabase an optional mirror, so the demo survives venue wifi. Also confirm the camera LED goes out — a leaked stream after navigation looks like spyware at a public demo. |
| 13 | Leaderboard entry creation. Open `/challenge`, enter a name, run the 30-second round, finish. | A leaderboard entry is created with the sanitised display name and appears on `/leaderboard`, ordered by `validReps DESC`, `formScore DESC`, `durationSeconds ASC`, `createdAt ASC`. Key: `aipc:leaderboard:v1`. | `localStorage.getItem('aipc:leaderboard:v1')`; the `/leaderboard` rows | An entry that never appears because `mode` was not `challenge`, or a name that skips `sanitizeName()` (control characters, >24 chars). Invalid reps must still be stored and shown even though only valid reps rank. |
| 14 | Progress charts render with real data. Open `/progress` after steps 12–13. | Four summary tiles (Sessions, Total reps, Valid reps, Average form score) and three Recharts line series: Valid reps over time, Form score over time, Consistency over time. Averages render `--` when no session has a finite score. | visual; count the three chart series and four tiles | An axis-less empty grid instead of the `EmptyState` card for a new user. A chart back-filling `null` form scores with `0`. |
| 15 | Privacy check — no network request carries video or frames. Run a full set with the DevTools Network tab open, filter to Fetch/XHR, and record every request. Then audit the code path. | No request body contains image, frame, or `MediaStream` data. Camera frames are processed only in the browser. No video is recorded or persisted by any code path. `/about#privacy` states "Camera frames are analyzed for pose estimation and are not stored." | DevTools Network panel; `grep` the `apps/web` client code for any upload of frame data | Any request whose payload scales with frame count. Only derived numeric features may ever leave the device, and only when the optional server path is explicitly enabled. |
| 16 | No-fake-data check — unavailable metrics render as `--`, never invented. Inspect the workout screen at 0 reps, with pose lost, and before the first snapshot. | `--` for every metric card, `--` / 100 for the form score, `elbow --` for a null or NaN angle, "Waiting for your first rep" when `lastRep` is null, and `--` for any unavailable component meter. | visual; check the DOM text for the literal `--` | A fabricated `0` or a plausible-looking placeholder. `computeMetrics()` returns `null` for `meanRepSeconds` when no finite positive durations exist, and `sessionFormScore()` returns `null` at zero reps — nothing is back-filled. "Zero would be a fabricated measurement." |

---

## 2. Notes on steps that need explanation

### 2.1 Step 1 — why `0 skipped` is the real assertion

`tests/test_feature_parity.py` and `tests/test_model_parity.py` both call `pytest.skip()`
when their prerequisites are missing — the compiled `packages/*/dist` output, or Node for
the TypeScript runners. A skipped test is reported as neither pass nor fail, so a CI log
can look green while the highest-risk integration seam went untested.

`scripts/run-tests.mjs` handles this by checking for
`packages/biomechanics/dist/index.js`, `packages/form-engine/dist/index.js` and
`packages/rep-counter/dist/index.js`, building them if absent, and then running pytest. The
acceptance test must still assert `0 skipped` in the summary, because the runner cannot
know about a skip caused by a missing Node binary.

### 2.2 Step 4 — the feature-count discrepancy

`docs/FEATURE_SCHEMA.md §8` specifies a 37-feature vector. The shipped
`ml/models/pushup_form_model.metadata.json` records `"n_features": 34` alongside
`"n_features_contract": 37` and an `excluded_capture_features` list of seven
capture-quality features. The model consumes the 34-feature subset.

The acceptance test therefore checks **internal consistency**: the model's declared
`n_features` must match the length of the vector the runtime produces. `MODEL_CONTRACT.md §8`
makes a mismatch a hard refusal, not a warning. Do not "fix" this by editing the metadata;
the contract document and the model are reconciled by the owner (A05/A08), not by the tester.

### 2.3 Step 5 — what the model parity test is really guarding

The test compares `packages/form-engine/src/model-runtime.ts` against the exported sklearn
estimator at a tolerance of `1e-6`, using `ml/models/parity_fixture.json`. `export_model.py`
already refuses to write the JSON unless its own Python scoring reproduces sklearn within
`1e-6`; this test guards the other half of the journey — the TypeScript walker.

The reason it exists is concrete: during development the Gradient Boosting export returned
`P(bad)` where the caller expected `P(good)`. Had that inversion surfaced in the runtime
instead of the export, the app would have told every user their good reps were bad. The
`positive_class` semantics are now explicit in `metadata.json`
(`"positive_class": 0`, `"positive_class_meaning": "P(good form)"`).

### 2.4 Step 7 — the error-code table is closed

`CaptureErrorCode` is a closed union. Fifteen codes have copy in `ERROR_COPY`
(`apps/web/lib/camera.ts`), and only `INSECURE_CONTEXT` is non-recoverable. A tester
should confirm the Retry button's presence tracks `recoverable` exactly — a Retry button on
`INSECURE_CONTEXT` would send the user into a loop that can never succeed.

### 2.5 Step 9 — the calibration reason, not just the behaviour

The thresholds are derived from the user's own range of motion by `calibrateThresholds()`:
`localExtrema()` finds the turning points, the median maxima/minima define the operating
band, and the four thresholds sit at fractions of that span (`upEnter` 0.72, `upExit` 0.66,
`downEnter` 0.22, `downExit` 0.30), each clamped and ordering-checked. If fewer than 15
usable samples exist, `FALLBACK_THRESHOLDS` are used and `calibrated` stays `false`.

This exists because a fixed 155° "up" threshold silently produced zero reps for an entire
subject whose front-view elbow angle peaked at 136°. A tester seeing zero reps should check
the calibration sample count before blaming the counter.

### 2.6 Step 15 — what "privacy" means here precisely

The claim under test is narrow and falsifiable: **no camera frame leaves the device**. The
browser is the primary inference path; the FastAPI service exists for batch evaluation,
retraining verification, and environments where the JS model cannot load. A backend outage
therefore cannot interrupt a workout, and no request in the live loop should scale with
frame count. Verifying the negative — that a request does *not* exist — requires watching
the full network log during a set, not spot-checking the code.

### 2.7 Step 16 — the honesty rules the `--` implements

Three separate honesty mechanisms are under test at once:

1. **No fake data.** Unavailable metrics render `--`; `null` is propagated from the data
   layer (`computeMetrics()`, `sessionFormScore()`) rather than converted to `0`.
2. **Honest uncertainty.** `buildFeedback()` refuses to invent a cause: a `bad` label with
   no geometric issue fired reads "Form needs attention" with the detail "no single fault
   stood out strongly".
3. **Honest provenance.** A missing model is labelled "Rule-based scoring (model not
   loaded)" rather than silently substituting a plausible score.

---

## 3. Final validation

Each component is reported as **PASS** or **FAIL**. A component with a skipped test, an
untested path, or an unverifiable claim is reported **FAIL**, not PASS. Do not aggregate:
fourteen PASSes and one FAIL is a FAIL for the build.

| # | Component | Verifying step | Evidence required | Verdict |
|---|---|---|---|---|
| 1 | Pose estimation | 8 | Landmarks tracked, `MIN_VISIBILITY = 0.5` gating observed, overlay draws to canvas only | PASS / FAIL |
| 2 | Rep counter | 9 | Reps counted on a real set; auto-pause at 12 invalid frames; resume on re-entry | PASS / FAIL |
| 3 | Form classifier | 11 | A real score with a real model probability; `unknown` rather than a guess when >3 features are imputed | PASS / FAIL |
| 4 | Model parity | 5 | `pytest tests/test_model_parity.py` passes within `1e-6`, `0 skipped` | PASS / FAIL |
| 5 | Feature parity | 5 | `pytest tests/test_feature_parity.py` passes, `0 skipped` | PASS / FAIL |
| 6 | Frontend build | 3 | `npm run build` succeeds; all seven routes in the manifest | PASS / FAIL |
| 7 | Typecheck | 1 | `npm run typecheck` exits 0 across five packages and `apps/web` | PASS / FAIL |
| 8 | Python tests | 1 | `npm run test:py` passes with `0 skipped` (includes the rep-counter suite) | PASS / FAIL |
| 9 | API | 4 | `apps/api` imports and serves `/health` with `model_loaded: true`; `/api/v1/form/predict` returns a label | PASS / FAIL |
| 10 | Database schema | 13 | Migrations `0001_init.sql`, `0002_leaderboard.sql`, `0003_rls.sql` apply cleanly; `valid_reps + invalid_reps = total_reps` holds | PASS / FAIL |
| 11 | Progress charts | 14 | Three Recharts series and four tiles rendering real stored sessions | PASS / FAIL |
| 12 | Leaderboard | 13 | Entry created on challenge finish; `rankEntries()` ordering applied | PASS / FAIL |
| 13 | Privacy | 15 | No network request carries frame data across a full set | PASS / FAIL |
| 14 | Documentation | all | Every claim in this file traces to a path that exists; the five known discrepancies in `AGENTS.md §5` are recorded, not hidden | PASS / FAIL |

**Overall verdict:** PASS only if all fourteen components are PASS.

### 3.1 Sign-off

| Field | Value |
|---|---|
| Date | |
| Tester (A20) | |
| Build under test (`apps/web/.next/BUILD_ID`) | |
| Model `trained_at` / `exported_at` | |
| Browser and version | |
| Overall verdict | PASS / FAIL |
| Blocking components | |
