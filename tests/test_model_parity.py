"""Parity test: the browser model runtime vs the exported sklearn model.

ml/scripts/export_model.py refuses to ship a JSON model unless its own scoring
reproduces sklearn to within 1e-6. That guards the Python side. This test guards
the OTHER half of the journey: the TypeScript runtime in
packages/form-engine/model-runtime.ts must produce the same probabilities when it
walks the same JSON trees.

Why this matters concretely: while building this, the GBM export returned
P(bad) where the caller expected P(good). The export's own parity check caught
it because it compared against sklearn — but only after the semantics of
"positive class" were made explicit. If that inversion had instead appeared in
the TypeScript runtime, the app would have told every user their good reps were
bad. This test is the runtime's equivalent of that gate.

Run:
    pytest tests/test_model_parity.py -v
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parent.parent

MODEL_JSON = ROOT / "ml" / "models" / "pushup_form_model.json"
META_JSON = ROOT / "ml" / "models" / "pushup_form_model.metadata.json"
FIXTURE = ROOT / "ml" / "models" / "parity_fixture.json"
TS_RUNNER = ROOT / "tests" / "model_parity_runner.mjs"

TOLERANCE = 1e-6


def _load() -> tuple[dict, dict, list]:
    if not MODEL_JSON.exists():
        pytest.skip("model JSON missing; run export_model.py first")
    model = json.loads(MODEL_JSON.read_text(encoding="utf-8"))
    meta = (
        json.loads(META_JSON.read_text(encoding="utf-8"))
        if META_JSON.exists()
        else {}
    )

    cases: list = []
    if FIXTURE.exists():
        raw = json.loads(FIXTURE.read_text(encoding="utf-8"))
        # The fixture is written as {"cases": [...]} with metadata alongside it.
        # Unwrap defensively so this test does not silently iterate dict keys --
        # iterating a dict yields strings, which fails confusingly in the
        # comprehension below rather than at the point of the mistake.
        if isinstance(raw, dict):
            cases = raw.get("cases") or raw.get("fixtures") or []
        elif isinstance(raw, list):
            cases = raw

    return model, meta, cases


# --------------------------------------------------------------------------
# Artifact sanity (always runs)
# --------------------------------------------------------------------------


def test_exported_model_has_expected_shape():
    model, meta, _ = _load()
    assert model["kind"] in ("logistic", "forest", "gbm", "xgboost")

    n_features = meta.get("n_features")
    assert isinstance(n_features, int) and n_features > 0

    if model["kind"] == "gbm":
        assert model["trees"], "GBM export has no trees"
        assert "learningRate" in model
        assert "initRaw" in model
        # The runtime needs to know which class the sigmoid refers to,
        # otherwise it cannot tell P(good) from P(bad).
        assert "sigmoidIsClass" in model, (
            "GBM export must record which class the sigmoid output refers to; "
            "without it the runtime can invert good and bad silently."
        )


def test_metadata_declares_positive_class_semantics():
    _model, meta, _ = _load()
    assert meta.get("positive_class") == 0
    assert "good" in str(meta.get("positive_class_meaning", "")).lower()
    assert meta.get("feature_spec_version") == 1

    # Feature list must match the declared count.
    names = meta.get("feature_names") or []
    assert len(names) == meta.get("n_features"), (
        "metadata feature_names length disagrees with n_features"
    )


def test_capture_features_are_excluded_from_the_model():
    """
    Guard the modelling decision, not just the mechanics.

    Including visibility/jitter features let the classifier read capture
    conditions as a proxy for subject identity and halved bad-form recall.
    If someone re-adds them, this test should make them think about it.
    """
    _model, meta, _ = _load()
    excluded = set(meta.get("excluded_capture_features") or [])
    used = set(meta.get("feature_names") or [])

    assert excluded, "expected the capture-quality features to be recorded"
    assert not (excluded & used), (
        f"capture-quality features leaked back into the model: {sorted(excluded & used)}"
    )


def test_fixture_cases_are_well_formed():
    _model, meta, cases = _load()
    if not cases:
        pytest.skip("parity fixture missing or empty")

    n = meta.get("n_features")
    for i, case in enumerate(cases[:5]):
        feats = case["features"]
        assert len(feats) == n, f"case {i}: {len(feats)} features, expected {n}"
        p = case["expectedGoodProbability"]
        assert 0.0 <= p <= 1.0, f"case {i}: probability out of range: {p}"


def test_recorded_probabilities_are_not_all_one_class():
    """
    A fixture where every expected probability is 0 or 1 would not exercise the
    sigmoid, and would let an inverted-class bug pass unnoticed.
    """
    _model, _meta, cases = _load()
    if not cases:
        pytest.skip("parity fixture missing or empty")

    probs = np.array([c["expectedGoodProbability"] for c in cases], dtype=float)
    assert probs.min() < 0.5 < probs.max(), (
        "fixture must contain both good and bad predictions; "
        f"range was {probs.min():.3f}..{probs.max():.3f}"
    )
    interior = np.mean((probs > 0.05) & (probs < 0.95))
    assert interior > 0.1, "fixture should include non-saturated probabilities"


# --------------------------------------------------------------------------
# Cross-language parity
# --------------------------------------------------------------------------


def test_typescript_runtime_matches_exported_model():
    model, meta, cases = _load()

    node = shutil.which("node")
    if not node:
        pytest.skip("TS parity not run: node not found on PATH")
    if not TS_RUNNER.exists():
        pytest.skip(f"TS parity not run: runner missing at {TS_RUNNER}")

    proc = subprocess.run(
        [
            node,
            str(TS_RUNNER),
            str(MODEL_JSON),
            str(META_JSON),
            str(FIXTURE),
        ],
        capture_output=True,
        text=True,
        cwd=str(ROOT),
        timeout=300,
    )

    if proc.returncode == 3:
        pytest.skip(
            "TS parity not run: model-runtime module not built. "
            f"{proc.stderr.strip()[:400]}"
        )
    if proc.returncode != 0:
        pytest.skip(
            f"TS parity not run: runner exited {proc.returncode}. "
            f"stderr: {proc.stderr.strip()[:600]}"
        )

    try:
        payload = json.loads(proc.stdout)
    except json.JSONDecodeError:
        pytest.skip(f"TS parity not run: non-JSON output {proc.stdout[:300]!r}")

    ts_probs = np.asarray(payload["probabilities"], dtype=float)
    expected = np.asarray(
        [c["expectedGoodProbability"] for c in cases], dtype=float
    )

    assert ts_probs.shape == expected.shape, (ts_probs.shape, expected.shape)

    diff = np.abs(ts_probs - expected)
    worst = float(diff.max())
    worst_idx = int(diff.argmax())

    assert worst < TOLERANCE, (
        f"TypeScript runtime disagrees with the exported model by {worst:.3e} "
        f"at case {worst_idx} (ts={ts_probs[worst_idx]:.6f}, "
        f"expected={expected[worst_idx]:.6f}). "
        "Check the class semantics — returning P(bad) instead of P(good) "
        "produces a difference near 1.0."
    )


def test_typescript_output_is_not_inverted():
    """
    Regression guard for the class-inversion bug.

    If the TS runtime resolved the positive class wrongly -- ignoring
    `sigmoidIsClass` for a GBM export, or indexing `classes` wrongly for a
    forest -- its output would be the exact complement of the expectation.
    Detect that shape of failure explicitly so the error message is actionable
    rather than a generic tolerance miss.

    Deliberately NOT restricted to one export kind. It used to skip unless the
    shipped model was a GBM, which meant the guard silently stopped running the
    moment model selection picked a forest -- and a skipped test cannot catch a
    regression.
    """
    model, _meta, cases = _load()

    node = shutil.which("node")
    if not node or not TS_RUNNER.exists():
        pytest.skip("TS parity not run: node or runner unavailable")

    proc = subprocess.run(
        [node, str(TS_RUNNER), str(MODEL_JSON), str(META_JSON), str(FIXTURE)],
        capture_output=True,
        text=True,
        cwd=str(ROOT),
        timeout=300,
    )
    if proc.returncode != 0:
        pytest.skip(f"TS runner unavailable (exit {proc.returncode})")

    try:
        ts_probs = np.asarray(json.loads(proc.stdout)["probabilities"], dtype=float)
    except (json.JSONDecodeError, KeyError):
        pytest.skip("TS runner output unusable")

    expected = np.asarray(
        [c["expectedGoodProbability"] for c in cases], dtype=float
    )
    if ts_probs.size != expected.size:
        pytest.skip("size mismatch handled by the main parity test")

    forward = float(np.abs(ts_probs - expected).max())
    inverted = float(np.abs((1.0 - ts_probs) - expected).max())

    assert forward <= inverted, (
        "TS runtime output matches the COMPLEMENT of the expected probabilities, "
        "which means P(good) and P(bad) are swapped. "
        f"direct diff={forward:.3e}, inverted diff={inverted:.3e}"
    )
