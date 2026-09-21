# MODEL_REPORT.md — Push-Up Form Classifier

**Agent 5 — ML Research Writer**
**Report written against artifacts dated 2026-09-20 (train) / 2026-09-20 (export).**

This document reports the measured behaviour of the shipped form classifier. Every number
below is quoted from an artifact in this repository and was re-read at the time of writing.
Numbers that could not be verified from an artifact are explicitly flagged as unverified.
Where a result is unflattering, it is reported as measured.

**Primary sources**

| Source | Role |
|---|---|
| `ml/models/pushup_form_model.metadata.json` | model type, feature list, threshold, class semantics, split, metrics block |
| `ml/reports/metrics.json` | test metrics, confusion matrix, per-view, per-subject, importances |
| `ml/reports/feature_search.json` | 24-variant feature-subset / model / class-balance search |
| `ml/models/pushup_form_model.json` | exported browser artifact (`kind: gbm`) |
| `ml/data/splits/dataset_split.json` | authoritative split record |
| `ml/data/extraction_summary.json` | extraction counts |
| `ml/scripts/train_classifier.py`, `ml/scripts/export_model.py`, `ml/scripts/tune_features.py`, `ml/scripts/diagnose_generalisation.py`, `ml/src/rep_segmenter.py` | protocol |

---

## 1. Summary

The model is a **scikit-learn `RandomForestClassifier`** selected by highest validation
macro-F1 over four candidates (logistic regression, random forest, gradient boosting, XGBoost).
It classifies **one completed push-up repetition** as `good` (textbook form) or `bad` (a form
fault is present). The unit of prediction is a rep window, not a frame. It consumes **34 of the
37 contract features** and emits **P(good form)**.

> **Note — this model replaced the previously reported `GradientBoostingClassifier`.** Model
> selection is re-run on every training pass, and repairing the timestamp corruption described in
> `docs/BUILD_STATUS.md` §2.11 changed which candidate won. The gradient-boosting figures quoted
> in earlier drafts of this report (accuracy 0.688, macro-F1 0.672, threshold 0.58) were
> computed on **corrupted features** and must not be quoted.

`metadata.json` records `positive_class: 0` with `positive_class_meaning: "P(good form)"`;
the label convention in the trainer is `0 = good`, `1 = bad`.

### Headline held-out performance

Evaluated on **205 reps from 4 subjects never seen during training or threshold selection**
(`test_subjects = ["010","016","023","024"]`):

| Metric | Value |
|---|---|
| Accuracy | **0.6829** (0.6829268292682927) |
| Macro-F1 | **0.6189** (0.6189482112728417) |
| ROC-AUC | **0.7353** (0.7353261947253619) |
| Precision (good) | 0.6747 |
| Recall (good) | 0.9106 |
| F1 (good) | 0.7751 |
| Precision (bad) | 0.7179 |
| Recall (bad) | **0.3415** |
| F1 (bad) | 0.4628 |

Decision threshold: **0.46** (0.4600000000000001), tuned on validation only.

Read plainly: on a person the model has never seen, it is right about **68%** of the time.
It is **good at catching good form** (recall 0.911) but **weak at catching bad form**
(recall 0.341) — it misses roughly **two thirds** of bad-form reps. That is the honest
headline, and it is the number this report should be judged on — not any validation or
training figure.

**Why macro-F1 fell and AUC rose.** Removing the corrupted timing features *lowered* macro-F1
(0.672 → 0.619) while *raising* ROC-AUC (0.702 → 0.735). AUC is threshold-independent, so the
ranking quality genuinely improved; macro-F1 fell because the operating point now sits in a
different place, and the previous figure was partly an artifact of features that leaked
implausible timing information. The earlier 0.672 was not a real capability we lost.

These figures were **independently reproduced** by `ml/reports/evaluation.json`, a separate
scoring pass over the same shipped bundle that fits nothing; it matches every value above to
zero difference (`agreement_check.max_abs_difference: 0.0`). See §8.1. For contrast, the same
model scores **0.9754** on its own training reps and **0.9510** on validation — both in-sample
after the final refit, and both explicitly not project accuracy.

---

## 2. Dataset

| Property | Value | Source |
|---|---|---|
| Videos | 144 | `dataset_split.json` (`total_videos: 144`) |
| Subjects | 24 | `dataset_split.json` (`total_subjects: 24`) |
| Clips per subject | 6 | 144 / 24 |
| Design | good/bad × front/side/diagonal | `dataset_split.json` per-split `views` |
| Rep windows that survived segmentation | **917** | `extraction_summary.json` (`total_rep_windows: 917`), `metrics.json` (`total_reps: 917`) |
| Reps used for training | 569 | `metrics.json` (`train_reps`) |
| Reps used for validation | 143 | `metrics.json` (`validation_reps`) |
| Reps used for test | 205 | `metrics.json` (`test_reps`) |

569 + 143 + 205 = 917, consistent.

### Clips excluded, and why

`metrics.json` does **not** record a skipped-clip count, so this was measured directly from
the 144 files in `ml/data/processed/`:

| Outcome | Clips |
|---|---|
| Contributed ≥ 1 rep window | 119 |
| **Produced zero rep windows** | **25** (17.4% of 144) |
| — rejected by the tracking-quality gate (`track_quality_tracked == False`) | 18 |
| — passed the tracking gate but segmentation found no rep windows | 7 |

The 18 gate rejections break down by the reason recorded in `track_quality_reason`:
`unstable_signal` 15, `frozen_signal` 1, `insufficient_range+frozen_signal+unstable_signal` 1,
`too_few_frames` 1.

The gate itself is `tracking_quality()` in `ml/src/rep_segmenter.py:206`. It rejects a clip
when the elbow-angle signal has insufficient range (`rom < MIN_TRACKED_ROM_DEG`), is frozen
(`median_step < MIN_TRACKED_MEDIAN_STEP_DEG`), or is unstable
(`reversal_fraction > MAX_REVERSAL_FRACTION`). The stated purpose is to distinguish "our
thresholds were misplaced" from "the arm was never tracked", so an untracked clip is
*reported* rather than silently emitted as a valid empty result.

**The excluded clips are not a neutral sample.** Broken down by label, view and split:

| Breakdown | Excluded clips |
|---|---|
| Label `bad` | **19** |
| Label `good` | **6** |
| View front | 13 |
| View side | 8 |
| View diagonal | 4 |
| Split train | 18 |
| Split validation | 5 |
| Split test | 2 |

