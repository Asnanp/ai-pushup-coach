"""Scratch diagnostic: why do some clips segment to zero reps?

The processed .npz stores FRAME_COLUMNS (17 per-frame scalars), not raw
landmarks. elbow_angle is column 0 and the per-frame validity flag is
column 16. This script re-runs calibration on the stored signal and reports
the numbers that explain the rep count.

Not part of the pipeline. Kept because the answer shaped rep_segmenter.py.
"""
from __future__ import annotations

import argparse
import glob
import os
import sys

import numpy as np

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from ml.src.rep_segmenter import (  # noqa: E402
    MAX_REP_SECONDS,
    MIN_REP_SECONDS,
    calibrate_thresholds,
    segment_reps,
    smooth_signal,
)

DEFAULT_PROBES = [
    "bad_side_subject_001",
    "bad_side_subject_003",
    "bad_side_subject_004",
    "bad_side_subject_016",
    "good_side_subject_004",
    "good_side_subject_016",
    "good_side_subject_023",
    "good_front_subject_013",
    "good_diagonal_subject_020",
    "good_diagonal_subject_021",
    "good_diagonal_subject_022",
    "good_side_subject_010",
    "good_side_subject_012",
    "good_side_subject_003",
    "good_side_subject_007",
    "bad_front_subject_009",
]


def analyse(path: str) -> str:
    key = os.path.splitext(os.path.basename(path))[0]
    data = np.load(path, allow_pickle=True)
    frames = np.asarray(data["frames"], dtype=np.float64)
    times = np.asarray(data["frame_times"], dtype=np.float64)

    if frames.size == 0:
        return f"{key:34s} no frames"

    cols = [str(c) for c in data["frame_columns"]]
    i_elbow = cols.index("elbow_angle")
    i_valid = cols.index("valid")
    i_vis = cols.index("mean_visibility")

    elbow = frames[:, i_elbow].copy()
    valid_mask = frames[:, i_valid] > 0.5

    # Blank frames that the extractor flagged as unusable so calibration
    # does not learn its range from garbage.
    elbow = np.where(valid_mask, elbow, np.nan)

    finite = elbow[np.isfinite(elbow)]
    if finite.size == 0:
        return f"{key:34s} all-NaN elbow"

    smoothed = smooth_signal(elbow)
    sm_finite = smoothed[np.isfinite(smoothed)]
    thr = calibrate_thresholds(smoothed)
    p5, p50, p95 = np.percentile(sm_finite, [5, 50, 95])

    mean_vis = float(np.nanmean(frames[:, i_vis]))
    valid_pct = 100.0 * float(np.mean(valid_mask))

    long_gap = max(_runs(valid_mask), default=0)

    def g(name):
        v = thr.get(name)
        return float("nan") if v is None else float(v)

    span = p95 - p5
    return (
        f"{key:34s} vis={mean_vis:4.2f} okFr={valid_pct:5.1f}% gap={long_gap:4d} "
        f"p5={p5:6.1f} p50={p50:6.1f} p95={p95:6.1f} span={span:5.1f} "
        f"upE={g('up_enter'):6.0f} upX={g('up_exit'):6.0f} "
        f"dnE={g('down_enter'):6.0f} dnX={g('down_exit'):6.0f} "
        f"reps={len(data['rep_meta']):3d}"
    )


def _runs(mask) -> list[int]:
    """Lengths of consecutive False runs in a boolean mask."""
    out: list[int] = []
    cur = 0
    for v in mask:
        if v:
            cur += 1
        else:
            if cur:
                out.append(cur)
                cur = 0
    if cur:
        out.append(cur)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--processed-dir", default="ml/data/processed")
    ap.add_argument("--all", action="store_true", help="audit every clip")
    ap.add_argument("--replay", action="store_true", help="re-run segment_reps")
    ap.add_argument("clips", nargs="*", default=None)
    args = ap.parse_args()

    if args.all:
        paths = sorted(glob.glob(os.path.join(args.processed_dir, "*.npz")))
    else:
        keys = args.clips or DEFAULT_PROBES
        paths = [os.path.join(args.processed_dir, f"{k}.npz") for k in keys]

    print(f"MIN_REP_SECONDS={MIN_REP_SECONDS}  MAX_REP_SECONDS={MAX_REP_SECONDS}")
    print()
    zero = 0
    for p in paths:
        line = analyse(p)
        print(line)
        if "reps=  0" in line:
            zero += 1

    if args.all:
        print()
        print(f"clips={len(paths)}  zero={zero}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
