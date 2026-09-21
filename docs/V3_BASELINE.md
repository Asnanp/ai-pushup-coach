# AI Push-Up Coach V3 — Frozen V2 Baseline

Recorded **before** any V3 engine changes. All hashes and commands below
are from the live working tree, not from memory.

V3 must not destroy V2. Tags `v1.0.0-baseline` and `v2.0.0` remain.

---

## 1. Git state

| Item | Value |
| :--- | :--- |
| **Repo** | `ai-pushup-coach` |
| **Commit at branch point** | `aa55798405dbbec6a061941e7c97d1a32d7fdbb4` |
| **Commit subject** | `feat: front-view grounded plank base, real-time joint degree arcs, and live motion oscilloscope graph` |
| **Source branch** | `v2` (clean working tree) |
| **V3 branch** | `v3-live-pro` (created from the commit above) |
| **Preserved tag** | `v1.0.0-baseline` → `25895b8f70e0e54103df1238762475dde7fd7a67` |
| **Preserved tag** | `v2.0.0` → `1d0f338fa2f8fe782d6f0957a5894f60328cfbc4` |
| **Future release tag** | `v3.0.0` (do not apply until live-webcam acceptance passes) |

HEAD at freeze: `aa55798` is **after** `v2.0.0` (`70dbd9c`). V3 starts from the
latest verified V2 working tree, not from an older tag.

---

## 2. Model SHA-256 (files on disk at freeze)

| Artifact | Path | SHA-256 |
| :--- | :--- | :--- |
| Model JSON | `ml/models/pushup_form_model.json` | `5cd196acafc3c69f9da42f000493380a4bd5fa6c30d7a4975dddd14d2891bd7f` |
| Metadata JSON | `ml/models/pushup_form_model.metadata.json` | `cc924a95ae59f8b1cd1ef7004373d4cdd8f464a95635c2384f6f51310bac40c7` |
| Parity fixture | `ml/models/parity_fixture.json` | `48943910db753cf3566ba12a7c157e8a71c4f25d96b671061e1fc4df56c35190` |
| Joblib model | `ml/models/pushup_form_model.joblib` | `74e7f5fc53b8902217af63a7f6d6435e5541293ffa9559d0431ff0651ebd1354` |

Metadata at freeze: `RandomForestClassifier`, `n_features = 34`,
`feature_spec_version = 1`. **Do not retrain this model in V3 Phase 1–9.**
Live counting reliability comes first.

---

## 3. V2 counter configuration (source of truth: `packages/rep-counter/src/rep-counter.ts`)

| Constant | Value |
| :--- | :--- |
| FSM | `READY → UP → DESCENDING → DOWN → ASCENDING → UP` |
| `UP_FRACTION` / `UP_EXIT_FRACTION` | 0.72 / 0.66 |
| `DOWN_FRACTION` / `DOWN_EXIT_FRACTION` | 0.22 / 0.30 |
| `UP_ENTER` clamp | 100–175° |
| `DOWN_ENTER` clamp | 40–150° |
| Fallback band | upEnter 150, upExit 143, downEnter 100, downExit 108 |
| `MIN_DETECTABLE_ROM_DEG` | 18 |
| `MIN_REP_SECONDS` / `MAX_REP_SECONDS` | 0.35 / 6 |
| Plausible elbow | 25–179.5° |
| Smoother / median | window 9 / k 5 |
| Calibration practice reps | **2 required** (`CALIBRATION_REPS_REQUIRED`) |
| Live feed | **one** `phaseEvidence` scalar into the elbow FSM |

Front extractor blend at freeze: `0.75 * combinedElbow + 0.25 * verticalEquivalentAngle`.
World landmarks are accepted by the extractor signature and **never supplied**
by `PoseEngine` / `WorkoutSession`.

---

## 4. V2 frontend tests (measured this freeze)

Command: `npm --prefix apps/web run test`

