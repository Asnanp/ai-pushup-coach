# MODEL_CONTRACT.md

## 1. Task

Binary classification of a **completed push-up repetition**:
- `good` — textbook form
- `bad` — form fault present

The unit of prediction is **one rep**, not one frame. Frame-level classification is
explicitly rejected: fault signatures such as "hips sag progressively under fatigue"
are only visible as a trajectory over time.

## 2. Model Selection

Candidates compared on the person-independent validation split:

| Model | Role |
|---|---|
| Logistic Regression | baseline; establishes a floor |
| Random Forest | robust to unscaled features, handles small n |
| Gradient Boosting (`sklearn`) | strong tabular performer |
| XGBoost | comparison; used if it wins clearly |

Selection rule: **highest macro-F1 on the validation split**, not accuracy — the test
set is balanced 50/50 by construction, but validation realism still matters.

The simplest model within 2 points of the best is preferred. A school project shipping
an explainable Random Forest beats an opaque ensemble for the same score.

## 3. Training Discipline — NON-NEGOTIABLE

**Subject-independent splitting.** The same person must never appear in two splits.

Measured dataset: 24 unique subjects (`subject_001` … `subject_024`), each contributing
6 clips (good/bad × front/side/diagonal) = 144 videos.

```
TRAIN      16 subjects  (≈66.7%)   subject_001 … subject_016
VALIDATION  4 subjects  (≈16.7%)   subject_017 … subject_020
TEST        4 subjects  (≈16.7%)   subject_021 … subject_024
```

Subjects are assigned by hashing the subject ID so the split is reproducible and not
tuned by hand. `ml/data/splits/dataset_split.json` is the authoritative record.

Additional rules:
- **No frame-level random split.** Frames from one clip are highly correlated; splitting
  them across train/test leaks the scene and inflates accuracy dramatically.
- **All 6 clips of a subject stay together**, in whichever split that subject landed.
- **Class balance within each split**: each subject contributes equally to both classes,
  so every split is naturally ~50/50 good/bad.

## 4. Imbalance & Thresholding

Splits are balanced, so no resampling is applied. The decision threshold is **tuned on
validation** rather than fixed at 0.5: we scan 0.05…0.95 and pick the threshold
maximising macro-F1. The chosen threshold ships in `metadata.json`.

Interpretation: a false negative (a bad rep scored as good) is worse for the user than
a false positive — it encourages poor form. The threshold is therefore biased slightly
toward predicting `bad` when uncertain.

## 5. Reported Metrics

Computed on the **held-out TEST split only**:

- Accuracy, Precision, Recall, F1 (per class and macro)
- Confusion matrix
- ROC-AUC
- Per-camera-view breakdown (front / side / diagonal)
- Per-subject breakdown (to expose a single hard subject dominating the error)

**Training accuracy is never reported as project accuracy.** `MODEL_REPORT.md` states
explicitly which split every number comes from.

## 6. Two Artifacts From One Estimator

`export_model.py` emits both, from the same fitted object:

**`models/pushup_form_model.joblib`** — Python, via joblib. Served by `apps/api`.

**`models/pushup_form_model.json`** — browser. The JSON export depends on model type:

| Model | JSON export strategy |
|---|---|
| Logistic Regression | export `coef_` / `intercept_`; score with a dot product |
| Random Forest | export each tree's `children_left/right`, `feature`, `threshold`, `value`; score by traversal |
| Gradient Boosting | export `init` + per-stage tree arrays |

The JSON export is implemented and **verified by a parity test**: for 500 random feature
vectors drawn from the test set, the JS scoring path and the sklearn path must agree
within `1e-6`. If parity fails, the export is wrong and the browser would silently
mis-score — so this test is a build gate.

## 7. `metadata.json` Schema

```json
{
  "model_type": "RandomForestClassifier",
  "feature_spec_version": 1,
  "feature_names": ["elbow_angle_deg_mean", "..."],
  "n_features": 37,
  "decision_threshold": 0.47,
  "positive_class": "good",
  "trained_at": "2026-09-20T18:00:00Z",
  "training_split": { "n_subjects": 16, "subjects": ["001", "..."] },
  "validation_split": { "n_subjects": 4, "subjects": ["017", "..."] },
  "test_split": { "n_subjects": 4, "subjects": ["021", "..."] },
  "metrics": {
    "validation": { "accuracy": 0.0, "macro_f1": 0.0 },
    "test": { "accuracy": 0.0, "precision": 0.0, "recall": 0.0, "f1": 0.0, "roc_auc": 0.0 }
  },
  "feature_stats": {
    "mean": ["..."],
    "std": ["..."]
  }
}
```

`feature_stats` carries the **train-split** mean and std of every feature. The browser
uses them only for the geometry-vs-model comparison view, never for scoring.

## 8. Runtime Guardrails

At load time the client verifies:
1. `feature_spec_version` matches `FEATURE_SPEC_VERSION` → else refuse to load.
2. `n_features` matches the length of the produced vector → else refuse.
3. All inputs are finite; non-finite values trigger imputation with the train mean and
   increment a `missing_feature_count`. If > 3 features were imputed, the rep's form
   label is reported as `unknown` rather than guessed.

Guardrail 3 is what keeps the system honest: it degrades to "I don't know" instead of
emitting a confident wrong verdict.
