"""
scripts/evaluate_model.py

Agent 16 - ML EVALUATION ENGINEER

Standalone, reproducible evaluation of the SHIPPED form classifier.

Why this file exists
--------------------
The project must report honest held-out metrics with a per-view breakdown, and
must never present training accuracy as project accuracy. This script is the
independent evaluator that proves the numbers: it loads the exported model
bundle and scores it on the TEST subjects only, so anyone can re-run it and get
the same table the report quotes.

What it does NOT do
-------------------
  * it does not fit, refit, tune or select anything
  * it does not touch the training split except to impute with the means the
    bundle already carries (computed on TRAIN by train_classifier.impute)
  * it does not recompute the decision threshold

Class semantics (the trap this script guards against)
-----------------------------------------------------
The label convention is 0 = good, 1 = bad, and `positive_class` is 0: the
runtime reports P(good form). sklearn's binary GradientBoostingClassifier fits
its trees to class index 1, so its raw sigmoid returns P(class 1) -- i.e.
P(bad). export_model.py records this as `sigmoidIsClass` and inverts it; a
hand-rolled scorer that forgets to invert reports ~1 - accuracy and looks
plausible. We therefore score through `predict_proba` (which resolves class
indices itself) and then VERIFY against ml/reports/metrics.json, printing a
loud warning if the numbers do not agree or if they look inverted.

Run:
    python ml/scripts/evaluate_model.py
Writes:
    ml/reports/evaluation.json
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np

SCRIPT_DIR = Path(__file__).resolve().parent
ML_DIR = SCRIPT_DIR.parent
for _p in (str(ML_DIR), str(SCRIPT_DIR)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from src.features import FEATURE_NAMES, N_FEATURES, FEATURE_SPEC_VERSION  # noqa: E402

# Reuse the trainer's loading logic and conventions instead of inventing new
# ones: load_dataset(), the subject-independent split source, VIEWS, the
# capture-quality exclusion and its rationale all live there.
import train_classifier as trainer  # noqa: E402

MODELS_DIR = ML_DIR / "models"
REPORTS_DIR = ML_DIR / "reports"
JOBLIB_PATH = MODELS_DIR / "pushup_form_model.joblib"
METADATA_PATH = MODELS_DIR / "pushup_form_model.metadata.json"
RECORDED_METRICS_PATH = REPORTS_DIR / "metrics.json"
OUT_PATH = REPORTS_DIR / "evaluation.json"

VIEWS = trainer.VIEWS

GOOD, BAD = 0, 1
AGREEMENT_TOL = 1e-6


# --------------------------------------------------------------------------
# Scoring helpers
# --------------------------------------------------------------------------


def positive_class_probability(estimator, X: np.ndarray, positive_class: int = GOOD) -> np.ndarray:
    """
    P(positive_class) from a fitted estimator, resolving the class index itself.

    Never index predict_proba[:, 1] by hand here: for this model that column is
    P(bad), and swapping it silently inverts every metric in the report.
    """
    classes = list(getattr(estimator, "classes_", []))
    if positive_class not in classes:
        raise SystemExit(
            f"positive_class {positive_class} not in estimator.classes_={classes}"
        )
    return np.asarray(estimator.predict_proba(X)[:, classes.index(positive_class)], dtype=float)


def fill_with_means(X: np.ndarray, means: np.ndarray) -> np.ndarray:
    """
    Mean-fill non-finite features, matching train_classifier.impute().

    The fill values come from the bundle (`train_feature_means`, fitted on TRAIN
    only). Recomputing a mean over the test set here would leak test information
    into the evaluation and quietly inflate the numbers.
    """
    means = np.asarray(means, dtype=float)
    means = np.where(np.isfinite(means), means, 0.0)
    out = np.asarray(X, dtype=float).copy()
    idx = np.where(~np.isfinite(out))
    if idx[0].size:
        out[idx] = np.take(means, idx[1])
    return out


def metrics_for(y_true: np.ndarray, probs_good: np.ndarray, pred: np.ndarray) -> dict:
    """Accuracy / per-class precision-recall-F1 / macro-F1 / ROC-AUC / confusion."""
    from sklearn.metrics import (
        accuracy_score,
        confusion_matrix,
        f1_score,
        precision_recall_fscore_support,
        roc_auc_score,
    )

    acc = float(accuracy_score(y_true, pred))
    prec, rec, f1, _ = precision_recall_fscore_support(
        y_true, pred, labels=[GOOD, BAD], average=None, zero_division=0
    )
    macro_f1 = float(f1_score(y_true, pred, average="macro", zero_division=0))
    cm = confusion_matrix(y_true, pred, labels=[GOOD, BAD]).tolist()
    try:
        # Same orientation as train_classifier: positive label = 1 means "good".
        auc = float(roc_auc_score((y_true == GOOD).astype(int), probs_good))
    except ValueError:
        auc = float("nan")  # a group with a single class has no ROC curve

    return {
        "n_samples": int(len(y_true)),
        "n_good": int((y_true == GOOD).sum()),
        "n_bad": int((y_true == BAD).sum()),
        "accuracy": acc,
        "macro_f1": macro_f1,
        "roc_auc": auc,
        "precision_good": float(prec[0]),
        "recall_good": float(rec[0]),
        "f1_good": float(f1[0]),
        "precision_bad": float(prec[1]),
        "recall_bad": float(rec[1]),
        "f1_bad": float(f1[1]),
        "confusion_matrix": cm,
    }


def calibration_table(probs_good: np.ndarray, y_true: np.ndarray, n_bins: int = 10) -> dict:
    """
    Bucket predictions by predicted P(good) and compare with what actually happened.

    The UI shows the user a probability, so "0.70 good" has to mean roughly 70%
    good. A single AUC cannot tell you that; this table can.
    """
    edges = np.linspace(0.0, 1.0, n_bins + 1)
    bins: list[dict] = []
    ece = 0.0
    n = max(len(probs_good), 1)

    for i in range(n_bins):
        lo, hi = float(edges[i]), float(edges[i + 1])
        # last bin is closed on the right so p == 1.0 is counted
        m = (probs_good >= lo) & (probs_good <= hi if i == n_bins - 1 else probs_good < hi)
        count = int(m.sum())
        if count == 0:
            bins.append(
                {
                    "bin": f"[{lo:.1f},{hi:.1f}{']' if i == n_bins - 1 else ')'}",
                    "lo": lo,
                    "hi": hi,
                    "n_samples": 0,
                    "mean_predicted_good": None,
                    "observed_good_rate": None,
                    "gap": None,
                }
            )
            continue
        mean_pred = float(np.mean(probs_good[m]))
        observed = float(np.mean(y_true[m] == GOOD))
        gap = observed - mean_pred
        ece += (count / n) * abs(gap)
        bins.append(
            {
                "bin": f"[{lo:.1f},{hi:.1f}{']' if i == n_bins - 1 else ')'}",
                "lo": lo,
                "hi": hi,
                "n_samples": count,
                "mean_predicted_good": mean_pred,
                "observed_good_rate": observed,
                "gap": float(gap),
            }
        )

    brier = float(np.mean((probs_good - (y_true == GOOD).astype(float)) ** 2))
    return {
        "n_bins": n_bins,
        "bins": bins,
        "expected_calibration_error": float(ece),
        "brier_score": brier,
        "base_rate_good": float(np.mean(y_true == GOOD)),
    }


def threshold_sensitivity(
    probs_good: np.ndarray, y_true: np.ndarray, operating: float
) -> dict:
    """
    Move the decision threshold around the operating point and show the trade-off.

    The threshold was chosen on validation for macro-F1. Raising it makes the
    model say "bad" more often: bad-form recall climbs, bad-form precision falls.
    Since a form coach that misses bad form is useless, that trade is the one the
    reader needs to see in order to judge whether 0.58 is defensible.
    """
    from sklearn.metrics import accuracy_score, f1_score, precision_recall_fscore_support

    grid = set(np.round(np.arange(0.30, 0.81, 0.05), 2).tolist())
    grid.add(round(float(operating), 2))
    rows: list[dict] = []

    for t in sorted(grid):
        pred = np.where(probs_good >= t, GOOD, BAD).astype(int)
        prec, rec, f1, _ = precision_recall_fscore_support(
            y_true, pred, labels=[GOOD, BAD], average=None, zero_division=0
        )
        rows.append(
            {
                "threshold": float(t),
                "is_operating_point": bool(abs(t - round(float(operating), 2)) < 1e-9),
                "accuracy": float(accuracy_score(y_true, pred)),
                "macro_f1": float(f1_score(y_true, pred, average="macro", zero_division=0)),
                "precision_good": float(prec[0]),
                "recall_good": float(rec[0]),
                "precision_bad": float(prec[1]),
                "recall_bad": float(rec[1]),
                "f1_bad": float(f1[1]),
                "n_predicted_bad": int((pred == BAD).sum()),
            }
        )

    return {"operating_threshold": float(operating), "grid": rows}


# --------------------------------------------------------------------------
# Agreement check against the recorded metrics
# --------------------------------------------------------------------------


def agreement_check(computed: dict, recorded: dict | None) -> dict:
    """
    Cross-check this evaluator against ml/reports/metrics.json.

    If the two disagree, one of them is wrong and that matters. If they disagree
    by looking like complements of each other, the class semantics have been
    inverted somewhere -- the exact failure this check exists to catch.
    """
    if not recorded:
        return {
            "checked": False,
            "reason": "ml/reports/metrics.json not found or has no 'test' block",
            "agrees": None,
        }

    fields = [
        "accuracy",
        "macro_f1",
        "roc_auc",
        "precision_good",
        "recall_good",
        "f1_good",
        "precision_bad",
        "recall_bad",
        "f1_bad",
    ]
    diffs: dict[str, float] = {}
    for f in fields:
        if f not in recorded:
            continue
        diffs[f] = float(computed[f] - float(recorded[f]))

    cm_match = computed.get("confusion_matrix") == recorded.get("confusion_matrix")
    max_abs = max((abs(v) for v in diffs.values()), default=0.0)
    agrees = bool(max_abs <= AGREEMENT_TOL and cm_match)

    # Inversion test: does the computed value look like 1 - recorded?
    inverted = False
    for f in ("accuracy", "macro_f1", "roc_auc"):
        if f in recorded:
            if abs(computed[f] - (1.0 - float(recorded[f]))) <= 1e-3:
                inverted = True
                break

    return {
        "checked": True,
        "recorded_source": str(RECORDED_METRICS_PATH.relative_to(ML_DIR.parent)),
        "agrees": agrees,
        "max_abs_difference": float(max_abs),
        "tolerance": AGREEMENT_TOL,
        "per_field_difference": diffs,
        "confusion_matrix_matches": cm_match,
        "looks_inverted": inverted,
    }


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------


def main() -> int:
    print("=" * 70)
    print("HELD-OUT EVALUATION - PUSH-UP FORM CLASSIFIER")
    print("=" * 70)

    if not JOBLIB_PATH.exists():
        print(f"Missing {JOBLIB_PATH}. Run ml/scripts/train_classifier.py first.")
        return 1

    import joblib

    bundle = joblib.load(JOBLIB_PATH)
    model = bundle["model"]
    threshold = float(bundle["threshold"])
    strategy = str(bundle.get("strategy", "pooled"))
    per_view_bundle = bundle.get("per_view_models") or None
    names = list(bundle.get("feature_names") or FEATURE_NAMES)
    train_means = np.asarray(
        bundle.get("train_feature_means", np.zeros(len(names))), dtype=float
    )

    # Resolve the model's input columns BY NAME, not by assuming the contract.
    try:
        col_idx = [FEATURE_NAMES.index(n) for n in names]
    except ValueError as exc:
        print(f"  !! bundle feature_names do not match the feature contract: {exc}")
        return 4
    if train_means.size != len(col_idx):
        print(
            f"  !! bundle inconsistency: {len(col_idx)} feature names but "
            f"{train_means.size} imputation means. Retrain first."
        )
        return 4

    metadata: dict = {}
    if METADATA_PATH.exists():
        metadata = json.loads(METADATA_PATH.read_text(encoding="utf-8"))
    positive_class = int(metadata.get("positive_class", GOOD))
    meta_threshold = metadata.get("decision_threshold")
    if meta_threshold is not None and abs(float(meta_threshold) - threshold) > 1e-9:
        print(
            f"  !! threshold mismatch: bundle {threshold} vs metadata {meta_threshold}"
        )

    print(f"  model            : {type(model).__name__}  ({JOBLIB_PATH.name})")
    print(f"  strategy         : {strategy}")
    print(
        f"  feature spec     : v{FEATURE_SPEC_VERSION}, {len(col_idx)} model features "
        f"({N_FEATURES} contract - {len(trainer.CAPTURE_QUALITY_FEATURES)} capture-quality)"
    )
    print(f"  decision thresh  : {threshold:.4f}")
    print(
        f"  class semantics  : score = P(good form) = P(class {positive_class}); "
        f"predicted good when score >= {threshold:.4f}"
    )
    if col_idx != trainer.MOTION_FEATURE_IDX:
        print("  !! note: bundle feature subset differs from train_classifier.MOTION_FEATURE_IDX")
        print(f"     bundle  : {names}")

    # ------------------------------------------------------------------
    # Data + split: same loader and same split file the trainer used.
    # ------------------------------------------------------------------
    print("\nLoading dataset (train_classifier.load_dataset)...")
    X_all, y_all, subjects, views, _sources = trainer.load_dataset()

    split_data = json.loads(trainer.SPLIT_PATH.read_text(encoding="utf-8"))
    train_subjects = set(split_data["splits"]["train"]["subjects"])
    val_subjects = set(split_data["splits"]["validation"]["subjects"])
    test_subjects = set(split_data["splits"]["test"]["subjects"])

    train_mask = np.isin(subjects, list(train_subjects))
    val_mask = np.isin(subjects, list(val_subjects))
    test_mask = np.isin(subjects, list(test_subjects))

    assert not (train_mask & test_mask).any(), "LEAKAGE: subject in train AND test"
    assert not (val_mask & test_mask).any(), "LEAKAGE: subject in val AND test"

    X_model = fill_with_means(X_all[:, col_idx], train_means)

    X_te, y_te = X_model[test_mask], y_all[test_mask]
    views_te, subs_te = views[test_mask], subjects[test_mask]
    if len(X_te) == 0:
        print("ERROR: the test split is empty.")
        return 1

    print(f"\n  split source   : {trainer.SPLIT_PATH.name} ({split_data['strategy']})")
    print(f"  test subjects  : {', '.join(sorted(test_subjects))}")
    print(f"  test reps      : {len(X_te)} (good={int((y_te == GOOD).sum())} "
          f"bad={int((y_te == BAD).sum())})")

    # ------------------------------------------------------------------
    # Score TEST only. Nothing is fitted here.
    # ------------------------------------------------------------------
    if strategy == "per_view" and per_view_bundle:
        # Mirrors train_classifier: route each rep to the model for the view it
        # was captured in, and binarise with that view's own threshold.
        probs_te = np.full(len(X_te), np.nan)
        thr_te = np.full(len(X_te), np.nan)
        for vi, vname in enumerate(VIEWS):
            entry = per_view_bundle.get(vname)
            m = views_te == vi
            if entry is None or m.sum() == 0:
                continue
            probs_te[m] = positive_class_probability(entry["model"], X_te[m], positive_class)
            thr_te[m] = float(entry["threshold"])
        missing = ~np.isfinite(probs_te)
        if missing.any():
            probs_te[missing] = positive_class_probability(
                model, X_te[missing], positive_class
            )
            thr_te[missing] = threshold
    else:
        probs_te = positive_class_probability(model, X_te, positive_class)
        thr_te = np.full(len(X_te), threshold)

    pred_te = np.where(probs_te >= thr_te, GOOD, BAD).astype(int)

    pooled = metrics_for(y_te, probs_te, pred_te)
    pooled["n_subjects"] = int(len(set(subs_te)))
    pooled["threshold_used"] = (
        float(thr_te[0]) if bool(np.allclose(thr_te, thr_te[0])) else None
    )
    pooled["threshold_note"] = (
        f"uniform {thr_te[0]:.4f}" if pooled["threshold_used"] is not None
        else "per-view thresholds (see per_view)"
    )

    # ---------------- per camera view ----------------
    per_view: dict[str, dict | None] = {}
    for vi, vname in enumerate(VIEWS):
        m = views_te == vi
        if m.sum() == 0:
            per_view[vname] = None
            continue
        entry = metrics_for(y_te[m], probs_te[m], pred_te[m])
        entry["n_subjects"] = int(len(set(subs_te[m])))
        entry["threshold_used"] = float(thr_te[m][0])
        per_view[vname] = entry

    # ---------------- per subject ----------------
    per_subject: dict[str, dict] = {}
    for s in sorted(set(subs_te)):
        m = subs_te == s
        entry = metrics_for(y_te[m], probs_te[m], pred_te[m])
        entry["mean_predicted_good"] = float(np.mean(probs_te[m]))
        per_subject[s] = entry

    accs = {s: v["accuracy"] for s, v in per_subject.items()}
    best_subj = max(accs, key=lambda s: accs[s])
    worst_subj = min(accs, key=lambda s: accs[s])
    per_subject_spread = {
        "n_subjects": len(accs),
        "min_accuracy": float(min(accs.values())),
        "max_accuracy": float(max(accs.values())),
        "mean_accuracy": float(np.mean(list(accs.values()))),
        "std_accuracy": float(np.std(list(accs.values()))),
        "range": float(max(accs.values()) - min(accs.values())),
        "best_subject": best_subj,
        "worst_subject": worst_subj,
        "rep_weighted_accuracy": pooled["accuracy"],
    }

    calibration = calibration_table(probs_te, y_te)
    sensitivity = threshold_sensitivity(probs_te, y_te, threshold)

    # ---------------- agreement check ----------------
    recorded = None
    if RECORDED_METRICS_PATH.exists():
        recorded_doc = json.loads(RECORDED_METRICS_PATH.read_text(encoding="utf-8"))
        recorded = recorded_doc.get("test")
    check = agreement_check(pooled, recorded)

    # ---------------- secondary: non-held-out reference ----------------
    # The shipped model was refit on train+validation, so NEITHER of these is a
    # held-out number. They are printed last, labelled, and never the headline.
    reference: dict[str, dict] = {}
    for split_name, mask in (("train", train_mask), ("validation", val_mask)):
        if mask.sum() == 0:
            continue
        Xs, ys = X_model[mask], y_all[mask]
        ps = positive_class_probability(model, Xs, positive_class)
        ds = np.where(ps >= threshold, GOOD, BAD).astype(int)
        reference[split_name] = metrics_for(ys, ps, ds)
        reference[split_name]["in_sample"] = True

    # ------------------------------------------------------------------
    # Console report
    # ------------------------------------------------------------------
    print()
    print("=" * 70)
    print("HEADLINE: TEST SET (subjects the model never saw)")
    print("=" * 70)
    print("  TRAIN accuracy is not project accuracy. These are the numbers to quote.")
    print()
    print(f"  samples            : {pooled['n_samples']} "
          f"(good {pooled['n_good']} / bad {pooled['n_bad']})")
    print(f"  distinct subjects  : {pooled['n_subjects']}")
    print(f"  decision threshold : {pooled['threshold_note']}")
    print(f"  accuracy           : {pooled['accuracy']:.4f}")
    print(f"  macro F1           : {pooled['macro_f1']:.4f}")
    print(f"  ROC AUC            : {pooled['roc_auc']:.4f}")
    print(f"  good  precision={pooled['precision_good']:.3f} "
          f"recall={pooled['recall_good']:.3f} f1={pooled['f1_good']:.3f}")
    print(f"  bad   precision={pooled['precision_bad']:.3f} "
          f"recall={pooled['recall_bad']:.3f} f1={pooled['f1_bad']:.3f}")
    cm = pooled["confusion_matrix"]
    print("  confusion matrix (rows=true, cols=pred) [good, bad]:")
    print(f"    true good  ->  [{cm[0][0]:4d} {cm[0][1]:4d}]")
    print(f"    true bad   ->  [{cm[1][0]:4d} {cm[1][1]:4d}]")

    print()
    print("-" * 70)
    print("PER CAMERA VIEW (same test set, split by capture view)")
    print("-" * 70)
    print(f"  {'view':<10} {'n':>4} {'subj':>4} {'thr':>5} {'acc':>6} {'macroF1':>8} "
          f"{'auc':>6} {'Pbad':>6} {'Rbad':>6}")
    print("  " + "-" * 64)
    for vname in VIEWS:
        e = per_view.get(vname)
        if e is None:
            print(f"  {vname:<10} no test reps")
            continue
        print(f"  {vname:<10} {e['n_samples']:>4} {e['n_subjects']:>4} "
              f"{e['threshold_used']:>5.2f} {e['accuracy']:>6.3f} {e['macro_f1']:>8.3f} "
              f"{e['roc_auc']:>6.3f} {e['precision_bad']:>6.3f} {e['recall_bad']:>6.3f}")

    print()
    print("-" * 70)
    print("PER SUBJECT (worst first - one pooled number hides this spread)")
    print("-" * 70)
    print(f"  {'subject':<9} {'n':>4} {'good':>5} {'bad':>4} {'acc':>6} {'macroF1':>8} "
          f"{'meanPgood':>10}")
    print("  " + "-" * 52)
    for s in sorted(per_subject, key=lambda k: per_subject[k]["accuracy"]):
        e = per_subject[s]
        print(f"  {s:<9} {e['n_samples']:>4} {e['n_good']:>5} {e['n_bad']:>4} "
              f"{e['accuracy']:>6.3f} {e['macro_f1']:>8.3f} "
              f"{e['mean_predicted_good']:>10.3f}")
    sp = per_subject_spread
    print(f"\n  spread: min {sp['min_accuracy']:.3f} ({sp['worst_subject']})  "
          f"max {sp['max_accuracy']:.3f} ({sp['best_subject']})  "
          f"range {sp['range']:.3f}  std {sp['std_accuracy']:.3f}")
    print(f"  rep-weighted (pooled) accuracy: {sp['rep_weighted_accuracy']:.3f}  "
          f"vs unweighted mean over subjects {sp['mean_accuracy']:.3f}")

    print()
    print("-" * 70)
    print("CALIBRATION (does '0.70 good' mean 70% good?)")
    print("-" * 70)
    print(f"  {'bucket':<12} {'n':>4} {'predicted':>10} {'observed':>9} {'gap':>7}")
    print("  " + "-" * 46)
    for b in calibration["bins"]:
        if b["n_samples"] == 0:
            continue
        print(f"  {b['bin']:<12} {b['n_samples']:>4} "
              f"{b['mean_predicted_good']:>10.3f} {b['observed_good_rate']:>9.3f} "
              f"{b['gap']:>+7.3f}")
    print(f"\n  expected calibration error : "
          f"{calibration['expected_calibration_error']:.4f}")
    print(f"  Brier score                : {calibration['brier_score']:.4f}  "
          f"(base rate good {calibration['base_rate_good']:.3f})")

    print()
    print("-" * 70)
    print("THRESHOLD SENSITIVITY (bad-form trade-off around the operating point)")
    print("-" * 70)
    print(f"  {'thr':>5} {'acc':>6} {'macroF1':>8} {'Pbad':>6} {'Rbad':>6} {'F1bad':>6} "
          f"{'nPredBad':>9}")
    print("  " + "-" * 52)
    for row in sensitivity["grid"]:
        mark = "  <-- operating point" if row["is_operating_point"] else ""
        print(f"  {row['threshold']:>5.2f} {row['accuracy']:>6.3f} "
              f"{row['macro_f1']:>8.3f} {row['precision_bad']:>6.3f} "
              f"{row['recall_bad']:>6.3f} {row['f1_bad']:>6.3f} "
              f"{row['n_predicted_bad']:>9d}{mark}")

    print()
    print("=" * 70)
    print("AGREEMENT CHECK vs ml/reports/metrics.json")
    print("=" * 70)
    if not check["checked"]:
        print(f"  not checked: {check['reason']}")
    elif check["agrees"]:
        print(f"  [OK] evaluator reproduces the recorded test metrics "
              f"(max |diff| {check['max_abs_difference']:.3e}, "
              f"confusion matrix {'matches' if check['confusion_matrix_matches'] else 'DIFFERS'}).")
    else:
        print("  " + "!" * 66)
        print("  !! AGREEMENT CHECK FAILED.")
        print(f"  !! max |evaluator - metrics.json| = {check['max_abs_difference']:.3e} "
              f"(tolerance {check['tolerance']:.0e})")
        for f, d in check["per_field_difference"].items():
            flag = "  <-- differs" if abs(d) > check["tolerance"] else ""
            print(f"  !!   {f:<16} diff {d:+.6f}{flag}")
        if not check["confusion_matrix_matches"]:
            print(f"  !!   confusion matrix: computed {pooled['confusion_matrix']} "
                  f"vs recorded {recorded.get('confusion_matrix') if recorded else None}")
        if check["looks_inverted"]:
            print("  !! The computed metrics look like 1 - recorded: the class")
            print("  !! semantics are INVERTED (sigmoidIsClass / positive_class).")
            print("  !! Do not trust either number until that is resolved.")
        print("  " + "!" * 66)

    print()
    print("-" * 70)
    print("FOR REFERENCE ONLY - NOT HELD OUT (never quote these as project accuracy)")
    print("-" * 70)
    for split_name in ("train", "validation"):
        e = reference.get(split_name)
        if e is None:
            continue
        why = (
            "model was FITTED on these subjects"
            if split_name == "train"
            else "these subjects were in the final fit (train+validation refit)"
        )
        print(f"  {split_name:<11} n={e['n_samples']:<4} acc={e['accuracy']:.4f} "
              f"macroF1={e['macro_f1']:.4f}   <-- optimistic: {why}")
    if "train" in reference:
        gap = reference["train"]["accuracy"] - pooled["accuracy"]
        print(f"\n  train-vs-test accuracy gap: {gap:+.4f} "
              "(a gap is expected; a huge one means the model does not transfer).")

    # ------------------------------------------------------------------
    # Persist
    # ------------------------------------------------------------------
    evaluation = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "script": "ml/scripts/evaluate_model.py",
        "author": "Agent 16 - ML EVALUATION ENGINEER",
        "protocol": (
            "Load the shipped bundle from ml/models/pushup_form_model.joblib and "
            "score the TEST split only (subject-independent split from "
            "ml/data/splits/dataset_split.json). Nothing is fitted, tuned or "
            "selected here. NaN imputation uses the bundle's train_feature_means, "
            "which were fitted on TRAIN by train_classifier.impute()."
        ),
        "headline_metrics_are": "test (held-out subjects, never seen in training)",
        "warning": (
            "Training accuracy is NOT project accuracy. The 'reference' block "
            "below is optimistic by construction and must not be quoted as the "
            "project's accuracy."
        ),
        "model": {
            "path": str(JOBLIB_PATH.relative_to(ML_DIR.parent)),
            "type": type(model).__name__,
            "strategy": strategy,
            "decision_threshold": threshold,
            "positive_class": positive_class,
            "positive_class_meaning": "P(good form)",
            "feature_spec_version": FEATURE_SPEC_VERSION,
            "n_features": len(col_idx),
            "n_features_contract": N_FEATURES,
            "feature_names": names,
            "excluded_capture_features": sorted(trainer.CAPTURE_QUALITY_FEATURES),
            "class_semantics_note": (
                "Labels: 0=good, 1=bad. positive_class=0, so a score is P(good). "
                "sklearn's binary GradientBoostingClassifier fits its trees to "
                "class index 1, so its raw sigmoid is P(bad) -- export_model.py "
                "records that as sigmoidIsClass and inverts it. This evaluator "
                "scores through predict_proba and resolves the class index by "
                "name, then verifies against ml/reports/metrics.json."
            ),
        },
        "dataset": {
            "split_source": str(trainer.SPLIT_PATH.relative_to(ML_DIR.parent)),
            "split_strategy": split_data["strategy"],
            "total_reps": int(len(X_all)),
            "train_reps": int(train_mask.sum()),
            "validation_reps": int(val_mask.sum()),
            "test_reps": int(test_mask.sum()),
            "test_subjects": sorted(test_subjects),
        },
        "pooled_test": pooled,
        "per_view_test": per_view,
        "per_subject_test": per_subject,
        "per_subject_spread": per_subject_spread,
        "calibration": calibration,
        "threshold_sensitivity": sensitivity,
        "agreement_check": {
            **check,
            "recorded_test": recorded,
        },
        "reference": {
            "note": (
                "Optimistic by construction: the shipped model was refit on "
                "train+validation, so both splits are in-sample. Shown only to "
                "make the generalisation gap visible. Never the headline."
            ),
            "splits": reference,
        },
    }

    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(evaluation, indent=2), encoding="utf-8")

    print()
    print("=" * 70)
    print(f"  report -> {OUT_PATH}")
    print()
    print("  Reminder: the headline numbers above are TEST-set numbers on unseen")
    print("  subjects. Do not quote training accuracy as project accuracy.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
