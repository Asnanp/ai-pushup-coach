"""tests/make_replay_fixture.py

Build a replay fixture from REAL videos, via the cached per-frame features that
``ml/scripts/extract_pose_features.py`` already produced.

Why this exists
---------------
Every existing cross-language test runs on synthetic input:

- ``tests/fixtures/pose_frames.json`` is 24 hand-made frames.
- ``ml/models/parity_fixture.json`` is 200 feature vectors.

Neither exercises the TypeScript rep segmenter or the feature aggregator on the
noisy, gappy landmark streams that real footage produces. This exporter closes
that gap: it replays the *actual* per-frame features from real clips through the
TypeScript pipeline and compares against what Python computed at training time.

Two things are measured, deliberately separated so a failure is diagnosable:

1. **Smoothing.** The same raw elbow series goes through Python's
   ``smooth_signal`` and the TypeScript ``CausalSmoother``. Their outputs are
   compared directly.
2. **Aggregation.** Given Python's rep windows, does the TypeScript
   ``aggregateRepWindow`` produce the same 37-dim vector?

Rep *count* parity is reported as well, but it is the sum of both, so a mismatch
there is not by itself diagnostic.

The fixture is generated, not committed by hand, because it is derived from the
dataset. Regenerate with::

    python tests/make_replay_fixture.py

The output is written to ``tests/fixtures/real_video_replay.json``.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "ml"))

from src.rep_segmenter import (  # noqa: E402
    calibrate_thresholds,
    segment_reps,
    smooth_signal,
)

PROCESSED = ROOT / "ml" / "data" / "processed"
OUT = ROOT / "tests" / "fixtures" / "real_video_replay.json"

# One clip per (quality, view) cell. Stratified rather than random so a
# regression in one camera angle cannot hide behind the others.
CASES = [
    ("good", "front"),
    ("good", "side"),
    ("good", "diagonal"),
    ("bad", "front"),
    ("bad", "side"),
    ("bad", "diagonal"),
]

# Two subjects per cell would double the fixture for little extra signal; the
# segmentation and aggregation paths do not branch on subject.
SUBJECT = "002"


def _num(v: float):
    """JSON-safe scalar: the fixture convention is the string "NaN"."""
    v = float(v)
    return "NaN" if not np.isfinite(v) else v


def build_case(quality: str, view: str) -> dict | None:
    path = PROCESSED / f"{quality}_{view}_subject_{SUBJECT}.npz"
    if not path.exists():
        print(f"  skip {path.name}: not found")
        return None

    d = np.load(path, allow_pickle=True)
    frames = d["frames"]
    times = d["frame_times"]
    columns = [str(c) for c in d["frame_columns"]]
    expected_windows = [[int(r[0]), int(r[1])] for r in d["rep_meta"]]
    expected_vectors = d["rep_vectors"]
    n_frames = int(frames.shape[0])

    # ---- the reference pipeline, recomputed here so the fixture is self-contained ----
    elbow_col = columns.index("elbow_angle")
    elbow_series = frames[:, elbow_col].astype(np.float64)

    smoothed = smooth_signal(elbow_series)
    events, windows, track_quality = segment_reps(
        elbow_series, times.astype(np.float64), view=view
    )
    # `windows` is what segment_reps actually returns; the stored rep_meta is
    # derived from it, so assert they agree rather than trusting one.
    assert [[int(s), int(e)] for s, e in windows] == expected_windows, (
        f"{path.name}: segment_reps windows disagree with the stored rep_meta; "
        "the fixture would be measuring the wrong thing"
    )

    cal = calibrate_thresholds(smoothed)

    return {
        "name": path.stem,
        "quality": quality,
        "view": view,
        "subject": SUBJECT,
        "fps": float(d["fps"]),
        "n_frames": n_frames,
        "tracked": bool(d["track_quality_tracked"]),
        "frame_columns": columns,
        "frame_times": [_num(t) for t in times],
        "frames": [[_num(v) for v in row] for row in frames],
        # Python's smoothed series — the thing the TypeScript causal smoother
        # is compared against.
        "python_smoothed": [_num(v) for v in smoothed],
        "python_thresholds": {k: _num(v) for k, v in cal.items() if k != "calibrated"},
        "expected_n_reps": int(expected_vectors.shape[0]),
        "expected_windows": expected_windows,
        "expected_rep_vectors": [[_num(v) for v in row] for row in expected_vectors],
        "python_track_quality": {
            "tracked": bool(track_quality["tracked"]),
            "reason": str(track_quality["reason"]),
            "rom": _num(track_quality["rom"]),
            "median_step": _num(track_quality["median_step"]),
            "reversal_fraction": _num(track_quality["reversal_fraction"]),
        },
    }


def main() -> int:
    if not PROCESSED.exists():
        print(f"error: {PROCESSED} does not exist.")
        print("Run `npm run ml:pipeline -- --full` first to extract the features.")
        return 1

    cases = []
    for quality, view in CASES:
        print(f"building {quality}/{view} ...")
        case = build_case(quality, view)
        if case is not None:
            cases.append(case)

    if not cases:
        print("error: no cases built")
        return 1

    payload = {
        "source": "ml/data/processed/*.npz (real videos, MediaPipe-extracted)",
        "note": (
            "Replay fixture: real per-frame features plus the Python-computed "
            "rep windows and 37-dim rep vectors. Consumed by "
            "tests/replay_runner.mjs to exercise the TypeScript segmenter and "
            "aggregator on real data."
        ),
        "feature_spec_version": int(
            np.load(PROCESSED / f"{CASES[0][0]}_{CASES[0][1]}_subject_{SUBJECT}.npz")[
                "feature_spec_version"
            ]
        ),
        "cases": cases,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, allow_nan=False), encoding="utf-8")

    size_mb = OUT.stat().st_size / 1_000_000
    total_reps = sum(c["expected_n_reps"] for c in cases)
    print(f"\nwrote {OUT.relative_to(ROOT)} ({size_mb:.2f} MB)")
    print(f"  {len(cases)} clips, {total_reps} real reps, "
          f"{sum(c['n_frames'] for c in cases)} frames")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