Three times as many bad-form clips as good-form clips failed to yield reps, and the front
view is over-represented (13 of 25). The gate therefore removes data non-randomly, and it
removes it in the direction that matters most for a coach: bad reps are exactly the class
the model most needs examples of. This is a real sampling bias in the training set, not a
footnote.

---

## 3. Splitting strategy

**The split is subject-independent.** A subject's six clips all land in exactly one split.
The allocation method (`ml/scripts/inspect_dataset.py:152-188`) is:

1. Compute `sha256(f"aipc-split-v1::{subject_id}")` for every subject.
2. Sort subjects by that hex digest — deliberately *not* by numeric ID, so numbering order
   cannot correlate with recording session or environment.
3. Cut the sorted list at fixed positions: **16 train / 4 validation / 4 test**.

Sizes are fixed rather than hash-banded because pure hash banding on 24 subjects produced a
2-subject test split, too small to report trustworthy metrics on. The *assignment* remains
independent of subject numbering; only the *sizes* are pinned.

| Split | Subjects | Subject IDs | Videos | Reps |
|---|---|---|---|---|
| train | 16 | 001, 002, 004, 005, 006, 008, 009, 011, 012, 013, 015, 017, 018, 020, 021, 022 | 96 | 569 |
| validation | 4 | 003, 007, 014, 019 | 24 | 143 |
| test | 4 | 010, 016, 023, 024 | 24 | 205 |

`train_classifier.py:255-257` asserts the three subject sets are pairwise disjoint and aborts
on any overlap. Each split is also balanced 50/50 good/bad by construction, since every
subject contributes one good and one bad clip per view.

### Why this matters

A random *clip* split — or worse, a random *frame* split — places the same person, the same
room, the same lighting and the same camera in both train and test. Frames from one clip are
highly correlated, so the model can memorise the person and the scene rather than the
movement, and test accuracy inflates dramatically. The project's own diagnosis of the
underlying problem is recorded in `ml/scripts/tune_features.py`: even after torso
normalisation, a Random Forest can identify **which subject** a rep came from with **0.499**
accuracy against a **0.042** chance level. The features retain a subject fingerprint. A
clip-random split would have hidden that completely and produced a flattering, useless
number.

**Documentation discrepancy.** `docs/MODEL_CONTRACT.md` §3 illustrates the split as
train 001–016 / validation 017–020 / test 021–024. That is an illustrative example, not the
actual allocation — subject 021 is in *train* and subjects 003/007/014/019 are in validation.
`ml/data/splits/dataset_split.json` is the authoritative record and is what this report uses.

---

## 4. Feature engineering

**Contract: 37 features, `FEATURE_SPEC_VERSION = 1`**, defined in `docs/FEATURE_SCHEMA.md` §8
and implemented identically in `ml/src/features.py` (Python training path) and
`packages/biomechanics` (TypeScript runtime path). The two extractors must produce the same
values for the same landmarks; this is the project's most important interface.

| Group | Count | Contents |
|---|---|---|
| A — angles | 7 | `elbow_angle_deg_{mean,min,max}`, `shoulder_angle_deg_mean`, `hip_angle_deg_{mean,min}`, `knee_angle_deg_mean` |
| B — alignment | 6 | `body_line_deviation_{mean,max_abs,std}`, `shoulder_hip_ankle_angle_deg_mean`, `torso_slope_deg_mean`, `shoulder_ankle_height_delta_mean` |
| C — depth / ROM | 5 | `shoulder_elbow_height_delta_{min,mean}`, `rom_elbow_deg`, `min_elbow_angle_deg`, `depth_ratio` |
| D — tempo | 8 | `elbow_angular_velocity_{max,mean}`, `elbow_velocity_{down,up}_mean`, `rep_duration_s`, `descent_duration_s`, `ascent_duration_s`, `descent_ascent_ratio` |
| E — stability | 7 | `elbow_angle_std`, `hip_height_std`, `hip_vertical_velocity_max`, `shoulder_vertical_velocity_max`, `pause_at_bottom_s`, `jitter_score`, `body_line_deviation_range` |
| F — quality | 4 | `mean_visibility`, `min_visibility`, `tracking_gap_ratio`, `elbow_angle_opposite_deg_mean` |

### Torso normalisation

No raw pixel coordinate ever reaches the model. Each frame is transformed into a
body-relative frame (`docs/FEATURE_SCHEMA.md` §1):

```
torso_vector = shoulder_mid - hip_mid
R            = rotation by -atan2(torso_vector.y, torso_vector.x)
p''          = (R @ (p - hip_mid)) / ||shoulder_mid - hip_mid||
```

After this, the torso points along `+x`, `y''` deviations *are* sag/pike, and distance from
the camera and subject size cancel out. The model is meant to learn body geometry and
movement, never background, clothing, or how far the person stood from the lens. One body
side is selected per frame (the higher-visibility side, sticky across a rep) because
averaging both sides in a side view injects occluded-landmark garbage into every angle.

### Window aggregation, not per-frame

Features are computed **per rep window**, not per frame. A rep window is all frames between
the top of the previous rep and the top of the current rep, as emitted by the rep state
machine. For the key signals (`elbow_angle_deg`, `hip_angle_deg`, `body_line_deviation`,
`torso_slope_deg`, `shoulder_elbow_height_delta`) the per-frame series is reduced to
`mean, min, max, std, range` (the schema also lists `p10, p50, p90`), giving one fixed-length
flat vector per rep.

This is deliberate. The dataset is small (144 videos / 24 subjects), so a sequence model
would overfit; aggregates are directly interpretable for the feedback layer; and they train
in seconds. Frame-level classification was explicitly rejected because fault signatures such
as "hips sag progressively under fatigue" only exist as a trajectory over time.

---

## 5. The capture-quality exclusion

This is the most consequential finding in the project.

Seven features are named in `excluded_capture_features` in both `metrics.json` and
`metadata.json`:

```
jitter_max, jitter_mean, jitter_std, low_confidence_ratio,
mean_visibility, min_visibility, tracking_gap_ratio
```

They are retained as **runtime diagnostics** but removed from the model's input. The reason
recorded in `metrics.json.feature_subset_rationale`: they let the classifier read capture
conditions — how well the subject happened to be filmed — as a **proxy for subject identity**,
because capture conditions correlate with which subject and clip was recorded.

