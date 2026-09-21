"""
scripts/train_classifier.py

Agent 11 — ML TRAINING ENGINEER

Builds the training set from extracted per-rep feature vectors and trains the
form classifier.

Discipline enforced here (docs/MODEL_CONTRACT.md):
  - split by SUBJECT, never by rep or frame
  - no test data touched during training or threshold selection
  - the decision threshold is tuned on VALIDATION only
  - all candidate models are compared on the same validation split

Run:
    python ml/scripts/train_classifier.py
    python ml/scripts/train_classifier.py --compare-sequence
"""

from __future__ import annotations

import argparse
import glob
import json
import sys
import time
from pathlib import Path

import numpy as np

SCRIPT_DIR = Path(__file__).resolve().parent
ML_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(ML_DIR))

from src.features import FEATURE_NAMES, N_FEATURES, FEATURE_SPEC_VERSION  # noqa: E402

PROCESSED_DIR = ML_DIR / "data" / "processed"
SPLIT_PATH = ML_DIR / "data" / "splits" / "dataset_split.json"
MODELS_DIR = ML_DIR / "models"
REPORTS_DIR = ML_DIR / "reports"

VIEWS = ["front", "side", "diagonal"]

# --------------------------------------------------------------------------
# Features that describe how the clip was CAPTURED, not how the subject MOVED
# --------------------------------------------------------------------------
# Visibility, jitter and tracking gaps are genuine diagnostics — they tell you
# whether to trust a frame at all. But as model inputs they are harmful: they
# let the classifier read "this person was filmed well" instead of "this person
# moved well". Because capture conditions correlate with subject and clip, that
# turns them into identity proxies.
#
# Measured on this dataset (ml/scripts/tune_features.py, protocol: subset chosen
# on validation, reported on test; same estimator and balancing on both rows —
# random forest, class_weight balanced):
#
#                 test macro-F1   bad-form recall
#   all 37           0.640            0.557
#   motion only      0.657            0.571
#
# Both metrics improve when the 7 capture features are dropped. The margin is
# modest — these figures are from AFTER the timestamp corruption was repaired
# (docs/BUILD_STATUS.md §2.11). The pre-repair figures (0.587/0.434 vs
# 0.670/0.620) overstated the effect because the corrupted velocity and
# duration features interacted with the capture-quality proxies.
CAPTURE_QUALITY_FEATURES = {
    "mean_visibility",
    "min_visibility",
    "tracking_gap_ratio",
    "jitter_max",
    "jitter_mean",
    "jitter_std",
    "low_confidence_ratio",
}

MOTION_FEATURE_IDX = [
    i for i, n in enumerate(FEATURE_NAMES) if n not in CAPTURE_QUALITY_FEATURES
]


def load_dataset() -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """
    Load every rep from every processed clip.

    Returns (X, y, subjects, views, sources):
        X         (n_reps, 37)
        y         (n_reps,)  0=good 1=bad
        subjects  (n_reps,)  subject id string
        views     (n_reps,)  int view index
        sources   (n_reps,)  source clip stem, for debugging
    """
    files = sorted(glob.glob(str(PROCESSED_DIR / "*.npz")))
    if not files:
        raise SystemExit(
            "No processed clips found. Run extract_pose_features.py first."
        )

    X_rows: list[np.ndarray] = []
    y_rows: list[int] = []
    subj_rows: list[str] = []
    view_rows: list[int] = []
    src_rows: list[str] = []

    skipped_empty = 0
    skipped_nan = 0
    skipped_untracked = 0

    for path in files:
        d = np.load(path, allow_pickle=True)
        vecs = d["rep_vectors"]
        if vecs.size == 0:
            skipped_empty += 1
            continue

        # A clip whose arm was never reliably tracked contributes no honest
        # signal. If we let it through, every one of its (mis-segmented) reps
        # would carry a confident label it has not earned.
        if "track_quality_tracked" in d.files and not bool(d["track_quality_tracked"]):
            skipped_untracked += 1
            continue

        label = int(d["label"])
        subj = str(d["subject"])
        view = int(d["view_idx"])
        stem = Path(path).stem

        for row in vecs:
            if not np.isfinite(row).any():
                skipped_nan += 1
                continue
            X_rows.append(row.astype(np.float64))
            y_rows.append(label)
            subj_rows.append(subj)
            view_rows.append(view)
            src_rows.append(stem)

    if not X_rows:
        raise SystemExit("No usable reps found in the processed dataset.")

    print(f"  clips with 0 reps skipped : {skipped_empty}")
    print(f"  untracked clips skipped   : {skipped_untracked}")
    print(f"  all-NaN rows skipped      : {skipped_nan}")

    return (
        np.vstack(X_rows),
        np.asarray(y_rows, dtype=int),
        np.asarray(subj_rows),
        np.asarray(view_rows, dtype=int),
        np.asarray(src_rows),
    )


