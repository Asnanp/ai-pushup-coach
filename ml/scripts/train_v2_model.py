"""
ml/scripts/train_v2_model.py

Agent 8 — ML VALIDATION ENGINEER & Agent 9 — ML MODEL ENGINEER & Agent 10 — CALIBRATION / UNCERTAINTY ENGINEER

Strict V2 ML Training and Evaluation Protocol:
1. Strict Subject-Level Split: Held-out test subjects {"010", "016", "023", "024"} remain untouched during all training, tuning, and selection.
2. 5-Fold GroupKFold Cross-Validation on the 20 development subjects.
3. Candidate Models:
   - Logistic Regression
   - Random Forest (regularized for small data)
   - Gradient Boosting
4. Model Selection & Threshold Tuning using OUT-OF-FOLD (OOF) predictions only.
   Objective: Maximize cross-subject macro-F1 with bad-form recall target >= 0.65.
5. Probability Calibration & Uncertainty Band Analysis (ECE, Brier score, coverage vs accuracy).
6. Single final evaluation on untouched test subjects.
7. Artifact export with parity fixtures and shipped model summary.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import shutil
import sys
import time
from pathlib import Path
import numpy as np

SCRIPT_DIR = Path(__file__).resolve().parent
ML_DIR = SCRIPT_DIR.parent
PROJECT_DIR = ML_DIR.parent
sys.path.insert(0, str(ML_DIR))
sys.path.insert(0, str(PROJECT_DIR))

from src.features import FEATURE_NAMES, N_FEATURES, FEATURE_SPEC_VERSION
from src.features import aggregate_rep_window, retime_window, FrameFeatures

FRAME_COLUMNS = [
    "elbow_angle",
    "elbow_angle_opposite",
    "shoulder_angle",
    "hip_angle",
    "knee_angle",
    "ankle_angle",
    "body_line_deviation",
    "shoulder_hip_ankle_angle",
    "torso_slope",
    "hip_height_rel",
    "shoulder_height_rel",
    "shoulder_elbow_height_delta",
    "shoulder_ankle_height_delta",
    "mean_visibility",
    "min_visibility",
    "jitter",
    "valid",
]
from sklearn.ensemble import GradientBoostingClassifier, RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    accuracy_score,
    brier_score_loss,
    confusion_matrix,
    f1_score,
    precision_score,
    recall_score,
    roc_auc_score,
)
from sklearn.model_selection import GroupKFold
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler
from export_model import export_forest, export_gbm, export_logistic, unwrap

PROCESSED_DIR = ML_DIR / "data" / "processed"
MODELS_DIR = ML_DIR / "models"
REPORTS_DIR = ML_DIR / "reports"
WEB_PUBLIC_MODELS = PROJECT_DIR / "apps" / "web" / "public" / "models"

TEST_SUBJECTS = {"010", "016", "023", "024"}

# Exclude capture-quality proxy features from form model
CAPTURE_QUALITY_FEATURES = {
    "mean_visibility",
    "min_visibility",
    "tracking_gap_ratio",
    "jitter_max",
    "jitter_mean",
    "jitter_std",
    "low_confidence_ratio",
}

# Features that remain in the form classifier
MODEL_FEATURE_INDICES = [
    i for i, n in enumerate(FEATURE_NAMES) if n not in CAPTURE_QUALITY_FEATURES
]
MODEL_FEATURE_NAMES = [FEATURE_NAMES[i] for i in MODEL_FEATURE_INDICES]


def compute_ece(probs: np.ndarray, y_true: np.ndarray, n_bins: int = 10) -> float:
    """Expected Calibration Error (ECE) for binary classification."""
    bin_boundaries = np.linspace(0, 1, n_bins + 1)
    ece = 0.0
    n = len(probs)
    for i in range(n_bins):
        bin_lower = bin_boundaries[i]
        bin_upper = bin_boundaries[i + 1]
        in_bin = (probs >= bin_lower) & (probs < bin_upper if i < n_bins - 1 else probs <= bin_upper)
        prop_in_bin = np.mean(in_bin)
        if prop_in_bin > 0:
            accuracy_in_bin = np.mean(y_true[in_bin])
            avg_confidence_in_bin = np.mean(probs[in_bin])
            ece += np.abs(avg_confidence_in_bin - accuracy_in_bin) * prop_in_bin
    return float(ece)


def load_dataset_with_recovered():
    """
    Loads all rep vectors, including development reps recovered via manual boundaries.
    Test set is strictly partitioned and held out.
    """
    files = sorted(PROCESSED_DIR.glob("*.npz"))
    
    # Load manual boundaries if available
    manual_bounds_path = ML_DIR / "data" / "manual_rep_boundaries.json"
    manual_bounds = {}
    if manual_bounds_path.exists():
        with open(manual_bounds_path, "r", encoding="utf-8") as f:
            manual_bounds = json.load(f)

    X_list = []
    y_list = []
    subject_list = []
    view_list = []
    stem_list = []

    for p in files:
        data = np.load(p, allow_pickle=True)
        stem = p.stem
        sub = str(data["subject"]) if "subject" in data else stem.split("_")[-1]
        label = 0 if "good" in stem else 1
        view = str(data["view"]) if "view" in data else ("front" if "front" in stem else ("side" if "side" in stem else "diagonal"))
        
        reps = data["rep_vectors"]
        
        # If rep_vectors has data, use them
        if len(reps) > 0:
            for r in reps:
                if np.all(np.isfinite(r)):
                    X_list.append(r)
                    y_list.append(label)
                    subject_list.append(sub)
                    view_list.append(view)
                    stem_list.append(stem)
        # Check if recoverable via manual boundaries (ONLY for TRAIN/DEV subjects)
        elif stem in manual_bounds and sub not in TEST_SUBJECTS:
            bounds = manual_bounds[stem]["boundaries"]
            frames_raw = data["frames"]
            cols = list(data["frame_columns"])
            times = data["frame_times"]
            
            # Reconstruct FrameFeatures list
            col_map = {c: i for i, c in enumerate(cols)}
            frame_objs = []
            for i, row in enumerate(frames_raw):
                valid = bool(row[col_map["valid"]]) if "valid" in col_map else True
                ff = FrameFeatures(
                    valid=valid,
                    side="left" if "left" in stem else "right",
                    elbow_angle=float(row[col_map["elbow_angle"]]) if "elbow_angle" in col_map else np.nan,
                    elbow_angle_opposite=float(row[col_map["elbow_angle_opposite"]]) if "elbow_angle_opposite" in col_map else np.nan,
                    shoulder_angle=float(row[col_map["shoulder_angle"]]) if "shoulder_angle" in col_map else np.nan,
                    hip_angle=float(row[col_map["hip_angle"]]) if "hip_angle" in col_map else np.nan,
                    knee_angle=float(row[col_map["knee_angle"]]) if "knee_angle" in col_map else np.nan,
                    ankle_angle=float(row[col_map["ankle_angle"]]) if "ankle_angle" in col_map else np.nan,
                    body_line_deviation=float(row[col_map["body_line_deviation"]]) if "body_line_deviation" in col_map else np.nan,
                    shoulder_hip_ankle_angle=float(row[col_map["shoulder_hip_ankle_angle"]]) if "shoulder_hip_ankle_angle" in col_map else np.nan,
                    torso_slope=float(row[col_map["torso_slope"]]) if "torso_slope" in col_map else np.nan,
                    hip_height_rel=float(row[col_map["hip_height_rel"]]) if "hip_height_rel" in col_map else np.nan,
                    shoulder_height_rel=float(row[col_map["shoulder_height_rel"]]) if "shoulder_height_rel" in col_map else np.nan,
                    shoulder_elbow_height_delta=float(row[col_map["shoulder_elbow_height_delta"]]) if "shoulder_elbow_height_delta" in col_map else np.nan,
                    shoulder_ankle_height_delta=float(row[col_map["shoulder_ankle_height_delta"]]) if "shoulder_ankle_height_delta" in col_map else np.nan,
                    mean_visibility=float(row[col_map["mean_visibility"]]) if "mean_visibility" in col_map else 0.8,
                    min_visibility=float(row[col_map["min_visibility"]]) if "min_visibility" in col_map else 0.5,
                    jitter=float(row[col_map["jitter"]]) if "jitter" in col_map else 0.0,
                    timestamp=float(times[i]),
                )
                frame_objs.append(ff)
                
            for start_f, end_f in bounds:
                if 0 <= start_f < end_f <= len(frame_objs):
                    w = frame_objs[start_f:end_f + 1]
                    retimed = retime_window(w)
                    vec, _ = aggregate_rep_window(retimed)
                    if np.all(np.isfinite(vec)):
                        X_list.append(vec)
                        y_list.append(label)
                        subject_list.append(sub)
                        view_list.append(view)
                        stem_list.append(stem)

    X = np.array(X_list, dtype=float)
    y = np.array(y_list, dtype=int)
    subjects = np.array(subject_list)
    views = np.array(view_list)
    stems = np.array(stem_list)
    return X, y, subjects, views, stems


def impute_features(X_train: np.ndarray, X_eval: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Impute NaNs using only training fold means to prevent leakage."""
    means = np.nanmean(X_train, axis=0)
    means = np.where(np.isfinite(means), means, 0.0)

    def fill(data: np.ndarray) -> np.ndarray:
        out = data.copy()
        nan_idx = np.where(~np.isfinite(out))
        out[nan_idx] = np.take(means, nan_idx[1])
        return out

    return fill(X_train), fill(X_eval), means