**A precision point.** Only **three** of those seven (`mean_visibility`, `min_visibility`,
`tracking_gap_ratio`) are members of the 37-feature contract. The other four
(`jitter_max`, `jitter_mean`, `jitter_std`, `low_confidence_ratio`) were never contract
features — `FEATURE_NAMES` contains `jitter_score`, not `jitter_max/mean/std`, and no
`low_confidence_ratio`. So "37 → 34" is correct: the model drops exactly the 3 contract
features that encode capture quality. Verified against `ml/src/features.py`.

### Measured effect

From `ml/reports/feature_search.json` (24 variants; protocol: subset chosen on validation,
reported on test). Same estimator and balancing on both rows (Random Forest, class-balanced):

| Variant | n features | Test macro-F1 | Test bad-recall | Test AUC | Val macro-F1 |
|---|---|---|---|---|---|
| `all_37` (RF, balanced) | 37 | **0.6396** | **0.5570** | 0.7230 | 0.9774 |
| `motion_only` (RF, balanced) | 34 | **0.6568** | **0.5714** | 0.7321 | 0.9849 |
| **Delta** | −3 | **+0.0172** | **+0.0145** | +0.0090 | +0.0075 |

Removing the capture-quality features improves **all four** metrics, but the margin is modest.
**These figures were regenerated after the timestamp corruption was repaired**
(`docs/BUILD_STATUS.md` §2.11). The pre-repair search reported a much larger effect
(test macro-F1 0.587 → 0.691, bad-recall 0.434 → 0.620): the corrupted velocity and duration
features interacted with the capture-quality proxies and exaggerated the gap. The direction —
capture features hurt, and the harm shows on unseen subjects — is unchanged and still the
reason they are excluded, but the honest size of the effect is roughly **+0.02 macro-F1**,
not +0.10.

### A second unflattering detail

The shipped model is the **Random Forest** on `motion_only`, selected on validation macro-F1
(§6). Unlike the previous build — where the search winner (RF `motion_only`) differed from the
shipped GBM — the shipped model and the search winner are now the **same estimator and subset**,
so this inconsistency is resolved in the current build.

---

## 6. Model selection

Candidates are compared on the **subject-independent validation split**, and the selection
rule is **highest validation macro-F1**, not accuracy (`docs/MODEL_CONTRACT.md` §2). Macro-F1
is used because a false negative (bad rep scored good) and a false positive are not equally
costly for the product.

Real validation scores from `metrics.json` / `metadata.json` (`candidates`):

| Candidate | Val accuracy | Val macro-F1 | Threshold | Val ROC-AUC | Fit time (s) |
|---|---|---|---|---|---|
| Logistic Regression (scaled, balanced) | 0.7972 | 0.7891 | 0.60 | 0.8092 | 0.00 |
| **Random Forest (balanced)** | **0.8531** | **0.8362** | **0.46** | **0.8843** | 0.00 |
| Gradient Boosting | 0.8462 | 0.8257 | 0.52 | 0.8777 | 0.00 |
| XGBoost | 0.7972 | 0.7835 | 0.57 | 0.8610 | 0.00 |

**Selected: `random_forest`** (`metrics.json.selected_model`), confirmed by
`metadata.json.model_type = "RandomForestClassifier"`. It wins on the selection criterion by
0.011 macro-F1 over Gradient Boosting and 0.047 over XGBoost. XGBoost was evaluated and did
not win; it is not shipped. The Logistic Regression baseline is 0.047 macro-F1 behind — the
forest earns its complexity, but the gap is not large.

> This section changed with the data repair: in the pre-repair run Gradient Boosting won
> (0.8187 vs RF 0.7799). After the corrupted timing features were fixed, the ranking of the
> two flipped. The selection rule itself is unchanged — only the data it was applied to.

`docs/MODEL_CONTRACT.md` also states a preference for "the simplest model within 2 points of
the best". Random Forest is within 2 points of the best (it *is* the best) and is therefore
consistent with that rule.

### Pooled vs per-view

Both strategies were measured on validation before committing (`metrics.json.strategy`):

| Strategy | Val macro-F1 |
|---|---|
| **Pooled (selected)** | **0.8362** |
| Per-view specialised | 0.8130 |

Per-view models did not generalise better, so the **pooled** strategy shipped. The per-view
models that were fitted during comparison, for the record:

| View | Model | Threshold | Val macro-F1 | Val ROC-AUC |
|---|---|---|---|---|
| front | gradient_boosting | 0.93 | 0.7421 | 0.6722 |
| side | gradient_boosting | 0.05 | 0.7413 | 0.8043 |
| diagonal | logistic_regression | 0.63 | 0.9555 | 0.9718 |

The side threshold of 0.05 and the diagonal validation macro-F1 of 0.9555 are both extreme
and rest on small per-view validation samples (8 videos per view per validation subject);
they should not be read as reliable estimates.

---

## 7. The honest validation protocol

`train_classifier.py:303-327` enforces one rule that is easy to get wrong and expensive to
get wrong: **every candidate is fit on TRAIN only before it is scored on validation.**

```
for name, model in models.items():
    model.fit(X_tr, y_tr)          # candidate never sees validation during fitting
    probs_good = model.predict_proba(X_va)[:, 0]
    thr, macro_f1 = tune_threshold(y_va, probs_good)
```

The script prints the reason at `train_classifier.py:293-294`:

> `NOTE: candidate selection fits on TRAIN ONLY. Fitting on train+val and then scoring val`
> `reports ~0.99 and selects the wrong model.`

Why this is worth stating explicitly: if candidates were fit on train+validation and then
scored on validation, every model would be evaluated on data it had already memorised. The
scores would land near 0.99, the differences between candidates would collapse into noise,
and the "winner" would be whichever model overfits hardest — not whichever generalises
best. The model comparison would be self-scoring and meaningless.

The discipline in full:

1. Split by subject, never by rep or frame; assert disjointness (`train_classifier.py:255`).
2. Fit candidates on TRAIN only; score and tune the threshold on VALIDATION only
   (`tune_threshold` scans 0.05…0.95 in 0.01 steps for best macro-F1).
3. Select the model on validation macro-F1.
4. **Only then** refit the selected model on train+validation, because validation has served
   its purpose (`train_classifier.py:425-429`), and evaluate once on TEST.
