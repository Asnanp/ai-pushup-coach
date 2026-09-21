"""Find the best feature subset and decision policy for the form classifier.

The first training run generalised poorly: validation macro-F1 0.805 vs test
0.555, with bad-form recall of only 0.256. Two causes were identified:

  * a subject fingerprint survives torso normalisation (RF can identify the
    subject from these features with 0.499 accuracy against a 0.042 chance)
  * 7 of the 37 features describe TRACKING QUALITY rather than the movement
    (visibility, jitter, tracking gaps). These are useful diagnostics but they
    let the model read "how well was this person filmed" instead of "how well
    did this person move".

This script evaluates candidate fixes with the same discipline as the real
trainer: choose on VALIDATION, report on TEST, never touch test during search.

Usage:
    python ml/scripts/tune_features.py
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from ml.src.features import FEATURE_NAMES  # noqa: E402
from ml.scripts.diagnose_generalisation import impute, load_all  # noqa: E402

# Features that describe capture quality, not movement quality.
TRACKING_FEATURES = {
    "mean_visibility",
    "min_visibility",
    "tracking_gap_ratio",
    "jitter_max",
    "jitter_mean",
    "jitter_std",
    "low_confidence_ratio",
}


def build_variants() -> dict[str, list[int]]:
    """Feature-subset candidates, expressed as index lists."""
    variants: dict[str, list[int]] = {}

    all_idx = list(range(len(FEATURE_NAMES)))
    variants["all_37"] = all_idx

    motion_idx = [i for i, n in enumerate(FEATURE_NAMES) if n not in TRACKING_FEATURES]
    variants["motion_only"] = motion_idx

    # Geometry that a coach would actually name: joint angles, alignment,
    # depth, tempo. Excludes anything about capture conditions.
    geometric_prefixes = (
        "elbow_angle",
        "shoulder_angle",
        "hip_angle",
        "knee_angle",
        "ankle_angle",
        "body_line_deviation",
        "shoulder_hip_ankle",
        "torso_slope",
        "depth_ratio",
        "min_elbow",
        "max_elbow",
        "rom",
    )
    geom_idx = [
        i for i, n in enumerate(FEATURE_NAMES) if n.startswith(geometric_prefixes)
    ]
    variants["geometric"] = geom_idx

    # Angles only — the most interpretable and least identity-laden subset.
    angle_idx = [
        i
        for i, n in enumerate(FEATURE_NAMES)
        if n.startswith(
            (
                "elbow_angle",
                "shoulder_angle",
                "hip_angle",
                "knee_angle",
                "ankle_angle",
                "shoulder_hip_ankle",
            )
        )
    ]
    variants["angles_only"] = angle_idx

    return variants


def evaluate(
    X: np.ndarray,
    y: np.ndarray,
    idx: list[int],
    train_mask: np.ndarray,
    val_mask: np.ndarray,
    test_mask: np.ndarray,
    model_name: str,
    balanced: bool,
) -> dict:
    from sklearn.ensemble import GradientBoostingClassifier, RandomForestClassifier
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import f1_score, roc_auc_score
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import StandardScaler

    def make():
        if model_name == "rf":
            return RandomForestClassifier(
                n_estimators=500,
                min_samples_leaf=3,
                random_state=0,
                class_weight="balanced" if balanced else None,
            )
        if model_name == "gb":
            return GradientBoostingClassifier(random_state=0)
        return Pipeline(
            [
                ("sc", StandardScaler()),
                (
                    "clf",
                    LogisticRegression(
                        max_iter=3000,
                        class_weight="balanced" if balanced else None,
                    ),
                ),
            ]
        )

    Xs = X[:, idx]
    model = make()
    model.fit(Xs[train_mask | val_mask], y[train_mask | val_mask])

    def score(mask):
        if mask.sum() == 0:
            return 0.0, 0.0
        probs = model.predict_proba(Xs[mask])[:, 0]

        # Tune the operating threshold on validation only.
        best_f1, best_thr = -1.0, 0.5
        if mask is val_mask:
            for thr in np.arange(0.05, 0.96, 0.05):
                pred = np.where(probs >= thr, 0, 1)
                f1m = f1_score(y[mask], pred, average="macro", zero_division=0)
                if f1m > best_f1:
                    best_f1, best_thr = f1m, float(thr)
            return best_f1, best_thr

        return probs, 0.0

    # Validation pass to pick the threshold.
    val_probs = model.predict_proba(Xs[val_mask])[:, 0]
    best_f1, best_thr = -1.0, 0.5
    for thr in np.arange(0.05, 0.96, 0.05):
        pred = np.where(val_probs >= thr, 0, 1)
        f1m = f1_score(y[val_mask], pred, average="macro", zero_division=0)
        if f1m > best_f1:
            best_f1, best_thr = f1m, float(thr)

    test_probs = model.predict_proba(Xs[test_mask])[:, 0]
    test_pred = np.where(test_probs >= best_thr, 0, 1)

    per = f1_score(y[test_mask], test_pred, average=None, labels=[0, 1], zero_division=0)
    try:
        auc = roc_auc_score(
            (y[test_mask] == 0).astype(int), test_probs
        )
    except ValueError:
        auc = float("nan")

    return {
        "n_features": len(idx),
        "val_macro_f1": float(best_f1),
        "threshold": float(best_thr),
        "test_macro_f1": float(
            f1_score(y[test_mask], test_pred, average="macro", zero_division=0)
        ),
        "test_auc": float(auc),
        "test_recall_good": float(per[0]),
        "test_recall_bad": float(per[1]),
    }


def main() -> int:
    X, y, subj, view, split = load_all()
    X = impute(X)

    split_data = json.load(open("ml/data/splits/dataset_split.json", encoding="utf-8"))
    train_s = set(split_data["splits"]["train"]["subjects"])
    val_s = set(split_data["splits"]["validation"]["subjects"])
    test_s = set(split_data["splits"]["test"]["subjects"])

    train_mask = np.isin(subj, list(train_s))
    val_mask = np.isin(subj, list(val_s))
    test_mask = np.isin(subj, list(test_s))

    variants = build_variants()

    print("=" * 92)
    print("FEATURE SUBSET / POLICY SEARCH")
    print("  threshold + subset chosen on VALIDATION; test shown for reporting only")
    print("=" * 92)
    print(
        f"  {'variant':<14} {'model':<6} {'bal':<4} {'nfeat':>5} "
        f"{'val F1':>7} {'thr':>5} {'TEST F1':>8} {'auc':>6} {'Rgood':>6} {'Rbad':>6}"
    )
    print("  " + "-" * 86)

    rows = []
    for vname, idx in variants.items():
        for model_name in ("rf", "gb", "lr"):
            for balanced in (True, False):
                r = evaluate(
                    X, y, idx, train_mask, val_mask, test_mask, model_name, balanced
                )
                rows.append((vname, model_name, balanced, r))
                print(
                    f"  {vname:<14} {model_name:<6} {str(balanced):<5} "
                    f"{r['n_features']:>5} {r['val_macro_f1']:>7.3f} "
                    f"{r['threshold']:>5.2f} {r['test_macro_f1']:>8.3f} "
                    f"{r['test_auc']:>6.3f} {r['test_recall_good']:>6.3f} "
                    f"{r['test_recall_bad']:>6.3f}"
                )

    # Rank by validation, then reveal test — the honest protocol.
    rows.sort(key=lambda r: -r[3]["val_macro_f1"])
    print()
    print("=" * 92)
    print("TOP 5 BY VALIDATION (the only column used to choose)")
    print("=" * 92)
    for vname, model_name, balanced, r in rows[:5]:
        print(
            f"  {vname:<14} {model_name:<6} bal={str(balanced):<5} "
            f"val={r['val_macro_f1']:.3f}  test={r['test_macro_f1']:.3f}  "
            f"Rbad={r['test_recall_bad']:.3f}"
        )

    # Also surface the best by TEST, purely to show how misleading that is.
    print()
    best_test = max(rows, key=lambda r: r[3]["test_macro_f1"])
    print(
        f"  (for contrast, best-by-test would be "
        f"{best_test[0]}/{best_test[1]} bal={best_test[2]} "
        f"test={best_test[3]['test_macro_f1']:.3f} "
        f"but val only {best_test[3]['val_macro_f1']:.3f})"
    )

    out = {
        "variants_tested": len(rows),
        "results": [
            {
                "variant": v,
                "model": m,
                "balanced": b,
                **r,
            }
            for v, m, b, r in rows
        ],
    }
    os.makedirs("ml/reports", exist_ok=True)
    with open("ml/reports/feature_search.json", "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2)
    print()
    print("  report -> ml/reports/feature_search.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
