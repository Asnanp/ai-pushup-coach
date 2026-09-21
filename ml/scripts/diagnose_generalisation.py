"""Diagnose the generalisation gap in the form classifier.

The first training run showed validation macro-F1 0.805 but test macro-F1 0.555
with bad-form recall of only 0.256. That gap is too large to be ordinary
overfitting on 569 training reps, so this script tests the competing
explanations directly rather than guessing:

  1. LABEL NOISE -- are "good" and "bad" clips actually separable in feature
     space, or do they overlap so much that no model could do better?
  2. SUBJECT CONFOUND -- does the model latch onto who the subject is rather
     than how they move? Tested by training with subject identity deliberately
     available vs removed.
  3. VIEW CONFOUND -- front view is a foreshortened close-up with much noisier
     elbow angles. Does training on all views at once hurt?
  4. FEATURE-LEVEL SEPARATION -- per-feature effect size between classes.
     Features that separate cleanly are the ones the model should be using.

Run:
    python ml/scripts/diagnose_generalisation.py
"""
from __future__ import annotations

import glob
import json
import os
import sys
from collections import defaultdict

import numpy as np

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from ml.src.features import FEATURE_NAMES  # noqa: E402

PROCESSED = "ml/data/processed"
SPLIT = "ml/data/splits/dataset_split.json"


def load_all():
    splits = json.load(open(SPLIT, encoding="utf-8"))
    by_subject = {}
    for split_name, payload in splits["splits"].items():
        ids = payload["subjects"] if isinstance(payload, dict) else payload
        for s in ids:
            by_subject[str(s).zfill(3)] = split_name

    X, y, subj, view, split = [], [], [], [], []
    for path in sorted(glob.glob(os.path.join(PROCESSED, "*.npz"))):
        d = np.load(path, allow_pickle=True)
        vecs = d["rep_vectors"]
        if vecs.size == 0:
            continue
        s = str(d["subject"])
        for row in vecs:
            if not np.isfinite(row).any():
                continue
            X.append(row.astype(float))
            y.append(int(d["label"]))
            subj.append(s)
            view.append(str(d["view"]))
            split.append(by_subject.get(s, "unknown"))

    return (
        np.vstack(X),
        np.array(y),
        np.array(subj),
        np.array(view),
        np.array(split),
    )


def impute(X: np.ndarray, X_fit: np.ndarray | None = None) -> np.ndarray:
    """Median-impute NaNs, learning the fill values from X_fit (default X)."""
    X = np.array(X, dtype=float)
    ref = X if X_fit is None else np.array(X_fit, dtype=float)
    med = np.nanmedian(ref, axis=0)
    med = np.where(np.isfinite(med), med, 0.0)
    idx = np.where(~np.isfinite(X))
    if idx[0].size:
        X[idx] = np.take(med, idx[1])
    return X


def cohens_d(a: np.ndarray, b: np.ndarray) -> float:
    """Standardised mean difference. |d| > 0.8 is a large effect."""
    a, b = a[np.isfinite(a)], b[np.isfinite(b)]
    if a.size < 2 or b.size < 2:
        return 0.0
    na, nb = a.size, b.size
    pooled = np.sqrt(
        ((na - 1) * a.var(ddof=1) + (nb - 1) * b.var(ddof=1)) / max(1, na + nb - 2)
    )
    if pooled == 0:
        return 0.0
    return float((a.mean() - b.mean()) / pooled)