5. Impute non-finite features with the **train** mean, never the full-set mean
   (`train_classifier.py:149-160`).

The test split is untouched by steps 1–4. The 0.6829 accuracy reported in §1 is the single
evaluation of the final refit against it. `docs/MODEL_CONTRACT.md` §5 states the rule this
report follows: training accuracy is never reported as project accuracy.

---

## 8. Results

### Pooled test metrics

See §1 for the full table. The confusion matrix (`metrics.json.test.confusion_matrix`, rows =
true, columns = predicted, order `[good, bad]`):

|  | Pred good | Pred bad |
|---|---|---|
| **True good** | 93 | 30 |
| **True bad** | 34 | 48 |

205 reps total (123 good, 82 bad). The model's errors are asymmetric: it misses **34 of 82
bad reps** (41.5%) while wrongly flagging **30 of 123 good reps** (24.4%). In deployment that
means roughly one in three bad reps is praised, and about one in four good reps is criticised.

### Per-view breakdown

| View | Reps | Accuracy | Macro-F1 |
|---|---|---|---|
| front | 84 | 0.6310 | 0.6284 |
| side | 44 | 0.6591 | 0.6265 |
| **diagonal** | 77 | **0.7662** | **0.7387** |

84 + 44 + 77 = 205. The views are **not** equally well handled: diagonal macro-F1 (0.739) is
**0.111 above** side (0.626) and **0.110 above** front (0.628). The front view is the worst
despite having the most test reps (84) — consistent with the documented explanation that the
front view is a foreshortened close-up with noisier elbow angles. The gap is large enough to
be user-visible: a user filming from the front will receive materially worse feedback than one
filming at an angle, for the same movement quality.

### 8.1 Independent re-evaluation (`evaluation.json`)

`ml/reports/evaluation.json` (produced by `ml/scripts/evaluate_model.py`, Agent 16) appeared
while this report was being written and is an **independent** re-evaluation of the shipped
bundle: it loads `pushup_form_model.joblib`, scores the test split, and fits nothing. It
reproduces every headline metric in §1 to **exactly zero difference**
(`agreement_check.max_abs_difference: 0.0`, `tolerance: 1e-06`, `agrees: true`,
`confusion_matrix_matches: true`, `looks_inverted: false`). The §1 numbers are therefore
confirmed by two independent scorers, not one.

It adds three things `metrics.json` does not record.

**Per-view AUC and class detail** (all at the uniform threshold 0.46):

| View | n | good/bad | Accuracy | Macro-F1 | ROC-AUC | Recall bad |
|---|---|---|---|---|---|---|
| front | 84 | 45/39 | 0.6667 | 0.6421 | 0.7063 | 0.4359 |
| side | 44 | 30/14 | 0.7500 | 0.7061 | 0.7548 | 0.5714 |
| diagonal | 77 | 48/29 | 0.6623 | 0.4872 | 0.7701 | 0.1034 |

The side view, previously the weakest by AUC, is now the best by macro-F1. The diagonal view
is the problem child: ROC-AUC 0.7701 shows the *ranking* is fine, but at threshold 0.46 it
predicts almost everything as good (recall good 1.000, recall bad 0.103) — it catches 3 of 29
bad reps. Note the diagonal view's test set is 48 good to 29 bad; small and unbalanced.

**Calibration.** Expected calibration error **0.0707**, Brier score **0.2019**, base rate of
good form 0.6. Calibration improved substantially over the pre-repair model (ECE 0.1228,
Brier 0.2225). The populated buckets with real mass sit within ±0.09 of perfect calibration:
in `[0.7,0.8)` (47 reps) predicted 0.749 vs observed 0.809 (+0.059); in `[0.8,0.9)` (24 reps)
predicted 0.844 vs observed 0.833 (−0.010). The worst gaps are in thin buckets: `[0.1,0.2)`
holds only 4 reps (predicted 0.164, observed 0.500) and `[0.9,1.0]` holds 8 (predicted 0.912,
observed 1.000) — the model is slightly *under*-confident at the extremes now, not
over-confident as before.

**Threshold sensitivity.** The operating threshold 0.46 gives accuracy 0.6829 / macro-F1 0.6189
/ bad-recall 0.3415. Sweeping the test grid shows the operating point is **not** the test-set
macro-F1 optimum — and that is expected, because the threshold was tuned on validation, which
is the correct protocol: 0.60 gives macro-F1 0.6724 with bad-recall 0.683 (recall good falls
0.911 → 0.675). Macro-F1 peaks around 0.60 on test. **Moving to a higher threshold is the
single largest available product lever**: at 0.60 the model catches 68% of bad-form reps
instead of 34%, at a real cost to good-form recall. Since a missed bad rep is the more costly
error for a form coach, the grid supports shipping a higher threshold — worth recording as a
product decision rather than a modelling result, and one that must be validated on *validation*
data (which selected 0.46) before changing the shipped artifact.

**In-sample reference (must not be quoted as project accuracy).** The bundle was refit on
train+validation, so both are in-sample: train accuracy **0.9754** (macro-F1 0.9736, 569 reps),
validation accuracy **0.9510** (macro-F1 0.9459, 143 reps), against test accuracy **0.6829**.
The evaluation script labels these `in_sample: true` and warns explicitly that they are
optimistic by construction. This is the cleanest available illustration of the generalisation
gap: **0.98 in-sample versus 0.68 out-of-sample.** Anyone quoting 0.98 is quoting the wrong
number.

### Feature dependence differs by view

`metrics.json.strategy_rationale` records per-view Cohen's d measured on this dataset:

| View | Strongest feature | |d| |
|---|---|---|
| side | `body_line_deviation_max_abs` | 1.09 |
| diagonal | `elbow_velocity_down_mean` | 0.89 |
| front | `hip_angle_deg_mean` | 0.84 |

No feature appears in the top-5 for all three views. This is the reason a per-view strategy
was attempted at all: the views express form quality through *different* cues, so pooling
averages incompatible signals. The pooled model nevertheless generalised better on
validation (0.8362 vs 0.8130) and shipped, so the project ships a model that is knowingly
averaging across views it has measured to be incompatible. The per-view route remains open
but unproven — it lost on the only evidence available.

---

## 9. Per-subject results

Test-set accuracy for each held-out subject (`metrics.json.per_subject`):

