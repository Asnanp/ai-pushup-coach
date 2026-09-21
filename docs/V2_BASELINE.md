# AI Push-Up Coach V2 — Baseline Report

This document records the exact state of the verified V1 baseline before making V2 modifications.
All numbers in this report are read directly from on-disk artifacts and command outputs.

---

## 1. Git State

- **Baseline Commit**: `2477e1a` (`chore(baseline): preserve verified V1 baseline state`)
- **Baseline Tag**: `v1.0.0-baseline`
- **Active Working Branch**: `v2`
- **Repo Directory**: `ai-pushup-coach`

---

## 2. Model Artifact Checksums (SHA-256)

Recorded directly from `ml/models/` prior to any code or data alterations:

| Artifact | Path | SHA-256 Checksum |
| :--- | :--- | :--- |
| **Model JSON** | `ml/models/pushup_form_model.json` | `b430119e3f45a5be067904410a899f573d4bc9fdef25d37833514c8acb6eaab6` |
| **Metadata JSON** | `ml/models/pushup_form_model.metadata.json` | `a87c22ded5fbc7ac08ab4fe4304c62ceab781c481ef872ad48ac86a426a0b572` |
| **Parity Fixture** | `ml/models/parity_fixture.json` | `35303f60e3d3f9ce8a624d4c1a167c8b865cfb64325f984dc4912c723c6038c7` |
| **Joblib Model** | `ml/models/pushup_form_model.joblib` | `74e7f5fc53b8902217af63a7f6d6435e5541293ffa9559d0431ff0651ebd1354` |

---

## 3. Baseline Test Results

### Acceptance Run (`node scripts/acceptance.mjs`)
- **Status**: `16 PASS / 0 FAIL / 0 SKIP` (Exit Code `0`)
- **Repo structure**: PASS (10 dirs + 9 files present)
- **Model artifacts**: PASS (kind=forest, feature_spec_version=1)
- **Model/metadata agreement**: PASS (feature_names=34, n_features=34, decision_threshold=0.4600000000000001)
- **Capture-feature exclusion**: PASS (7 capture features excluded, none in feature_names)
- **Public model mirror**: PASS (3 pipeline artifacts byte-for-byte vs ml/models, 1 vendored asset)
- **Package build**: PASS (`scripts/build-packages.mjs` exited 0)
- **Typecheck**: PASS (`scripts/typecheck.mjs` exited 0)
- **Python test suite**: PASS (44 passed, 0 skipped)
- **Cross-language model parity**: PASS (max \|ts - expected\| = 1.665e-16 over 200 cases < 1e-6)
- **Cross-language feature parity**: PASS (37 values, all finite-or-NaN)
- **Feature contract**: PASS (FEATURE_NAMES=37, docs list=37)
- **Next.js production build**: PASS (`next build` exited 0)
- **Routes present**: PASS (7 routes present)
- **No-fake-data guard**: PASS (0 suspicious literals in 14 source files)
- **Privacy guard**: PASS (no frame/landmark uploads)
- **Offline pose assets**: PASS (4 WASM files byte-identical, 19.3 MB)

---

## 4. Baseline Model Metrics (Read from `ml/reports/metrics.json`)

- **Model Type**: `RandomForestClassifier` (100 estimators)
- **Decision Threshold**: `0.4600000000000001`
- **Positive Class**: `0` (`P(good form)`)

### Held-out Test Set Performance (205 Reps, Subjects 010, 016, 023, 024)
- **Accuracy**: `0.6829` (68.29%)
- **Macro-F1**: `0.6189`
- **ROC-AUC**: `0.7353`
- **Recall (Good Form)**: `0.9106` (112 / 123 good reps identified)
- **Recall (Bad Form)**: `0.3415` (Only 28 / 82 bad reps identified — **65.85% of bad reps missed!**)
- **Precision (Good Form)**: `0.6747` (112 / 166)
- **Precision (Bad Form)**: `0.7179` (28 / 39)
- **Confusion Matrix**:
  - True Good: 112
  - False Bad (Good graded as Bad): 11
  - False Good (Bad graded as Good): 54
  - True Bad: 28

### Per-View Performance on Test Set
| View | Accuracy | Macro-F1 | Reps |
| :--- | :--- | :--- | :--- |
| **Front** | 66.67% | 0.6421 | 84 |
| **Side** | 75.00% | 0.7061 | 44 |
| **Diagonal** | 66.23% | 0.4872 | 77 |

### Per-Subject Performance on Test Set
| Subject | Accuracy | Reps |
| :--- | :--- | :--- |
| **Subject 010** | 86.11% | 72 |
| **Subject 016** | 53.57% | 56 |
| **Subject 023** | 44.44% | 45 |
| **Subject 024** | 87.50% | 32 |