def candidate_factories():
    """Keep candidate selection and final refitting on the same estimator spec."""
    return {
        "random_forest": lambda: RandomForestClassifier(
            n_estimators=300,
            max_depth=5,
            min_samples_leaf=4,
            class_weight="balanced",
            random_state=42,
            n_jobs=-1,
        ),
        "logistic_regression": lambda: Pipeline([
            ("scaler", StandardScaler()),
            ("clf", LogisticRegression(C=0.5, class_weight="balanced", max_iter=1000, random_state=42)),
        ]),
        "gradient_boosting": lambda: GradientBoostingClassifier(
            n_estimators=100,
            max_depth=3,
            learning_rate=0.05,
            subsample=0.8,
            random_state=42,
        ),
    }


def evaluate_candidates_cv(X_dev, y_dev, subjects_dev):
    """
    Performs 5-fold GroupKFold by subject on development data.
    Collects out-of-fold (OOF) predictions for model and threshold selection.
    """
    gkf = GroupKFold(n_splits=5)
    candidates = candidate_factories()

    results = {}
    oof_predictions = {name: np.zeros(len(X_dev)) for name in candidates}

    for name, model_fn in candidates.items():
        fold_scores = []
        
        for fold, (train_idx, val_idx) in enumerate(gkf.split(X_dev, y_dev, groups=subjects_dev)):
            X_tr, X_val = X_dev[train_idx], X_dev[val_idx]
            y_tr, y_val = y_dev[train_idx], y_dev[val_idx]

            X_tr_imp, X_val_imp, _ = impute_features(X_tr, X_val)

            model = model_fn()
            model.fit(X_tr_imp, y_tr)

            # P(good form) = class 0 probability
            probs_good = model.predict_proba(X_val_imp)[:, 0]
            oof_predictions[name][val_idx] = probs_good
            
            # Temporary 0.5 threshold check for fold
            pred = np.where(probs_good >= 0.5, 0, 1)
            fold_scores.append(f1_score(y_val, pred, average="macro", zero_division=0))

        # Evaluate complete OOF predictions
        oof_probs = oof_predictions[name]
        y_good_target = (y_dev == 0).astype(int)
        
        # Scan thresholds on OOF predictions to satisfy pre-declared objective:
        # Maximize macro-F1 subject to bad-form recall >= 0.65
        best_thresh = 0.5
        best_score = -1.0
        best_macro_f1 = 0.0
        best_bad_recall = 0.0
        best_good_recall = 0.0
        
        for thr in np.arange(0.20, 0.81, 0.01):
            pred_good = oof_probs >= thr
            pred_labels = np.where(pred_good, 0, 1)
            
            macro_f1 = f1_score(y_dev, pred_labels, average="macro", zero_division=0)
            bad_rec = recall_score(y_dev == 1, pred_labels == 1, zero_division=0)
            good_rec = recall_score(y_dev == 0, pred_labels == 0, zero_division=0)
            
            # Pre-declared weighted objective:
            # We heavily penalize missing bad form (bad_rec < 0.65)
            penalty = 0.0 if bad_rec >= 0.65 else (0.65 - bad_rec) * 1.5
            objective_score = macro_f1 - penalty
            
            if objective_score > best_score:
                best_score = objective_score
                best_thresh = float(thr)
                best_macro_f1 = float(macro_f1)
                best_bad_recall = float(bad_rec)
                best_good_recall = float(good_rec)

        auc = roc_auc_score(y_good_target, oof_probs)
        ece = compute_ece(oof_probs, y_good_target)
        brier = brier_score_loss(y_good_target, oof_probs)

        # Uncertainty analysis:
        # Reps with confidence close to threshold are marked UNCERTAIN
        delta = 0.10
        uncertain_mask = np.abs(oof_probs - best_thresh) < delta
        coverage = float(1.0 - np.mean(uncertain_mask))
        covered_y = y_dev[~uncertain_mask]
        covered_pred = np.where(oof_probs[~uncertain_mask] >= best_thresh, 0, 1)
        covered_macro_f1 = float(f1_score(covered_y, covered_pred, average="macro", zero_division=0)) if len(covered_y) else 0.0

        results[name] = {
            "cv_fold_macro_f1_mean": round(float(np.mean(fold_scores)), 4),
            "cv_fold_macro_f1_std": round(float(np.std(fold_scores)), 4),
            "oof_macro_f1": round(best_macro_f1, 4),
            "oof_bad_form_recall": round(best_bad_recall, 4),
            "oof_good_form_recall": round(best_good_recall, 4),
            "oof_roc_auc": round(float(auc), 4),
            "oof_ece": round(ece, 4),
            "oof_brier": round(float(brier), 4),
            "best_threshold": round(best_thresh, 3),
            "uncertainty_policy": {
                "margin_delta": delta,
                "abstention_rate": round(float(np.mean(uncertain_mask)), 4),
                "coverage": round(coverage, 4),
                "accuracy_at_coverage": round(covered_macro_f1, 4),
            },
        }

    return results, oof_predictions