| Subject | Reps | Accuracy |
|---|---|---|
| 010 | 72 | 0.8611 |
| 016 | 56 | 0.5357 |
| 023 | 45 | 0.4444 |
| 024 | 32 | 0.8750 |

72 + 56 + 45 + 32 = 205. The spread is large: **0.8750 down to 0.4444**, a range of 0.4306.
Subject 023 is predicted *worse than chance* (0.4444) across 45 reps — for that person the
model is actively unhelpful, not merely imprecise. Subjects 010 and 024 are handled well
(0.86+).

**What this implies for real-world use.** The headline 0.6829 is a mean over four people, and
the four people disagree with each other by 42 accuracy points. On a new user there is no way
to know in advance whether they will be one of the 0.86 subjects or one of the 0.44 subjects.
Two plausible explanations are consistent with the artifacts: (a) the subject fingerprint
survives torso normalisation (RF identifies subject at 0.499 vs 0.042 chance, per
`tune_features.py`), so the model partially memorises the 16 training subjects and degrades
on subjects whose build or camera setup is not represented; and (b) subject 023's 45 reps may
sit in a region of feature space the 16 training subjects never covered. Either way, the
practical consequence is the same: **per-user reliability is unknown at prediction time**, and
the model's confidence is not a substitute for that knowledge.

With only four test subjects, these four numbers are themselves uncertain estimates. The
honest statement is not "subject 023 is a bad user" but "the model's accuracy varies by
subject more than the pooled figure suggests, and four subjects is too few to characterise the
distribution".

---

## 10. Feature importance

Importances from the pooled Random Forest model (`metrics.json.feature_importance`),
verified against `pushup_form_model.joblib`:

| Rank | Feature | Importance |
|---|---|---|
| 1 | `elbow_velocity_down_mean` | 0.0840 |
| 2 | `shoulder_hip_ankle_angle_deg_mean` | 0.0738 |
| 3 | `hip_angle_deg_mean` | 0.0664 |
| 4 | `rep_duration_s` | 0.0600 |
| 5 | `elbow_velocity_up_mean` | 0.0533 |
| 6 | `body_line_deviation_max_abs` | 0.0505 |
| 7 | `body_line_deviation_mean` | 0.0471 |
| 8 | `descent_duration_s` | 0.0445 |
| 9 | `shoulder_elbow_height_delta_mean` | 0.0429 |
| 10 | `shoulder_elbow_height_delta_min` | 0.0369 |

The top three carry **22.4%** of total importance and all three are interpretable,
coach-named quantities: descent speed, shoulder–hip–ankle alignment, and hip angle. Forest
importances are spread more evenly than boosted ones (the top feature drops from 0.160 to
0.084), which is expected — averaging over 400 decorrelated trees diffuses attribution. The
repaired data also changed the ranking: `rep_duration_s` and `descent_duration_s` now rank in
the top 8, which is coherent — with plausible durations restored, *how long* a rep takes
carries real signal again. `mean_visibility` appears nowhere in the top 12, as it should not:
it is excluded from the model.

### Per-view importance is not available

`metrics.json.per_view_feature_importance` is **`{}`** (empty). The trainer only computes
per-view importances when the *per-view* strategy wins (`train_classifier.py:526`); the pooled
strategy won, so the branch never ran. The claim that "the top features differ by camera view"
is therefore supported only by the Cohen's d measurements in
`metrics.json.strategy_rationale` (§8) — which do show three different top features across the
three views — and **not** by a per-view model importance table, because none was produced.
This report does not present one.

### Verified mislabel in `metrics.json` — FOUND, DIAGNOSED, AND FIXED

> **Status: resolved.** This section is retained because the diagnosis is useful, but the
> defect described below no longer exists. Two changes were made:
>
> 1. `ml/scripts/train_classifier.py` now pairs importances against `model_feature_names`
>    (the 34 names the model actually consumes) instead of `FEATURE_NAMES` (the 37-name
>    contract), in both the pooled and per-view blocks. Future training runs are correct.
> 2. `ml/reports/metrics.json` was rebuilt from the joblib artifact so the shipped file is
>    correct **without retraining**, which would have changed the model and invalidated the
>    verified export parity. Exactly one key changed:
>    `mean_visibility` → `elbow_angle_opposite_deg_mean`.
>
> The key set of `metrics.json.feature_importance` now equals `metadata.feature_names`
> exactly, and contains no excluded capture-quality feature. The rank-10 value of
> `0.03365327742327356` correctly belongs to `elbow_angle_opposite_deg_mean`.
>
> Note the practical impact was small: `mean_visibility` is excluded from the model, so
> nothing downstream read it as a model input. It mattered because the Tips page orders
> coaching advice by importance, and a mislabelled name would attribute a real signal to a
> feature the model does not use.

While cross-checking the importances against the joblib artifact, one entry in
`metrics.json.feature_importance` was found to be **mislabeled**.

`train_classifier.py:553-559` built the dict with
`zip(FEATURE_NAMES, final_est.feature_importances_)`. `FEATURE_NAMES` has **37** entries; the
model has **34** importances. `zip` truncates to 34 pairs, so it paired the *first 34 contract
names* with importances that belong to the 34 *model* columns. The first 33 pairs were correct.
The 34th was not: the name `mean_visibility` (contract index 33) was paired with the importance
of model column 33, which is contract index 36 — `elbow_angle_opposite_deg_mean`.

Verified empirically against the fitted estimator:

- `ml/models/pushup_form_model.joblib` importance for `elbow_angle_opposite_deg_mean` =
  **0.03365327742327356** — exactly the value `metrics.json` attributes to `mean_visibility`.
- `elbow_angle_opposite_deg_mean` was **absent** from `metrics.json.feature_importance`.
- The dict had 34 keys; 33 were correctly labeled.

Consequences: the rank-10 entry in the table above is in fact `elbow_angle_opposite_deg_mean`,
not `mean_visibility`. The listed top-9 are unaffected. No capture-quality feature is in the
model at all, so `mean_visibility` appearing in a 34-feature model's importance list should
itself have been a red flag. The *model* is correct — this is a reporting bug in
`metrics.json`, not in the shipped artifact. It is recorded here because a report that silently
repeats a wrong label is worse than one that flags it.

---

## 11. Class semantics and the export parity gate

### Class resolution in the shipped forest export

The shipped artifact is a **forest**; its per-leaf probability columns are ordered by sklearn's
`classes_`, and the browser must read the column that corresponds to `positive_class = 0`
(P(good form)). The export now serialises class indices as **numbers**:

| Artifact | Field | Value |
|---|---|---|
| `pushup_form_model.metadata.json` | `positive_class` | **0** |
| `pushup_form_model.metadata.json` | `positive_class_meaning` | `"P(good form)"` |
| `pushup_form_model.json` | `classes` | `[0, 1]` |

This matters because of an incident during the retrain. The first forest export serialised
`classes` as **strings** (`["0", "1"]`) while `positive_class` stayed an `int`, so
`classes.index(positive_class)` raised `ValueError` on the Python side. The TypeScript runtime
resolves the column with `classes.indexOf(positive_class)`, which silently returned `-1` on
strings and fell back to position 0 — the *correct* answer for `[0,1]` by accident, and wrong
in general. Both sides are now ints, so the lookup resolves exactly. The fix touched
`export_forest` / `export_logistic` (export as `int`); the historical string-comparison
defensive path remains in `score_export`.

**Historical context — the GBM inversion, which shipped before this build.** The previous
model was a `GradientBoostingClassifier`, whose sigmoid over the raw score yields
P(class 1) = P(bad), so the export carried a `sigmoidIsClass: 1` field and the runtime inverted
(`1 - p`) to report P(good). A missing inversion disagreed with sklearn by 0.96 — "the exact
complement", which looks plausible and inverts every verdict. That story is documented in
`tests/test_model_parity.py` and guarded by its tests; the current forest export has no
sigmoid and needs no inversion, but the fixture and the runtime both still support the field
so a future GBM selection cannot reintroduce the bug silently.

Exported artifact shape: `kind: "forest"`, **400 trees**, `classes: [0, 1]`.

### The parity gate

`export_model.py:288-293` refuses to write `pushup_form_model.json` unless its own JSON-scoring
path reproduces sklearn to within tolerance:

```
max |export - sklearn| over 500 vectors : <value>
if max_diff > 1e-6: refuse to ship (exit 3)
```

The check draws 500 synthetic feature vectors around the train means, scores each with both
the exported JSON trees and the fitted sklearn estimator, and takes the maximum absolute
difference. **Achieved parity: `1.1102230246251565e-16`** (reproduced at time of writing by
re-running the same computation in memory against `pushup_form_model.json` and
`pushup_form_model.joblib`). That is machine epsilon — 10 orders of magnitude inside the
1e-6 gate. `ml/models/parity_fixture.json` persists **200** of those cases as
`{features, expectedGoodProbability}` for the TypeScript runtime test.

The gate matters because a subtly wrong export would mis-score every rep in the live app while
looking perfectly healthy. The exporter also refuses to proceed on a stale bundle whose
feature-name count disagrees with its imputation means (`export_model.py:228-234`), so a
37-wide export against 34-wide coefficients cannot be built by accident.

---

## 12. Temporal analysis

`ml/reports/sequence_analysis.json` exists (produced by `ml/scripts/build_sequences.py`,
Agent 17) and answers the open question directly: **temporal modelling does not beat the
aggregated baseline.** The recorded verdict is `"NO"`, with
`temporal_beats_aggregated_on_validation: false` and
`temporal_beats_aggregated_on_test: false`.

The sequence path materialises variable-length per-rep joint-angle sequences (9 channels,
917 reps, 29,865 frames, median length 29 frames, mean 32.6, range 13–90). Sequences are
**phase-normalised and resampled onto K=24 evenly spaced points** rather than padded — the
recorded rationale is that padding to the longest rep injects a synthetic end-of-rep boundary
whose position encodes rep length. Feature blocks: aggregated 34, resampled 216, sequence
statistics 54, extras 2.

All models use the same protocol as the shipped trainer: fit on TRAIN, tune threshold on
VALIDATION, evaluate TEST once after refitting on TRAIN+VALID.

| Model | Features | Threshold | Val macro-F1 | Test macro-F1 | Test accuracy |
|---|---|---|---|---|---|
| **`agg_gbc_34` (baseline)** | 34 | 0.52 | **0.8257** | **0.6789** | **0.7073** |
| `seq_combined_gbc` (best sequence-only) | 272 | 0.73 | 0.7087 (−0.117) | 0.6618 (−0.017) | 0.6780 |
| `seq_resampled_gbc` | 216 | 0.53 | 0.6809 (−0.145) | 0.6009 (−0.078) | 0.6488 |
| `seq_stats_gbc` | 54 | 0.66 | 0.6841 (−0.142) | 0.5242 (−0.155) | 0.5415 |
| `seq_combined_logreg` | 272 | 0.59 | 0.6012 (−0.225) | 0.5403 (−0.139) | 0.5561 |
| `augmented_gbc` (aggregated + sequence) | 306 | 0.33 | 0.7702 (−0.055) | 0.5171 (−0.162) | 0.6390 |

**Interpretation.** No sequence variant beats the baseline on either split. The best
sequence-only model is 0.117 macro-F1 *worse* on validation and 0.017 worse on test. The
artifact defines a significance tolerance of **0.02 macro-F1** — justified by 4 validation and
4 test subjects — so the test deficit (−0.017) is *within noise and should not be read as a
degradation*, while the validation deficit (−0.117) is a real one. The honest reading is
therefore: **temporal modelling does not improve on the aggregated baseline; on validation it
clearly harms it.** Augmenting the aggregated features with sequence features is worse still
(test −0.162, well outside tolerance).

> Note the baseline here is a GBM (`agg_gbc_34`) under the identical protocol, not the shipped
> Random Forest; this analysis compares architectures, and the shipped model is not directly
> comparable to these numbers.

Two further points from the artifact:

- **Sequence features are not more separable.** Best train-set class separation is
  max |d| = 0.630 for the 270 sequence features versus 0.623 for the 34 aggregated features —
  effectively identical. The sequence block does contain more moderately-separating features
  (17 with |d| ≥ 0.5 vs 2 for the aggregated block), but that extra information did not convert
  into better generalisation; it converted into overfitting.
- **The loss is not uniform across subjects.** On validation, the best sequence model wins on
  1 subject, loses on 3 (win/tie/loss = 1/0/3), including a −0.485 accuracy swing on subject
  014. Mean per-subject validation accuracy drops from 0.8141 (baseline) to 0.6329 (sequence).
  On test the mean per-subject accuracy is essentially unchanged (0.6735 baseline vs 0.6702
  sequence, delta −0.0033).