```
Test Files  9 passed (9)
     Tests  167 passed (167)
```

Files: pose-wiring, format, camera, session-store, biomechanics, rep-counter
(37), model-runtime, form-engine, workout-session (20).

---

## 5. V2 replay metrics (on-disk artifact, not re-invented)

From `ml/reports/v2_rep_replay.json` (`timestamp: 2026-09-21T05:56:55.749Z`):

| Slice | GT reps | Counted | Precision | Recall | MAE |
| :--- | ---: | ---: | ---: | ---: | ---: |
| Overall (144 clips) | 917 | 1173 | 0.7528 | 0.9629 | 2.25 |
| Front | 259 | 375 | 0.664 | 0.9614 | 2.833 |
| Side | 283 | 370 | 0.7324 | 0.9576 | 2.313 |
| Diagonal | 375 | 428 | 0.8481 | 0.968 | 1.604 |
| Good | 574 | 724 | 0.7818 | 0.9861 | 2.306 |
| Bad | 343 | 449 | 0.706 | 0.9242 | 2.194 |

Dataset replay **over-counts** (precision 75%, MAE 2.25) while the reported
live failure is **missed reps**. Replay is therefore not a live-webcam proxy.

V1 `tsLive` fixture numbers from `docs/V2_BASELINE.md` (kept as historical
live-path evidence): 27 / 67 reference reps (40.3% capture); all three
bad-form clips counted **0**.

---

## 6. Known live missed-rep failure (the V3 problem)

Observed product path:

1. Person does ordinary push-ups facing the webcam.
2. Calibration succeeds.
3. Countdown succeeds.
4. Camera preview + pose skeleton succeed.
5. **Reps are missed or not counted.**

On-disk diagnosis already pointing at the live path (must be confirmed with
numerical traces, not guessed as a threshold patch):

1. **World landmarks dropped.** `PoseEngine.toPoseFrame` copies only
   `result.landmarks`. `worldLandmarks` never enter `PoseFrame`.
2. **3D elbow angle is broken.** `signal-extractors.ts` computes
   `z: (c.z ?? 0) - (c.z ?? 0)` → always 0, so “3D” angles ignore depth.
3. **Extractor never receives world landmarks** even if they existed
   (`WorkoutSession` calls `extract(landmarks, timestamp)` only).
4. **Single-signal FSM.** Front 2D elbow is weak; fusion is a 25% vertical
   garnish on one scalar, then classic up/down thresholds.
5. **Two discarded practice reps + countdown motion** can still poison ROM.
6. **AUTO view may retarget extractors mid-cycle.**
7. **Diagonal `worldDepthMotion` operator-precedence bug**
   (`z ?? 0 + other`).

V3 rule: measure the live signal, then fix the motion engine.
Do not declare success from prerecorded clips alone.

---

## 7. V2 acceptance / docs at freeze

- `docs/V2_ACCEPTANCE.md` — 25 gates via `scripts/acceptance-v2.mjs`
- `docs/BUILD_STATUS.md` — last recorded frontend **165** tests (this freeze
  measured **167**; the two extra tests landed in later V2 commits after that
  status doc)
- `docs/V2_ARCHITECTURE.md`, `docs/FRONT_VIEW_REPORT.md`

Python suite measured at freeze (`node scripts/run-tests.mjs`):

```
[test] using ...\envs\pushup\Scripts\python.exe
46 passed in 39.42s
```

Frontend Vitest at freeze: **167 passed**. After V3 engine wiring the same suite
is **177 passed** (10 new V3 tests; no V2 regressions).

---

## 8. What V3 is allowed to change

Allowed immediately: pose world-landmark plumbing, multi-signal fusion,
continuous phase, coherent-cycle FSM, live trace lab, auto-learn ROM,
attempt-then-grade.

Not allowed until live counting is reliable: ML retrain, UI-only polish
presented as a counter fix, shipping on dataset replay alone.
