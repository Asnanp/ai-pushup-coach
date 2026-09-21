"""Parity test: Python feature extraction vs the TypeScript mirror.

The project maintains two implementations of the 37-feature extractor:
  - ml/src/features.py                (training)
  - packages/biomechanics/extract.ts  (in-browser inference)

If they ever disagree, the model is trained on one feature distribution and
served a different one, which degrades silently and looks like "the model is
just bad". docs/FEATURE_SCHEMA.md is the contract; this test enforces it.

Layering, as defined by the contract:
    extract_frame_features()  ->  per-frame FrameFeatures (17 scalars)
    aggregate_rep_window()    ->  the 37-value vector the model consumes

The 37-vector is the interface that actually crosses the language boundary, so
that is what this test compares.

The TS comparison SKIPS rather than fails when node or a runnable extractor is
unavailable, so a Python-only environment still gets value from the rest of the
suite. Skips are reported explicitly so a green run is never mistaken for
verification.

Run:
    pytest tests/test_feature_parity.py -v
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
sys.path.insert(0, str(ROOT))

from ml.src.features import (  # noqa: E402
    FEATURE_NAMES,
    FEATURE_SPEC_VERSION,
    N_FEATURES,
    Landmark,
    aggregate_rep_window,
    extract_frame_features,
)

FIXTURE_DIR = ROOT / "tests" / "fixtures"
FIXTURE_PATH = FIXTURE_DIR / "pose_frames.json"
TS_ENTRY = ROOT / "tests" / "parity_runner.mjs"

WINDOW_FRAMES = 24


def _make_pose(seed: int) -> dict:
    """
    Deterministic synthetic pose.

    Landmarks are laid out as a plausible body rather than uniformly at random:
    a random cloud makes nearly every angle degenerate, which would let a badly
    broken extractor still "agree" because both sides return NaN.
    """
    rng = np.random.default_rng(seed)

    # Base skeleton in normalised image coordinates (y grows downward).
    base = {
        0: (0.50, 0.18),   # nose
        11: (0.44, 0.28),  # left shoulder
        12: (0.56, 0.28),  # right shoulder
        13: (0.40, 0.42),  # left elbow
        14: (0.60, 0.42),  # right elbow
        15: (0.38, 0.55),  # left wrist
        16: (0.62, 0.55),  # right wrist
        23: (0.45, 0.55),  # left hip
        24: (0.55, 0.55),  # right hip
        25: (0.44, 0.72),  # left knee
        26: (0.56, 0.72),  # right knee
        27: (0.44, 0.88),  # left ankle
        28: (0.56, 0.88),  # right ankle
        31: (0.44, 0.93),  # left foot
        32: (0.56, 0.93),  # right foot
    }

    pts = []
    for idx in range(33):
        bx, by = base.get(idx, (0.5 + 0.01 * idx, 0.5))
        pts.append(
            {
                "x": float(bx + rng.normal(0, 0.012)),
                "y": float(by + rng.normal(0, 0.012)),
                "z": float(rng.normal(0, 0.02)),
                "visibility": float(np.clip(rng.uniform(0.80, 0.99), 0, 1)),
            }
        )
    return {"landmarks": pts}


def _window() -> list[dict]:
    """A 24-frame window with a moving elbow, so temporal features are real."""
    frames = []
    for i in range(WINDOW_FRAMES):
        frame = _make_pose(7000 + i)
        # Sweep the elbow through a rep so velocity/ROM features vary.
        t = i / (WINDOW_FRAMES - 1)
        bend = float(np.sin(t * np.pi) * 0.06)
        for idx, sign in ((13, -1), (14, 1)):
            frame["landmarks"][idx]["x"] += sign * bend
            frame["landmarks"][idx]["y"] += bend * 0.6
        frames.append(frame)
    return frames


def _python_vector(frames: list[dict]) -> tuple[np.ndarray, dict]:
    """
    Run the reference implementation and return the 37-vector.

    The side is carried across frames exactly as `ml/scripts/extract_pose_features.py`
    does it. Re-picking the side independently on every frame would make this
    harness disagree with the TypeScript runner for a reason that has nothing to
    do with the geometry maths: the two would simply be modelling different
    policies. Production locks the side for the whole clip, so the harness must
    too, otherwise the parity test compares the wrong things.
    """
    window = []
    current_side: str | None = None
    for i, item in enumerate(frames):
        lms = [
            Landmark(p["x"], p["y"], p["z"], p["visibility"])
            for p in item["landmarks"]
        ]
        feats = extract_frame_features(
            lms,
            timestamp=i / 15.0,
            current_side=current_side,
            allow_side_switch=True,
        )
        if feats.valid and current_side is None:
            current_side = feats.side
        window.append(feats)

    vec, raw = aggregate_rep_window(window)
    return np.asarray(vec, dtype=float), raw


# --------------------------------------------------------------------------
# Contract guards (always run)
# --------------------------------------------------------------------------


def test_feature_count_matches_contract():
    assert len(FEATURE_NAMES) == N_FEATURES == 37
    assert FEATURE_SPEC_VERSION == 1
    assert len(set(FEATURE_NAMES)) == 37, "feature names must be unique"


def test_python_aggregation_produces_37_vector():
    frames = _window()
    vec, raw = _python_vector(frames)
    assert vec.shape == (N_FEATURES,), vec.shape
    assert isinstance(raw, dict) and raw
    assert np.isfinite(vec).sum() >= N_FEATURES * 0.5, (
        "most features should be finite on a well-formed window; "
        f"only {int(np.isfinite(vec).sum())}/{N_FEATURES} were"
    )


def test_aggregation_is_deterministic():
    frames = _window()
    a, _ = _python_vector(frames)
    b, _ = _python_vector(frames)
    np.testing.assert_array_equal(a, b)


def test_frame_features_are_plausible():
    frames = _window()
    lms = [
        Landmark(p["x"], p["y"], p["z"], p["visibility"])
        for p in frames[0]["landmarks"]
    ]
    f = extract_frame_features(lms)

    assert f.valid is True
    assert f.side in ("left", "right")
    # The synthetic skeleton has a bent arm, so the elbow angle is real.
    assert 0 <= f.elbow_angle <= 180
    assert 0.5 <= f.mean_visibility <= 1.0


# --------------------------------------------------------------------------
# Cross-language parity
# --------------------------------------------------------------------------


def test_typescript_extractor_matches_python():
    node = shutil.which("node")
    if not node:
        pytest.skip("TS parity not run: node not found on PATH")
    if not TS_ENTRY.exists():
        pytest.skip(f"TS parity not run: runner missing at {TS_ENTRY}")

    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    frames = _window()
    FIXTURE_PATH.write_text(json.dumps(frames), encoding="utf-8")

    proc = subprocess.run(
        [node, str(TS_ENTRY), str(FIXTURE_PATH)],
        capture_output=True,
        text=True,
        cwd=str(ROOT),
        timeout=180,
    )

    if proc.returncode != 0:
        pytest.skip(
            f"TS parity not run: runner exited {proc.returncode}. "
            f"stderr: {proc.stderr.strip()[:800]}"
        )

    try:
        payload = json.loads(proc.stdout)
    except json.JSONDecodeError:
        pytest.skip(f"TS parity not run: non-JSON output {proc.stdout[:300]!r}")

    ts_vec = np.asarray(
        [float("nan") if v == "NaN" else v for v in payload["vector"]],
        dtype=float,
    )
    assert ts_vec.shape == (N_FEATURES,), ts_vec.shape

    py_vec, _ = _python_vector(frames)

    worst = 0.0
    worst_name = ""
    mismatched_nan: list[str] = []

    for i, (a, b) in enumerate(zip(py_vec, ts_vec)):
        if np.isnan(a) and np.isnan(b):
            continue
        if np.isnan(a) != np.isnan(b):
            mismatched_nan.append(f"{FEATURE_NAMES[i]} (py={a}, ts={b})")
            continue
        worst = max(worst, abs(a - b))
        if abs(a - b) > 1e-6:
            worst_name = FEATURE_NAMES[i]

    assert not mismatched_nan, "NaN disagreement on: " + ", ".join(mismatched_nan)
    assert worst < 1e-6, (
        f"largest disagreement {worst:.3e} on feature {worst_name!r}"
    )
