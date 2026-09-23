"""
scripts/export_model.py

Agent 13 — REAL-TIME ML INFERENCE ENGINEER

Exports the trained estimator into two artifacts from ONE fitted object:

    1. models/pushup_form_model.json
       Pure-JSON weights the browser can score with, no ML library needed.

    2. models/pushup_form_model.metadata.json
       Feature list, version, threshold, train means, measured metrics.

It also writes a PARITY FIXTURE:

    models/parity_fixture.json
    { cases: [ { features: [...], expected_good_probability: ... } ] }

The browser scoring path is validated against this fixture by
tests/model-parity.test.ts. Without that check a subtly wrong export would
silently mis-score every rep in the live app, and nothing would look broken.

Run:
    python ml/scripts/export_model.py
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np

SCRIPT_DIR = Path(__file__).resolve().parent
ML_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(ML_DIR))

from src.features import FEATURE_NAMES, N_FEATURES, FEATURE_SPEC_VERSION  # noqa: E402

MODELS_DIR = ML_DIR / "models"
JOBLIB_PATH = MODELS_DIR / "pushup_form_model.joblib"

# Where the web app reads the model from.
WEB_PUBLIC_MODELS = ML_DIR.parent / "apps" / "web" / "public" / "models"


def unwrap(estimator):
    """Unwrap a Pipeline to the final classifier + any scaler."""
    scaler = None
    clf = estimator
    if hasattr(estimator, "named_steps"):
        steps = estimator.named_steps
        scaler = steps.get("scaler")
        if "clf" in steps:
            clf = steps["clf"]
    return clf, scaler


def export_forest(clf) -> dict:
    trees = []
    for est in clf.estimators_:
        t = est.tree_
        # value shape (n_nodes, 1, n_classes) -> per-node class counts
        counts = t.value[:, 0, :]
        trees.append(
            {
                "childrenLeft": t.children_left.tolist(),
                "childrenRight": t.children_right.tolist(),
                "feature": t.feature.tolist(),
                "threshold": t.threshold.tolist(),
                "value": counts.tolist(),
            }
        )
    return {
        "kind": "forest",
        "trees": trees,
        # Class indices as numbers: metadata's positive_class is an int, and the
        # TypeScript runtime resolves the probability column with
        # classes.indexOf(positive_class). Strings here would silently miss and
        # fall back to position 0 -- correct for [0,1] by accident, wrong in
        # general.
        "classes": [int(c) for c in clf.classes_],
    }


def export_logistic(clf, scaler) -> dict:
    # sklearn binary logistic stores only the score for classes_[1]. The
    # browser indexes coefficient rows by class, so provide both rows rather
    # than accidentally reporting P(bad) as P(good).
    if len(clf.classes_) != 2 or clf.coef_.shape[0] != 1:
        raise ValueError("Browser logistic export requires binary classes")
    weights = clf.coef_[0].astype(float)
    bias = float(clf.intercept_[0])
    if scaler is not None:
        # Fold scaling into the coefficients so the browser needs no scaler.
        #   z = w . ((x - mu)/sigma) + b
        #     = (w/sigma) . x + (b - sum(w*mu/sigma))
        mu = np.asarray(scaler.mean_, dtype=float)
        sigma = np.asarray(scaler.scale_, dtype=float)
        sigma = np.where(sigma == 0, 1.0, sigma)
        weights = weights / sigma
        bias -= float(np.sum(clf.coef_[0] * mu / sigma))
    return {
        "kind": "logistic",
        "coef": np.concatenate([-weights, weights]).tolist(),
        "intercept": [-bias, bias],
        "classes": [int(c) for c in clf.classes_],
    }


def export_gbm(clf) -> dict:
    trees = []
    for stage in clf.estimators_:
        est = stage[0]
        t = est.tree_
        trees.append(
            {
                "childrenLeft": t.children_left.tolist(),
                "childrenRight": t.children_right.tolist(),
                "feature": t.feature.tolist(),
                "threshold": t.threshold.tolist(),
                "value": t.value[:, 0, :].tolist(),
            }
        )

    # sklearn's binary GBM: init is the log-odds of the prior
    init_raw = 0.0
    try:
        prior = clf.init_.class_prior_
        if prior is not None and len(prior) == 2:
            p = float(prior[1])
            if 0 < p < 1:
                init_raw = float(np.log(p / (1 - p)))
    except Exception:  # noqa: BLE001
        init_raw = 0.0

    return {
        "kind": "gbm",
        "initRaw": init_raw,
        "learningRate": float(clf.learning_rate),
        "trees": trees,
        "classes": [int(c) for c in clf.classes_],
        # sklearn's binary GradientBoostingClassifier fits its trees to the
        # POSITIVE class (index 1), so the sigmoid returns P(class 1) -- in our
        # encoding, P(bad). Without recording this, the exporter looked like it
        # disagreed with sklearn by 0.96 when it was in fact returning the
        # exact complement. The runtime inverts it to get P(good).
        "sigmoidIsClass": int(clf.classes_[1]),
    }


def score_logistic(exp: dict, x: np.ndarray, positive_class: int = 0) -> float:
    row = exp["classes"].index(int(positive_class))
    start = row * len(x)
    z = exp["intercept"][row] + float(np.dot(np.asarray(exp["coef"])[start:start + len(x)], x))
    return 1.0 / (1.0 + np.exp(-z))


def traverse(tree: dict, x: np.ndarray) -> int:
    node = 0
    for _ in range(200):
        left = tree["childrenLeft"][node]
        if left == -1:
            return node
        feat = tree["feature"][node]
        thr = tree["threshold"][node]
        node = left if x[feat] <= thr else tree["childrenRight"][node]
    return node


def score_forest(exp: dict, x: np.ndarray, positive_index: int) -> float:
    total = 0.0
    for tree in exp["trees"]:
        leaf = traverse(tree, x)
        counts = tree["value"][leaf]
        s = float(sum(counts))
        total += (counts[positive_index] / s) if s > 0 else 0.5
    return total / max(len(exp["trees"]), 1)


def score_gbm(exp: dict, x: np.ndarray, positive_class: int = 0) -> float:
    """
    Score one vector, returning P(positive_class) -- 0 = good by convention.

    sklearn's binary GBM fits trees to class index 1, so the sigmoid yields
    P(class 1). When the caller wants class 0 (good form) we return the
    complement, which is what the browser model actually needs.
    """
    raw = exp["initRaw"]
    for tree in exp["trees"]:
        leaf = traverse(tree, x)
        v = tree["value"][leaf]
        raw += exp["learningRate"] * (v[0] if isinstance(v, list) else float(v))
    p_sigmoid_class = 1.0 / (1.0 + np.exp(-raw))

    sigmoid_class = exp.get("sigmoidIsClass", 0)
    if sigmoid_class == positive_class:
        return p_sigmoid_class
    return 1.0 - p_sigmoid_class


def score_export(exp: dict, x: np.ndarray, positive_class: str) -> float:
    if exp["kind"] == "logistic":
        return score_logistic(exp, x, positive_class)
    if exp["kind"] == "forest":
        # Class indices are exported as ints (matching `positive_class`), but
        # resolve defensively: map through str() so a legacy string export or
        # a named-class export ("good"/"bad") still resolves. This path was
        # never exercised while model selection kept picking the gradient
        # booster, so the int/str mismatch survived until a retrain selected
        # a forest.
        classes = [str(c) for c in exp["classes"]]
        pos_idx = classes.index(str(positive_class))
        return score_forest(exp, x, pos_idx)
    if exp["kind"] == "gbm":
        return score_gbm(exp, x, positive_class)
    raise ValueError(f"unknown export kind {exp['kind']}")


def main() -> int:
    if not JOBLIB_PATH.exists():
        print(f"Missing {JOBLIB_PATH}. Run train_classifier.py first.")
        return 1

    import joblib

    bundle = joblib.load(JOBLIB_PATH)
    estimator = bundle["model"]
    threshold = float(bundle["threshold"])

    # The model may be trained on a SUBSET of the 37 contract features. The
    # trainer records which ones it used (capture-quality features such as
    # visibility and jitter are excluded because they leak capture conditions).
    # Read the list from the bundle rather than assuming the full contract, or
    # the export silently builds a 37-wide model against 34-wide coefficients.
    model_features = list(bundle.get("feature_names") or FEATURE_NAMES)
    n_model_features = len(model_features)

    train_means = np.asarray(
        bundle.get("train_feature_means", np.zeros(n_model_features))
    )
    if train_means.size != n_model_features:
        # Defensive: a stale bundle should fail loudly, not mis-shape silently.
        print(
            f"  !! bundle inconsistency: {n_model_features} feature names but "
            f"{train_means.size} imputation means. Retrain first."
        )
        return 4

    metrics = bundle.get("metrics", {})

    clf, scaler = unwrap(estimator)
    class_name = type(clf).__name__
    # Label convention from the trainer: 0 = good, 1 = bad. We return P(good).
    positive_class = 0

    print("=" * 62)
    print("EXPORTING MODEL FOR BROWSER INFERENCE")
    print("=" * 62)
    print(f"  estimator : {class_name}")

    if class_name in ("RandomForestClassifier", "ExtraTreesClassifier"):
        exp = export_forest(clf)
    elif class_name in ("GradientBoostingClassifier",):
        exp = export_gbm(clf)
    elif class_name in ("LogisticRegression",):
        exp = export_logistic(clf, scaler)
    elif class_name == "XGBClassifier":
        # XGBoost stores trees in a booster; export via its own JSON dump.
        exp = export_xgboost(clf)
    else:
        print(f"  !! unsupported estimator '{class_name}' for JSON export.")
        print("     The browser will fall back to geometry-only scoring.")
        return 2

    # -------- parity fixture: score the SAME vectors both ways --------
    print("\n  verifying export parity against sklearn...")
    rng = np.random.default_rng(0)

    # Sample realistic feature vectors from the train distribution.
    means = np.where(np.isfinite(train_means), train_means, 0.0)
    stds = np.maximum(np.abs(means) * 0.25, 1e-3)
    samples = means[None, :] + rng.normal(size=(500, n_model_features)) * stds[None, :]

    ref_probs = clf.predict_proba(samples)[:, list(clf.classes_).index(positive_class)]

    cases = []
    max_diff = 0.0
    for i in range(len(samples)):
        x = samples[i]
        ours = score_export(exp, x, positive_class)
        ref = float(ref_probs[i])
        max_diff = max(max_diff, abs(ours - ref))
        if i < 200:  # keep the fixture small; 200 is plenty to catch errors
            cases.append(
                {
                    "features": [float(v) for v in x],
                    "expectedGoodProbability": ref,
                }
            )

    print(f"  max |export - sklearn| over 500 vectors : {max_diff:.3e}")
    if max_diff > 1e-6:
        print("\n  !! PARITY FAILED. The JSON export does not reproduce sklearn.")
        print("     Refusing to ship a model the browser would mis-score.")
        return 3
    print("  [OK] parity within 1e-6")

    # -------- metadata --------
    metadata = {
        "model_type": class_name,
        "feature_spec_version": FEATURE_SPEC_VERSION,
        "feature_names": model_features,
        "n_features": n_model_features,
        "n_features_contract": N_FEATURES,
        "excluded_capture_features": list(metrics.get("excluded_capture_features", [])),
        "decision_threshold": threshold,
        "positive_class": positive_class,
        "positive_class_meaning": "P(good form)",
        "trained_at": metrics.get("generated_at", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())),
        "exported_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "train_feature_means": means.tolist(),
        "metrics": metrics.get("test", {}),
        "training_split": metrics.get("dataset", {}),
        "per_view": metrics.get("per_view", {}),
        "candidates": metrics.get("candidates", {}),
    }

    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    (MODELS_DIR / "pushup_form_model.json").write_text(json.dumps(exp), encoding="utf-8")
    (MODELS_DIR / "pushup_form_model.metadata.json").write_text(
        json.dumps(metadata, indent=2), encoding="utf-8"
    )
    (MODELS_DIR / "parity_fixture.json").write_text(
        json.dumps({"cases": cases}, indent=2), encoding="utf-8"
    )

    # mirrored copy the web app serves
    WEB_PUBLIC_MODELS.mkdir(parents=True, exist_ok=True)
    for name in (
        "pushup_form_model.json",
        "pushup_form_model.metadata.json",
        "parity_fixture.json",
    ):
        (WEB_PUBLIC_MODELS / name).write_text(
            (MODELS_DIR / name).read_text(encoding="utf-8"), encoding="utf-8"
        )

    exp_size = (MODELS_DIR / "pushup_form_model.json").stat().st_size
    print()
    print("=" * 62)
    print(f"  model json     : {exp_size / 1024:.1f} KB")
    print(f"  -> {MODELS_DIR / 'pushup_form_model.json'}")
    print(f"  -> {MODELS_DIR / 'pushup_form_model.metadata.json'}")
    print(f"  -> {MODELS_DIR / 'parity_fixture.json'}")
    print(f"  -> {WEB_PUBLIC_MODELS}  (served by the web app)")
    return 0


def export_xgboost(clf) -> dict:
    """Export an XGBoost booster to the same tree format as the forest export."""
    booster = clf.get_booster()
    dump = booster.get_dump(dump_format="json")
    trees = []
    for t in dump:
        node = json.loads(t)
        arrays = _walk_xgb_node(node, {"cl": [], "cr": [], "f": [], "th": [], "v": []})
        trees.append(
            {
                "childrenLeft": arrays["cl"],
                "childrenRight": arrays["cr"],
                "feature": arrays["f"],
                "threshold": arrays["th"],
                "value": arrays["v"],
            }
        )
    return {
        "kind": "gbm",
        "initRaw": 0.0,
        "learningRate": 1.0,
        "trees": trees,
        "classes": ["good", "bad"],
    }


def _walk_xgb_node(node: dict, acc: dict) -> dict:
    """Flatten an XGBoost JSON tree into the array format the runtime expects."""
    idx = len(acc["cl"])
    acc["cl"].append(-1)
    acc["cr"].append(-1)
    acc["f"].append(0)
    acc["th"].append(0.0)
    # leaf values must be a list to match the runtime's shape expectation
    acc["v"].append([float(node.get("leaf", 0.0)), -float(node.get("leaf", 0.0))])

    if "children" in node:
        left = _walk_xgb_node(node["children"][0], acc)
        right = _walk_xgb_node(node["children"][1], acc)
        acc["cl"][idx] = left
        acc["cr"][idx] = right
        split = node.get("split", "0")
        feat_idx = int(str(split).replace("f", "")) if str(split).startswith("f") else 0
        acc["f"][idx] = feat_idx
        acc["th"][idx] = float(node.get("split_condition", 0.0))
        acc["v"][idx] = [0.0, 0.0]
    return idx


if __name__ == "__main__":
    raise SystemExit(main())