def main() -> int:
    X, y, subj, view, split = load_all()
    X = impute(X)

    print("=" * 78)
    print("GENERALISATION DIAGNOSIS")
    print("=" * 78)
    print(f"reps      : {len(X)}")
    print(f"subjects  : {len(set(subj))}")
    print(f"good/bad  : {int((y == 0).sum())}/{int((y == 1).sum())}")
    print()

    # ---------------- 1. label noise ------------------------------------
    print("-" * 78)
    print("1. LABEL SEPARATION (can any model tell good from bad?)")
    print("-" * 78)

    effects = []
    for i, name in enumerate(FEATURE_NAMES):
        d = cohens_d(X[y == 0, i], X[y == 1, i])
        effects.append((abs(d), d, name))
    effects.sort(reverse=True)

    print(f"  {'feature':42s} {'cohens d':>9s}  magnitude")
    for _absd, d, name in effects[:14]:
        mag = (
            "large" if abs(d) >= 0.8 else
            "medium" if abs(d) >= 0.5 else
            "small" if abs(d) >= 0.2 else
            "negligible"
        )
        print(f"  {name:42s} {d:+9.3f}  {mag}")

    strong = sum(1 for a, _d, _n in effects if a >= 0.5)
    print()
    print(f"  features with medium+ separation (|d| >= 0.5): {strong}/{len(FEATURE_NAMES)}")
    if strong == 0:
        print("  >>> No feature separates the classes well. The labels may not")
        print("      correspond to a consistent movement difference.")
    print()

    # ---------------- 2. subject confound -------------------------------
    print("-" * 78)
    print("2. SUBJECT CONFOUND (is the model learning identity, not form?)")
    print("-" * 78)

    from sklearn.ensemble import RandomForestClassifier
    from sklearn.metrics import f1_score

    tr = split == "train"
    te = split == "test"

    # Baseline: predict form
    clf = RandomForestClassifier(n_estimators=200, random_state=0, class_weight="balanced")
    clf.fit(X[tr], y[tr])
    form_f1 = f1_score(y[te], clf.predict(X[te]), average="macro")

    # Same features, but try to predict SUBJECT instead of form.
    subj_codes = {s: i for i, s in enumerate(sorted(set(subj)))}
    ys = np.array([subj_codes[s] for s in subj])

    # Evaluate subject-identifiability using cross-validated accuracy on the
    # same feature matrix.
    from sklearn.model_selection import cross_val_score

    subj_acc = cross_val_score(
        RandomForestClassifier(n_estimators=200, random_state=0),
        X,
        ys,
        cv=3,
    ).mean()
    chance = 1.0 / len(subj_codes)

    print(f"  form   macro-F1 on test            : {form_f1:.3f}")
    print(f"  subject-identification accuracy    : {subj_acc:.3f}")
    print(f"  chance level for subject ID        : {chance:.3f}")
    print(
        f"  identifiability above chance       : {(subj_acc - chance) / max(1e-9, 1 - chance) * 100:.1f}%"
    )
    if subj_acc > chance * 3:
        print("  >>> Features still carry a strong subject fingerprint.")
        print("      Torso normalisation reduced but did not remove it.")
    print()

    # ---------------- 3. per-view separability --------------------------
    print("-" * 78)
    print("3. SEPARABILITY BY VIEW")
    print("-" * 78)
    for v in sorted(set(view)):
        m = view == v
        best = 0.0
        best_name = ""
        for i, name in enumerate(FEATURE_NAMES):
            d = abs(cohens_d(X[m & (y == 0), i], X[m & (y == 1), i]))
            if d > best:
                best, best_name = d, name
        print(
            f"  {v:9s} n={int(m.sum()):4d}  good={int((m & (y == 0)).sum()):4d} "
            f"bad={int((m & (y == 1)).sum()):4d}  best |d|={best:.3f} ({best_name})"
        )
    print()

    # ---------------- 4. per-subject label composition ------------------
    print("-" * 78)
    print("4. PER-SUBJECT LABEL COMPOSITION")
    print("-" * 78)
    print(f"  {'subject':10s} {'split':10s} {'good':>5s} {'bad':>5s} {'n':>5s}")
    comp = defaultdict(lambda: [0, 0])
    for s, lab in zip(subj, y):
        comp[s][lab] += 1
    for s in sorted(comp):
        g, b = comp[s]
        sp = split[subj == s][0]
        print(f"  {s:10s} {sp:10s} {g:5d} {b:5d} {g + b:5d}")
    print()

    # ---------------- 5. per-view model --------------------------------
    print("-" * 78)
    print("5. VIEW-SPECIFIC TEST MACRO-F1 (RF, trained per view)")
    print("-" * 78)
    for v in sorted(set(view)):
        trv = tr & (view == v)
        tev = te & (view == v)
        if trv.sum() < 20 or tev.sum() < 10:
            print(f"  {v:9s} insufficient data (train={int(trv.sum())}, test={int(tev.sum())})")
            continue
        clf_v = RandomForestClassifier(
            n_estimators=200, random_state=0, class_weight="balanced"
        )
        clf_v.fit(X[trv], y[trv])
        f1 = f1_score(y[tev], clf_v.predict(X[tev]), average="macro")
        print(f"  {v:9s} train={int(trv.sum()):4d} test={int(tev.sum()):4d}  macro-F1={f1:.3f}")

    print()
    print("=" * 78)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