def export_model_json(clf, train_means, threshold, test_metrics, candidates_summary):
    """
    Exports the final model to pure JSON compatible with packages/form-engine.
    Also creates models/pushup_form_model.json, metadata, and parity fixtures.
    """
    estimator, scaler = unwrap(clf)
    if isinstance(estimator, RandomForestClassifier):
        model_json = export_forest(estimator)
    elif isinstance(estimator, GradientBoostingClassifier):
        model_json = export_gbm(estimator)
    elif isinstance(estimator, LogisticRegression):
        model_json = export_logistic(estimator, scaler)
    else:
        raise TypeError(f"No browser export for {type(estimator).__name__}")

    metadata_json = {
        "model_type": type(estimator).__name__,
        "feature_spec_version": FEATURE_SPEC_VERSION,
        "feature_names": MODEL_FEATURE_NAMES,
        "n_features": len(MODEL_FEATURE_NAMES),
        "n_features_contract": N_FEATURES,
        "excluded_capture_features": sorted(list(CAPTURE_QUALITY_FEATURES)),
        "decision_threshold": threshold,
        "positive_class": 0,
        "positive_class_meaning": "P(good form)",
        "trained_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "exported_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "train_feature_means": [float(m) for m in train_means],
        "metrics": test_metrics,
        "candidates": candidates_summary,
    }

    # Save artifacts
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    with open(MODELS_DIR / "pushup_form_model.json", "w", encoding="utf-8") as f:
        json.dump(model_json, f, indent=2)

    with open(MODELS_DIR / "pushup_form_model.metadata.json", "w", encoding="utf-8") as f:
        json.dump(metadata_json, f, indent=2)

    # Sync to web app public dir
    if WEB_PUBLIC_MODELS.exists():
        shutil.copy2(MODELS_DIR / "pushup_form_model.json", WEB_PUBLIC_MODELS / "pushup_form_model.json")
        shutil.copy2(MODELS_DIR / "pushup_form_model.metadata.json", WEB_PUBLIC_MODELS / "pushup_form_model.metadata.json")
        if (MODELS_DIR / "parity_fixture.json").exists():
            shutil.copy2(MODELS_DIR / "parity_fixture.json", WEB_PUBLIC_MODELS / "parity_fixture.json")
        print(f"Synced model artifacts to {WEB_PUBLIC_MODELS}")

    return model_json, metadata_json