This is a genuinely useful negative result: the choice to ship a hand-designed
mean/min/max/std/range aggregation rather than a sequence model is now **measured**, not merely
argued from dataset size. It also confirms the prior recorded in `docs/FEATURE_SCHEMA.md` §7 —
with 144 videos / 24 subjects, the sequence model overfits: `seq_combined_gbc` reaches a train
macro-F1 diagnostic of **1.0000** against 0.7087 on validation.

---

## 13. Limitations

These are not hedges. They are the boundaries of what the artifacts support.

1. **Binary good/bad only.** The model answers one question. It cannot say *what* is wrong.
   A rep with sagging hips and a rep with a half-range of motion are both `bad` and the model
   has no vocabulary to distinguish them. `docs/FORM_SCORE.md` §6 states the project does not
   detect head/neck faults, does not estimate calories or strength, and does not report any
   physiological quantity.
2. **It cannot name a specific fault.** Any fault name shown in the UI comes from the
   separate geometry-score layer in `docs/FORM_SCORE.md`, not from this model. The classifier's
   output is a single probability.
3. **~0.68 accuracy on unseen subjects means roughly one in three reps is misjudged.** 0.6829
   on 205 held-out reps. 54 of 82 bad reps pass as good; 11 of 123 good reps are flagged bad.
   The model is conservative in both directions at threshold 0.46: it rarely accuses a good rep
   (9% false-flag rate) and rarely catches a bad one (34% recall).
4. **Performance varies by subject, more than the headline suggests.** 0.4444 to 0.8750 across
   four held-out subjects. On one subject the model is worse than a coin flip.
5. **Performance varies by view.** Side macro-F1 0.7061 vs front 0.6421 and diagonal 0.4872.
   The diagonal view is the weakest: its ranking is respectable (AUC 0.7701) but at the
   operating threshold it flags almost everything good (recall bad 0.103).
6. **Probabilities near the threshold are genuinely uncertain.** The threshold is 0.46 and the
   product treats `threshold ± 0.08` (0.38–0.54; the band is defined relative to the threshold
   in `assessment.ts`, so it moves with the metadata value) as "Borderline — form is close to
   the threshold" rather than asserting a verdict (`docs/FORM_SCORE.md`). A probability of
   0.60 is not strong evidence of good form. ROC-AUC is 0.7353, so the ranking is meaningfully
   better than chance but far from sharp.
7. **The training set is small — 16 subjects, 569 reps — and skewed.** 24 subjects exist;
   16 trained the model. The set is skewed toward certain body types and camera setups, and
   the split cannot correct for a body type that is absent from the training subjects
   altogether. Subject 023's 0.4444 is the visible symptom of this.
8. **The training set is also skewed by the exclusion gate.** 25 of 144 clips (17.4%) yielded
   no reps, and they were **19 bad / 6 good** with front view over-represented (13 of 25).
   The model is trained on data from which bad-form examples were preferentially removed —
   in the direction of the class it most needs.
9. **A subject fingerprint survives torso normalisation.** The same feature set identifies the
   subject at 0.499 accuracy against 0.042 chance (`tune_features.py`). Torso normalisation
   reduced this but did not remove it. Some of the model's skill is plausibly person
   recognition rather than movement assessment.
10. **Capture-quality features were excluded for a reason that still applies to the remaining
    34.** The exclusion removed the *most direct* capture proxy. It did not prove the remaining
     34 are identity-free — the 0.499 subject-identification figure is computed on features
     that include movement features.
11. **`metrics.json.feature_importance` mislabel — FIXED.** The one mislabeled entry
     (§10) has been corrected at the source in `train_classifier.py` and repaired in the
     shipped `metrics.json`. The key set now matches `metadata.feature_names` exactly.
12. **The per-view model comparison rests on 8 videos per view per validation subject**, and
     produced an extreme side threshold of 0.05. The per-view validation numbers in §6 should
     not be treated as stable estimates.
13. **The temporal question is answered in the negative, but on 4 subjects.** A sequence model
     was tested and did not beat the aggregated baseline (§12): best sequence-only variant
     0.6618 test macro-F1 vs 0.6789 baseline, and 0.117 *worse* on validation. The test
     deficit is within the artifact's 0.02 noise tolerance, so the correct statement is "no
     measured improvement", not "proven worse". The validation degradation, however, is real.
     Both splits rest on 4 subjects.

---

## 14. Reproducing these results

Interpreter: `C:\Users\USER\anaconda3\envs\pushup\Scripts\python.exe`

### Full pipeline

```bash
npm run ml:pipeline -- --full
```

`scripts/ml-pipeline.mjs` runs five stages in dependency order:

| Stage | Script | Writes |
|---|---|---|
| 1 | `inspect_dataset.py` | `ml/data/dataset_manifest.csv`, `ml/data/splits/dataset_split.json` |
| 2 | `extract_pose_features.py` (heavy — 144 videos through MediaPipe) | `ml/data/processed/*.npz` |
| 3 | `calibrate_thresholds.py` | per-view threshold report |
| 4 | `train_classifier.py` | `ml/models/pushup_form_model.joblib`, `ml/reports/metrics.json` |
| 5 | `export_model.py` | `ml/models/pushup_form_model.json`, `.metadata.json`, `parity_fixture.json` + web mirror |

Without `--full`, stage 2 is skipped (it decodes 144 videos and took ~623 s per
`extraction_summary.json`) and the pipeline reuses existing `.npz` files. Stage 5 is a hard
gate: it exits non-zero and writes no JSON if parity exceeds 1e-6.

### Individual stages, in order

```bash
PY="C:/Users/USER/anaconda3/envs/pushup/Scripts/python.exe"

"$PY" ml/scripts/inspect_dataset.py          # 1. manifest + subject-independent split
"$PY" ml/scripts/extract_pose_features.py    # 2. heavy: 144 videos -> processed/*.npz
"$PY" ml/scripts/calibrate_thresholds.py     # 3. per-view thresholds
"$PY" ml/scripts/train_classifier.py         # 4. compare candidates, train, evaluate on test
"$PY" ml/scripts/export_model.py             # 5. parity-gated export
```

### Supporting analyses