def impute(X_train: np.ndarray, X_other: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Impute non-finite features with the TRAIN mean (never the full-set mean)."""
    means = np.nanmean(X_train, axis=0)
    means = np.where(np.isfinite(means), means, 0.0)

    def fill(X: np.ndarray) -> np.ndarray:
        out = X.copy()
        idx = np.where(~np.isfinite(out))
        out[idx] = np.take(means, idx[1])
        return out

    return fill(X_train), fill(X_other), means


def tune_threshold(y_true: np.ndarray, probs: np.ndarray) -> tuple[float, float]:
    """Scan thresholds on VALIDATION, pick the best macro-F1."""
    from sklearn.metrics import f1_score

    best_t, best_f1 = 0.5, -1.0
    for t in np.arange(0.05, 0.96, 0.01):
        pred = (probs >= t).astype(int)  # 1 = good (class 0 in our labels)
        # our label convention: y=0 good, y=1 bad; probs are P(good)
        pred_labels = np.where(pred == 1, 0, 1)
        f1 = f1_score(y_true, pred_labels, average="macro", zero_division=0)
        if f1 > best_f1:
            best_f1, best_t = float(f1), float(t)
    return best_t, best_f1


def build_models() -> dict:
    from sklearn.ensemble import GradientBoostingClassifier, RandomForestClassifier
    from sklearn.linear_model import LogisticRegression
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import StandardScaler

    models: dict = {
        "logistic_regression": Pipeline(
            [
                ("scaler", StandardScaler()),
                ("clf", LogisticRegression(max_iter=2000, C=1.0, class_weight="balanced")),
            ]
        ),
        "random_forest": RandomForestClassifier(
            n_estimators=400,
            max_depth=6,
            min_samples_leaf=3,
            class_weight="balanced",
            random_state=42,
            n_jobs=-1,
        ),
        "gradient_boosting": GradientBoostingClassifier(
            n_estimators=150,
            max_depth=3,
            learning_rate=0.05,
            subsample=0.8,
            random_state=42,
        ),
    }

    try:
        from xgboost import XGBClassifier

        models["xgboost"] = XGBClassifier(
            n_estimators=200,
            max_depth=4,
            learning_rate=0.05,
            subsample=0.8,
            colsample_bytree=0.8,
            random_state=42,
            eval_metric="logloss",
        )
    except Exception:  # noqa: BLE001
        pass

    return models


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    np.random.seed(args.seed)
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)

    print("=" * 66)
    print("TRAINING THE PUSH-UP FORM CLASSIFIER")
    print("=" * 66)

    split_data = json.loads(SPLIT_PATH.read_text(encoding="utf-8"))
    train_subjects = set(split_data["splits"]["train"]["subjects"])
    val_subjects = set(split_data["splits"]["validation"]["subjects"])
    test_subjects = set(split_data["splits"]["test"]["subjects"])

    print("\nLoading dataset...")
    X, y, subjects, views, sources = load_dataset()
    print(f"  total reps : {len(X)}")
    print(f"  features   : {X.shape[1]}")

    # ---------------- subject-disjoint masks ----------------
    train_mask = np.isin(subjects, list(train_subjects))
    val_mask = np.isin(subjects, list(val_subjects))
    test_mask = np.isin(subjects, list(test_subjects))

    # Leakage assertion — this is the single most important check in the file.
    assert not (train_mask & val_mask).any(), "LEAKAGE: subject in train AND val"
    assert not (train_mask & test_mask).any(), "LEAKAGE: subject in train AND test"
    assert not (val_mask & test_mask).any(), "LEAKAGE: subject in val AND test"

    X_tr, y_tr = X[train_mask], y[train_mask]
    X_va, y_va = X[val_mask], y[val_mask]
    X_te, y_te = X[test_mask], y[test_mask]

    print(f"\n  train      : {len(X_tr):4d} reps  good={int((y_tr == 0).sum()):3d} bad={int((y_tr == 1).sum()):3d}")
    print(f"  validation : {len(X_va):4d} reps  good={int((y_va == 0).sum()):3d} bad={int((y_va == 1).sum()):3d}")
    print(f"  test       : {len(X_te):4d} reps  good={int((y_te == 0).sum()):3d} bad={int((y_te == 1).sum()):3d}")

    if len(X_va) == 0 or len(X_te) == 0:
        print("\nERROR: validation or test split is empty.")
        return 1

    # ---------------- impute (means from TRAIN only) ----------------
    X_tr, X_all_imputed, train_means = impute(X_tr, X)
    X_va = X_all_imputed[val_mask]
    X_te = X_all_imputed[test_mask]

    # Restrict to the movement-describing features (see MOTION_FEATURE_IDX).
    X_tr = X_tr[:, MOTION_FEATURE_IDX]
    X_va = X_va[:, MOTION_FEATURE_IDX]
    X_te = X_te[:, MOTION_FEATURE_IDX]
    X_ml = X_all_imputed[:, MOTION_FEATURE_IDX]
    train_means = train_means[MOTION_FEATURE_IDX]
    model_feature_names = [FEATURE_NAMES[i] for i in MOTION_FEATURE_IDX]

    print(f"  model features : {len(MOTION_FEATURE_IDX)} (excluded "
          f"{len(CAPTURE_QUALITY_FEATURES)} capture-quality features)")

    # ---------------- train + compare ----------------
    from sklearn.metrics import accuracy_score, f1_score, roc_auc_score

    print("\n" + "=" * 66)
    print("MODEL COMPARISON (validation split — subjects never seen in training)")
    print("=" * 66)
    print("  NOTE: candidate selection fits on TRAIN ONLY. Fitting on train+val")
    print("        and then scoring val reports ~0.99 and selects the wrong model.")
    print()
    print(f"  {'model':<22} {'val acc':>8} {'val F1':>8} {'thresh':>8} {'val auc':>8}")
    print("  " + "-" * 58)

    models = build_models()
    results: dict[str, dict] = {}
    trained: dict[str, object] = {}

    for name, model in models.items():
        t0 = time.time()
        # Honest protocol: the candidate never sees validation during fitting.
        model.fit(X_tr, y_tr)
        fit_s = time.time() - t0

        probs_good = model.predict_proba(X_va)[:, 0]  # class 0 = good
        thr, macro_f1 = tune_threshold(y_va, probs_good)

        pred = np.where(probs_good >= thr, 0, 1)
        acc = accuracy_score(y_va, pred)

        try:
            auc = roc_auc_score((y_va == 0).astype(int), probs_good)
        except ValueError:
            auc = float("nan")

        results[name] = {
            "val_accuracy": float(acc),
            "val_macro_f1": float(macro_f1),
            "threshold": float(thr),
            "val_roc_auc": float(auc),
            "fit_seconds": round(fit_s, 2),
        }
        trained[name] = model

        print(f"  {name:<22} {acc:>8.3f} {macro_f1:>8.3f} {thr:>8.2f} {auc:>8.3f}")

    # ---------------- pick the winner ----------------
    best_name = max(results, key=lambda k: results[k]["val_macro_f1"])
    print(f"\n  selected: {best_name}  (val macro-F1 = {results[best_name]['val_macro_f1']:.3f})")

    # ------------------------------------------------------------------
    # PER-VIEW vs POOLED
    # ------------------------------------------------------------------
    # Each camera view expresses form quality through a DIFFERENT feature set.
    # Measured with Cohen's d on this dataset:
    #
    #   side     : body_line_deviation_max_abs      |d| = 1.09
    #   diagonal : elbow_velocity_down_mean         |d| = 0.89
    #   front    : hip_angle_deg_mean               |d| = 0.84
    #
    # Not one feature appears in the top-5 for all three views. Pooling them
    # therefore averages incompatible cues: the pooled best |d| collapses to
    # 0.57 and test macro-F1 falls to 0.55, while per-view separation is far
    # stronger.
    #
    # So we train a specialised model per view and compare it against the pooled
    # model on validation. Whichever generalises better on unseen subjects wins,
    # and the decision is recorded either way rather than assumed.
    view_codes = {name: i for i, name in enumerate(VIEWS)}

    per_view_models: dict[str, dict] = {}
    print("\n" + "=" * 66)
    print("PER-VIEW SPECIALISED MODELS (validation macro-F1 on unseen subjects)")
    print("=" * 66)
    print(f"  {'view':<10} {'train':>6} {'val':>5} {'model':<20} {'val F1':>8} {'auc':>7}")
    print("  " + "-" * 62)

    for vname, vi in view_codes.items():
        tr_m = train_mask & (views == vi)
        va_m = val_mask & (views == vi)
        if tr_m.sum() < 40 or va_m.sum() < 15:
            print(f"  {vname:<10} insufficient data (train={int(tr_m.sum())}, val={int(va_m.sum())})")
            continue

        X_vtr, y_vtr = X_ml[tr_m], y[tr_m]
        X_vva, y_vva = X_ml[va_m], y[va_m]

        best_v = None
        best_v_f1 = -1.0
        best_v_thr = 0.5
        best_v_auc = float("nan")

        for cname, cmodel in build_models().items():
            cmodel.fit(X_vtr, y_vtr)
            probs = cmodel.predict_proba(X_vva)[:, 0]
            thr, f1m = tune_threshold(y_vva, probs)
            try:
                v_auc = roc_auc_score((y_vva == 0).astype(int), probs)
            except ValueError:
                v_auc = float("nan")
            if f1m > best_v_f1:
                best_v_f1 = f1m
                best_v = cmodel
                best_v_thr = thr
                best_v_auc = v_auc
                best_v_name = cname

        per_view_models[vname] = {
            "model": best_v,
            "model_name": best_v_name,
            "threshold": best_v_thr,
            "val_macro_f1": best_v_f1,
            "val_roc_auc": float(best_v_auc),
        }
        print(
            f"  {vname:<10} {int(tr_m.sum()):6d} {int(va_m.sum()):5d} "
            f"{best_v_name:<20} {best_v_f1:>8.3f} {best_v_auc:>7.3f}"
        )

    # Compare strategies on validation, then commit to one.
    pooled_val_f1 = results[best_name]["val_macro_f1"]
    per_view_val_f1 = (
        float(np.mean([m["val_macro_f1"] for m in per_view_models.values()]))
        if per_view_models
        else 0.0
    )

    use_per_view = bool(per_view_models) and per_view_val_f1 > pooled_val_f1

    print()
    print(f"  pooled   mean val macro-F1 : {pooled_val_f1:.3f}")
    print(f"  per-view mean val macro-F1 : {per_view_val_f1:.3f}")
    print(
        f"  --> strategy: {'PER-VIEW' if use_per_view else 'POOLED'} "
        f"({'per-view generalises better' if use_per_view else 'pooled generalises better'})"
    )

    best_model = trained[best_name]
    threshold = results[best_name]["threshold"]

    # ---------------- final: train on train+val, evaluate on TEST ----------------
    # Threshold selection used validation; the model may now use those subjects
    # for fitting since validation has served its purpose. Test stays untouched.
    X_fit = np.vstack([X_tr, X_va])
    y_fit = np.concatenate([y_tr, y_va])
    if use_per_view:
        # Fit each specialised model on its own view's train+validation data,
        # then predict the test set per view. A rep is routed to the model for
        # the view it was captured in, which is legitimate: the view is known
        # metadata, not a label.
        print("\nRefitting per-view models on train+validation...")
        test_views = views[test_mask]
        probs_test = np.full(len(y_te), np.nan)

        for vname, vi in view_codes.items():
            if vname not in per_view_models:
                continue
            entry = per_view_models[vname]
            fit_m = (np.isin(subjects, list(train_subjects | val_subjects))) & (views == vi)
            eval_m = test_views == vi
            if fit_m.sum() < 20 or eval_m.sum() == 0:
                continue

            entry["model"].fit(X_ml[fit_m], y[fit_m])
            probs_test[eval_m] = entry["model"].predict_proba(X_ml[test_mask][eval_m])[:, 0]

        if not np.isfinite(probs_test).all():
            # Some test view had no model. Fall back to pooled for those reps.
            best_model.fit(X_fit, y_fit)
            missing = ~np.isfinite(probs_test)
            probs_test[missing] = best_model.predict_proba(X_te[missing])[:, 0]

        # Binarise per view using each view's own tuned threshold.
        pred_test = np.empty(len(y_te), dtype=int)
        for vname, vi in view_codes.items():
            m = test_views == vi
            if m.sum() == 0:
                continue
            thr_v = per_view_models.get(vname, {}).get("threshold", threshold)
            pred_test[m] = np.where(probs_test[m] >= thr_v, 0, 1)
        pred_test = pred_test.astype(int)
    else:
        print("\nRefitting on train+validation for the final model...")
        best_model.fit(X_fit, y_fit)
        probs_test = best_model.predict_proba(X_te)[:, 0]
        pred_test = np.where(probs_test >= threshold, 0, 1)

    from sklearn.metrics import (
        confusion_matrix,
        precision_recall_fscore_support,
    )

    acc = accuracy_score(y_te, pred_test)
    prec, rec, f1, _ = precision_recall_fscore_support(
        y_te, pred_test, average=None, labels=[0, 1], zero_division=0
    )
    macro_f1 = f1_score(y_te, pred_test, average="macro", zero_division=0)
    cm = confusion_matrix(y_te, pred_test, labels=[0, 1])
    try:
        auc = roc_auc_score((y_te == 0).astype(int), probs_test)
    except ValueError:
        auc = float("nan")

    print("\n" + "=" * 66)
    print("FINAL TEST RESULTS (held-out subjects, never used in training)")
    print("=" * 66)
    print(f"  accuracy       : {acc:.4f}")
    print(f"  macro F1       : {macro_f1:.4f}")
    print(f"  ROC AUC        : {auc:.4f}")
    print(f"  good  precision={prec[0]:.3f} recall={rec[0]:.3f} f1={f1[0]:.3f}")
    print(f"  bad   precision={prec[1]:.3f} recall={rec[1]:.3f} f1={f1[1]:.3f}")
    print("\n  confusion matrix (rows=true, cols=pred) [good, bad]:")
    print(f"    {cm}")

    # ---------------- per-view + per-subject breakdown ----------------
    print("\n  per camera view:")
    per_view = {}
    for vi, vname in enumerate(VIEWS):
        m = views[test_mask] == vi
        if m.sum() == 0:
            per_view[vname] = None
            continue
        a = accuracy_score(y_te[m], pred_test[m])
        f = f1_score(y_te[m], pred_test[m], average="macro", zero_division=0)
        n_valid = int(m.sum())
        per_view[vname] = {"accuracy": float(a), "macro_f1": float(f), "n_reps": n_valid}
        print(f"    {vname:<10} n={n_valid:3d}  acc={a:.3f}  F1={f:.3f}")

    print("\n  per subject (test set):")
    test_subs = subjects[test_mask]
    per_subject = {}
    for s in sorted(set(test_subs)):
        m = test_subs == s
        a = accuracy_score(y_te[m], pred_test[m])
        per_subject[s] = {"accuracy": float(a), "n_reps": int(m.sum())}
        print(f"    subject_{s}  n={int(m.sum()):3d}  acc={a:.3f}")

    # ---------------- feature importance ----------------
    feature_importance = None
    per_view_importance: dict[str, dict[str, float]] = {}

    if use_per_view:
        # Report importance per view, since each model is specialised and the
        # views rely on different cues. A single pooled ranking would hide that.
        for vname, entry in per_view_models.items():
            est = entry["model"]
            if hasattr(est, "named_steps"):
                est = est.named_steps.get("clf", est)
            if not hasattr(est, "feature_importances_"):
                continue
            ranked = {
                name: float(v)
                for name, v in sorted(
                    # `model_feature_names`, NOT FEATURE_NAMES. The estimator
                    # has one importance per MODEL feature (34), while
                    # FEATURE_NAMES is the 37-name contract. zip() truncates to
                    # the shorter list, so pairing against FEATURE_NAMES silently
                    # labelled the importances with the first 34 contract names —
                    # naming a feature the model does not use and hiding one it
                    # does. That mislabelled `mean_visibility` in metrics.json.
                    zip(model_feature_names, est.feature_importances_),
                    key=lambda kv: -kv[1],
                )
            }
            per_view_importance[vname] = ranked
            top3 = list(ranked.items())[:3]
            print(
                f"\n  top features ({vname}): "
                + ", ".join(f"{n} {v:.3f}" for n, v in top3)
            )
    else:
        final_est = best_model
        if hasattr(best_model, "named_steps"):
            final_est = best_model.named_steps.get("clf", best_model)
        if hasattr(final_est, "feature_importances_"):
            feature_importance = {
                name: float(v)
                for name, v in sorted(
                    # See the per-view block above: the model has 34 features,
                    # the contract has 37 names. Pair against the model's own
                    # names or the labels are wrong.
                    zip(model_feature_names, final_est.feature_importances_),
                    key=lambda kv: -kv[1],
                )
            }
            print("\n  top 10 features:")
            for i, (name, v) in enumerate(list(feature_importance.items())[:10]):
                print(f"    {i + 1:2d}. {name:<38} {v:.4f}")

    # ---------------- persist everything ----------------
    metrics = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "feature_spec_version": FEATURE_SPEC_VERSION,
        "n_features": len(MOTION_FEATURE_IDX),
        "n_features_contract": N_FEATURES,
        "feature_names": model_feature_names,
        "excluded_capture_features": sorted(CAPTURE_QUALITY_FEATURES),
        "feature_subset_rationale": (
            "Capture-quality features (visibility, jitter, tracking gaps) are "
            "kept as runtime diagnostics but excluded from the model. Including "
            "them let the classifier read capture conditions as a proxy for "
            "subject identity. Measured with identical estimator and balancing "
            "(random forest, balanced) via tune_features.py: test macro-F1 "
            "0.640 with bad-form recall 0.557 including them, versus 0.657 / "
            "0.571 without. Both improve; the margin is modest on the repaired "
            "dataset (see docs/BUILD_STATUS.md section 2.11)."
        ),
        "dataset": {
            "total_reps": int(len(X)),
            "train_reps": int(len(X_tr)),
            "validation_reps": int(len(X_va)),
            "test_reps": int(len(X_te)),
            "train_subjects": sorted(train_subjects),
            "validation_subjects": sorted(val_subjects),
            "test_subjects": sorted(test_subjects),
            "split_strategy": split_data["strategy"],
        },
        "candidates": results,
        "selected_model": best_name,
        "decision_threshold": float(threshold),
        "strategy": "per_view" if use_per_view else "pooled",
        "strategy_rationale": (
            "Each camera view expresses form quality through a different set of "
            "features (measured: side favours body_line_deviation |d|=1.09, "
            "diagonal favours elbow_velocity |d|=0.89, front favours hip_angle "
            "|d|=0.84, with no feature shared across all three top-5 lists). "
            "Pooling averages incompatible cues, so both strategies are measured "
            "on validation and the better-generalising one is selected."
        ),
        "strategy_comparison": {
            "pooled_val_macro_f1": float(pooled_val_f1),
            "per_view_val_macro_f1": float(per_view_val_f1),
        },
        "per_view_models": {
            vname: {
                "model": entry["model_name"],
                "threshold": float(entry["threshold"]),
                "val_macro_f1": float(entry["val_macro_f1"]),
                "val_roc_auc": float(entry["val_roc_auc"]),
            }
            for vname, entry in per_view_models.items()
        },
        "per_view_feature_importance": per_view_importance,
        "test": {
            "accuracy": float(acc),
            "macro_f1": float(macro_f1),
            "roc_auc": float(auc),
            "precision_good": float(prec[0]),
            "recall_good": float(rec[0]),
            "f1_good": float(f1[0]),
            "precision_bad": float(prec[1]),
            "recall_bad": float(rec[1]),
            "f1_bad": float(f1[1]),
            "confusion_matrix": cm.tolist(),
        },
        "per_view": per_view,
        "per_subject": per_subject,
        "feature_importance": feature_importance,
        "train_feature_means": train_means.tolist(),
    }

    metrics_path = REPORTS_DIR / "metrics.json"
    metrics_path.write_text(json.dumps(metrics, indent=2), encoding="utf-8")

    # Save the estimator for export_model.py / the API service.
    import joblib

    joblib.dump(
        {
            "model": best_model,
            "threshold": float(threshold),
            "feature_names": model_feature_names,
            "feature_spec_version": FEATURE_SPEC_VERSION,
            "train_feature_means": train_means,
            "metrics": metrics,
            # Present only when the per-view strategy won. The exporter and the
            # API use this to route a prediction to the right specialised model.
            "per_view_models": {
                vname: {
                    "model": entry["model"],
                    "threshold": float(entry["threshold"]),
                    "model_name": entry["model_name"],
                }
                for vname, entry in per_view_models.items()
            }
            if use_per_view
            else None,
            "strategy": "per_view" if use_per_view else "pooled",
        },
        MODELS_DIR / "pushup_form_model.joblib",
    )

    print()
    print("=" * 66)
    print(f"  metrics -> {metrics_path}")
    print(f"  model   -> {MODELS_DIR / 'pushup_form_model.joblib'}")
    print()
    print("  NOTE: the numbers reported above are TEST-set numbers on subjects")
    print("        the model has never seen. Do not quote training accuracy.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