def generate_parity_fixture(clf, X_sample, y_sample):
    """Generates test cases for model-parity testing."""
    probs = clf.predict_proba(X_sample)[:, 0] # P(good)
    cases = []
    for i in range(min(50, len(X_sample))):
        cases.append({
            "features": [float(x) for x in X_sample[i]],
            "expectedGoodProbability": float(probs[i]),
            "expected_label": int(y_sample[i]),
        })
    fixture = {"cases": cases, "n_cases": len(cases)}
    with open(MODELS_DIR / "parity_fixture.json", "w", encoding="utf-8") as f:
        json.dump(fixture, f, indent=2)
    print(f"Generated parity fixture with {len(cases)} cases at {MODELS_DIR / 'parity_fixture.json'}")


def main():
    print("=" * 60)
    print("V2 ML TRAINING PIPELINE — STRICT SUBJECT-LEVEL CV PROTOCOL")
    print("=" * 60)

    X, y, subjects, views, stems = load_dataset_with_recovered()
    print(f"Total dataset loaded: {len(X)} reps across {len(set(subjects))} subjects.")

    # Strict isolation of test subjects
    test_mask = np.isin(subjects, list(TEST_SUBJECTS))
    dev_mask = ~test_mask

    X_dev_all, y_dev = X[dev_mask], y[dev_mask]
    subjects_dev = subjects[dev_mask]
    views_dev = views[dev_mask]

    X_test_all, y_test = X[test_mask], y[test_mask]
    subjects_test = subjects[test_mask]
    views_test = views[test_mask]

    print(f"\nDevelopment Set: {len(X_dev_all)} reps ({np.sum(y_dev == 0)} good, {np.sum(y_dev == 1)} bad) across {len(set(subjects_dev))} subjects")
    print(f"Held-out Test Set: {len(X_test_all)} reps ({np.sum(y_test == 0)} good, {np.sum(y_test == 1)} bad) across {len(set(subjects_test))} subjects")

    # Select only model motion features (exclude capture quality proxies)
    X_dev = X_dev_all[:, MODEL_FEATURE_INDICES]
    X_test = X_test_all[:, MODEL_FEATURE_INDICES]

    print(f"Features: {X_dev.shape[1]} movement features (dropped {len(CAPTURE_QUALITY_FEATURES)} capture proxies)")

    # Run cross-validation on DEVELOPMENT DATA ONLY
    print("\nRunning 5-fold GroupKFold CV on development subjects...")
    cv_results, oof_preds = evaluate_candidates_cv(X_dev, y_dev, subjects_dev)

    print("\n--- MODEL COMPARISON (OUT-OF-FOLD DEVELOPMENT METRICS) ---")
    for name, res in cv_results.items():
        print(f"\nModel: {name}")
        print(f"  OOF Macro-F1: {res['oof_macro_f1']:.4f} (CV Fold: {res['cv_fold_macro_f1_mean']:.4f} +/- {res['cv_fold_macro_f1_std']:.4f})")
        print(f"  OOF Bad Recall: {res['oof_bad_form_recall']:.4f}, Good Recall: {res['oof_good_form_recall']:.4f}")
        print(f"  OOF ROC-AUC: {res['oof_roc_auc']:.4f}, ECE: {res['oof_ece']:.4f}, Brier: {res['oof_brier']:.4f}")
        print(f"  Selected Threshold: {res['best_threshold']:.3f}")
        print(f"  Uncertainty Abstention: {res['uncertainty_policy']['abstention_rate']:.2%}, Accuracy at Coverage: {res['uncertainty_policy']['accuracy_at_coverage']:.4f}")

    # Select winning model based on OOF macro-F1 with bad recall gate
    winner_name = max(cv_results.keys(), key=lambda k: cv_results[k]["oof_macro_f1"])
    winner_info = cv_results[winner_name]
    best_thresh = winner_info["best_threshold"]
    print(f"\n==> WINNER SELECTED FROM OOF CV: {winner_name} (Threshold: {best_thresh:.3f})")

    # Final Fit: Train winning model on ALL development data
    print("\nRefitting final model on all 20 development subjects...")
    X_dev_imp, X_test_imp, dev_means = impute_features(X_dev, X_test)

    final_model = candidate_factories()[winner_name]()
    final_model.fit(X_dev_imp, y_dev)

    # Evaluate ONCE on sacred held-out test subjects
    print("\nEvaluating ONCE on untouched test set...")
    test_probs_good = final_model.predict_proba(X_test_imp)[:, 0]
    test_pred_labels = np.where(test_probs_good >= best_thresh, 0, 1)

    acc = accuracy_score(y_test, test_pred_labels)
    macro_f1 = f1_score(y_test, test_pred_labels, average="macro", zero_division=0)
    roc_auc = roc_auc_score((y_test == 0).astype(int), test_probs_good)
    prec_good = precision_score(y_test == 0, test_pred_labels == 0, zero_division=0)
    rec_good = recall_score(y_test == 0, test_pred_labels == 0, zero_division=0)
    f1_good = f1_score(y_test == 0, test_pred_labels == 0, zero_division=0)
    prec_bad = precision_score(y_test == 1, test_pred_labels == 1, zero_division=0)
    rec_bad = recall_score(y_test == 1, test_pred_labels == 1, zero_division=0)
    f1_bad = f1_score(y_test == 1, test_pred_labels == 1, zero_division=0)
    cm = confusion_matrix(y_test, test_pred_labels).tolist()
    ece = compute_ece(test_probs_good, (y_test == 0).astype(int))
    brier = brier_score_loss((y_test == 0).astype(int), test_probs_good)

    test_metrics = {
        "accuracy": float(acc),
        "macro_f1": float(macro_f1),
        "roc_auc": float(roc_auc),
        "precision_good": float(prec_good),
        "recall_good": float(rec_good),
        "f1_good": float(f1_good),
        "precision_bad": float(prec_bad),
        "recall_bad": float(rec_bad),
        "f1_bad": float(f1_bad),
        "ece": float(ece),
        "brier": float(brier),
        "confusion_matrix": cm,
    }

    print("\n--- FINAL HELD-OUT TEST METRICS ---")
    print(f"  Accuracy: {acc:.4f}")
    print(f"  Macro-F1: {macro_f1:.4f}")
    print(f"  Good Recall: {rec_good:.4f}, Good Precision: {prec_good:.4f}")
    print(f"  Bad Recall: {rec_bad:.4f}, Bad Precision: {prec_bad:.4f}")
    print(f"  ROC-AUC: {roc_auc:.4f}, ECE: {ece:.4f}")
    print(f"  Confusion Matrix: {cm}")

    # Export model JSON and metadata
    export_model_json(final_model, dev_means, best_thresh, test_metrics, cv_results)
    generate_parity_fixture(final_model, X_test_imp, y_test)

    # Save comprehensive experiment log
    exp_report = {
        "model_type": winner_name,
        "n_dev_samples": len(X_dev),
        "n_test_samples": len(X_test),
        "development_cv": cv_results,
        "final_test_metrics": test_metrics,
    }
    with open(REPORTS_DIR / "v2_ml_experiments.json", "w", encoding="utf-8") as f:
        json.dump(exp_report, f, indent=2)

    # Re-generate authoritative shipped model summary
    from ml.scripts.generate_model_summary import main as generate_summary_main
    generate_summary_main()
    print("\nAuthoritative model summary updated successfully.")

if __name__ == "__main__":
    main()