*Notable Observation*: Severe subject variance (`44.4%` on Subject 023 vs `87.5%` on Subject 024) showing significant person-specific leakage and lack of robust generalization.

### Inert / Dead Features in V1
| Feature Name | Importance | Train Mean | Notes |
| :--- | :--- | :--- | :--- |
| `jitter_score` | 0.0000 | 0.0000 | Permanently zero across entire dataset |
| `torso_slope_deg_mean` | 0.0000 | ~0.0 | Inert due to torso coordinate rotation |
| `hip_height_std` | 0.0000 | 0.0000 | Inert in normalized frame |
| `hip_vertical_velocity_max`| 0.0000 | 0.0000 | Inert in normalized frame |
| `shoulder_vertical_velocity_max`| 0.0000 | 0.0000 | Inert in normalized frame |

---

## 5. Baseline Rep Replay Results (`tests/replay_runner.mjs`)

Tested across the 6 real-video fixtures:

| Case | View | Quality | Python Truth | TS WholeClip | TS Adaptive | TS Live |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `good_front_subject_002` | front | good | 11 | 9 | 11 | 6 |
| `good_side_subject_002` | side | good | 12 | 12 | 12 | 10 |
| `good_diagonal_subject_002` | diagonal| good | 12 | 12 | 12 | 11 |
| `bad_front_subject_002` | front | bad | 10 | 10 | 9 | **0** |
| `bad_side_subject_002` | side | bad | 13 | 13 | 4 | **0** |
| `bad_diagonal_subject_002` | diagonal| bad | 9 | 9 | 5 | **0** |
| **TOTALS** | | | **67** | **65** | **53** | **27** |

### Summary Rep Replay Metrics
- Total Reference Reps: `67`
- `tsWholeClip`: 65 reps (Abs Error = 2, 97.0% capture)
- `tsAdaptive`: 53 reps (Abs Error = 14, 79.1% capture)
- `tsLive`: 27 reps (Abs Error = 40, **only 40.3% capture! 0 exact matches!**)
- In `tsLive`, all three bad-form sets counted **0 reps**!

---

## 6. Current Known Limitations & Failure Reproductions

### 1. 25 Lost Dataset Clips (Zero Reps in V1 Extraction)
Out of 144 dataset videos, 25 yielded 0 reps in V1. 19 of the 25 (76%) are BAD form clips.
- **Front View**: 13 / 48 clips (27.1%) lost!
  - `bad_front_subject_008`, `bad_front_subject_009`, `bad_front_subject_014`, `bad_front_subject_015`, `bad_front_subject_017`, `bad_front_subject_018`, `bad_front_subject_019`, `bad_front_subject_021`, `bad_front_subject_022`
  - `good_front_subject_001`, `good_front_subject_013`, `good_front_subject_018`, `good_front_subject_021`
- **Side View**: 8 / 48 clips (16.7%) lost (`bad_side_004, 011, 012, 014, 016, 020, 024` and `good_side_007`).
- **Diagonal View**: 4 / 48 clips (8.3%) lost (`bad_diagonal_019, 020, 021` and `good_diagonal_020`).

### 2. Front-Camera Zero-Count Failure Reproduction
Why front-camera counting fails:
1. **Excessive Reversal Gate (`reversal_fraction > 0.16`)**:
   In front view, 2D arm projection has minor depth noise, giving reversal fractions of 0.17–0.24. V1's `tracking_quality` hard-checks `reversal_fraction > 0.16` and rejects the entire clip as `unstable_signal` (e.g. `bad_front_subject_008` with ROM=119.0° and `good_front_subject_001` with ROM=80.9°).
2. **Unilateral Arm Selection**:
   V1 chooses ONE side (`left` or `right`) using 2D visibility. In front view, both arms work together; tracking noise or foreshortening on one arm ruins the signal while the opposite arm or bilateral combination is clear.
3. **Standing Calibration Lockout (`tsLive`)**:
   Calibrating on a standing user sets `upEnter` and `downEnter` on high extension angles. In front view, push-up depth occurs in depth ($Z$) and image $Y$, not large 2D elbow span. Shallow push-ups (like `bad_front_subject_009`) never reach the strict `downEnter` threshold, oscillating between `DESCENDING` and `UP`, causing 0 reps.
4. **Ankle Occlusion in Front View**:
   `good_front_subject_013` had 0 valid frames because `MIN_VISIBILITY = 0.5` required all 6 joints including ankles, which are frequently occluded or off-screen in head-on framing.