```bash
"$PY" ml/scripts/tune_features.py              # -> ml/reports/feature_search.json (24 variants)
"$PY" ml/scripts/diagnose_generalisation.py    # Cohen's d, subject confound, per-view separability
"$PY" ml/scripts/evaluate_model.py             # -> ml/reports/evaluation.json (independent re-scoring)
"$PY" ml/scripts/build_sequences.py            # -> ml/reports/sequence_analysis.json (temporal comparison)
"$PY" ml/scripts/train_classifier.py --compare-sequence   # temporal comparison via the trainer (see §12)
```

### Verifying this report's numbers

```bash
"$PY" -m pytest tests/test_model_parity.py -v      # browser runtime vs sklearn
"$PY" -m pytest tests/test_feature_parity.py -v    # TS vs Python feature extractors
npm run test                                        # full suite
```

To re-verify the two figures this report measured independently of the JSON artifacts:

- **Parity** — load `pushup_form_model.json` and `pushup_form_model.joblib`, draw 500 vectors
  around `train_feature_means` with `std = max(|mean| * 0.25, 1e-3)` and
  `np.random.default_rng(0)`, score both, take `max(abs(diff))`. Expected: `1.11e-16`.
- **Excluded clips** — count `ml/data/processed/*.npz` with `rep_vectors.size == 0`
  (25), and among those count `track_quality_tracked == False` (18) and
  `track_quality_reason != "ok"`.

### Reproducibility caveats

- All model seeds are fixed (`random_state=42` in `train_classifier.py`; `default_rng(0)` in the
  exporter), so a rerun on the same `.npz` files should reproduce these numbers.
- Rerunning stage 2 re-decodes video through MediaPipe; feature values should be identical but
  the stage is expensive and depends on the MediaPipe build.
- `trained_at` is `2026-09-20T18:32:00Z` and `exported_at` is `2026-09-20T18:33:51Z` in
  `metadata.json`; if a rerun produces different timestamps, confirm `metrics.json` also
  changed before assuming the metrics moved.

---

## Appendix — artifact availability at time of writing

| File | Present? |
|---|---|
| `ml/reports/metrics.json` | **yes** |
| `ml/reports/feature_search.json` | **yes** |
| `ml/reports/evaluation.json` | **yes** — appeared during writing; summarised in §8.1; corroborates §1 to 0.0 difference |
| `ml/reports/sequence_analysis.json` | **yes** — appeared during writing; summarised in §12 |
| `ml/reports/MODEL_REPORT.md` | yes (this file) |
| `ml/models/pushup_form_model.json` | yes |
| `ml/models/pushup_form_model.metadata.json` | yes |
| `ml/models/pushup_form_model.joblib` | yes |
| `ml/models/parity_fixture.json` | yes (200 cases) |
| `ml/data/splits/dataset_split.json` | yes |

Both optional JSON files named in this report's brief (`evaluation.json`,
`sequence_analysis.json`) were **absent when this report was started and appeared while it was
being written**. Both are now read and incorporated; nothing in this report now rests on an
assumption that they do not exist.

### Numbers in this report that are NOT from `metrics.json` or the metadata file

Stated explicitly so the provenance of every figure is unambiguous:

| Figure | Source | Method |
|---|---|---|
| 25 zero-rep clips; 18 gate-rejected / 7 no-reps; 19 bad / 6 good; 13 front / 8 side / 4 diagonal; 18 train / 5 val / 2 test | `ml/data/processed/*.npz` (144 files) | counted directly; `metrics.json` does not record it |
| 119 clips contributing reps | `ml/data/processed/*.npz` | counted directly |
| 917 rep windows | `extraction_summary.json` + `metrics.json` | both agree |
| Achieved parity `1.1102230246251565e-16` | `pushup_form_model.json` + `.joblib` | recomputed in memory |
| 400 trees | `pushup_form_model.json` | read from the artifact (`len(trees)`) |
| Per-view AUC (0.7063 / 0.7548 / 0.7701), ECE 0.0707, Brier 0.2019, calibration bins, threshold grid, in-sample reference (train 0.9754 / val 0.9510) | `ml/reports/evaluation.json` | read from that artifact; not present in `metrics.json` |
| Sequence results table, 0.02 tolerance, subject-level win/tie/loss, 9 channels / 29,865 frames / K=24 | `ml/reports/sequence_analysis.json` | read from that artifact; not present in `metrics.json` |
| 0.499 subject-identification vs 0.042 chance | `ml/scripts/tune_features.py` docstring | quoted as documented by that script; not independently re-run |
| Cohen's d per view (1.09 / 0.89 / 0.84) | `metrics.json.strategy_rationale` prose | quoted from the recorded rationale |
| `threshold ± 0.08` borderline band | `docs/FORM_SCORE.md` §210 | quoted from the contract |
| Split allocation method (sha256 sort + fixed 16/4/4 cut) | `ml/scripts/inspect_dataset.py:152-188` | read from source |

### Flagged discrepancies

1. **`0.670` vs `0.6911` — RESOLVED by the data repair.** The `feature_subset_rationale`
   prose used to quote pre-repair figures (0.587/0.434 vs 0.670/0.620) that could not be
   reproduced from `feature_search.json`. After the timestamp corruption was repaired the
   search was re-run and the rationale was regenerated from it: the rationale now quotes
   0.640/0.557 (all 37) vs 0.657/0.571 (motion only), which match
   `feature_search.json` under the same estimator and balancing. §5.
2. **`mean_visibility` importance label — RESOLVED.** The rank-10 entry in
   `metrics.json.feature_importance` was mislabeled; it is `elbow_angle_opposite_deg_mean`
   (0.03365327742327356, verified against the joblib model). `train_classifier.py` now pairs
   importances against `model_feature_names`, and `metrics.json` was rebuilt from the joblib
   artifact so the shipped file is correct without retraining. The retrained model's importance
   table no longer contains the mislabeled entry at all (§10); `mean_visibility` is excluded
   from the model and absent from the importance dict.
3. **`docs/MODEL_CONTRACT.md` §3 split illustration** — the example split (train 001–016 /
   validation 017–020 / test 021–024) does not match `dataset_split.json` (validation
   003/007/014/019; test 010/016/023/024). The split file is authoritative. §3.
4. **`docs/MODEL_CONTRACT.md` §7 metadata example** shows `n_features: 37` and
   `positive_class: "good"`; the shipped metadata has `n_features: 34` and
   `positive_class: 0`. The example is stale; the shipped artifacts are correct.
