"""
scripts/calibrate_thresholds.py

Agent 8 — REP COUNTING ENGINE (calibration tooling)

Sweeps the rep-state-machine parameters against a subset of real clips and
reports per-clip rep counts, so the thresholds in src/rep_segmenter.py are
chosen from measurements rather than guessed.

This is a DIAGNOSTIC tool. It does not modify the model. Its purpose is to
answer: "do our thresholds produce a physiologically plausible rep count on
real data, across subjects and views?"

A push-up at a normal training pace takes roughly 1.5-4 seconds. A 25-35s clip
should therefore contain roughly 6-20 reps. Counts far outside that band
indicate the thresholds are wrong.

Usage:
    python ml/scripts/calibrate_thresholds.py
    python ml/scripts/calibrate_thresholds.py --view side
    python ml/scripts/calibrate_thresholds.py --sweep
"""

from __future__ import annotations

import argparse
import glob
import os
import sys
from pathlib import Path

import numpy as np

SCRIPT_DIR = Path(__file__).resolve().parent
ML_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(ML_DIR))

from src.rep_segmenter import (  # noqa: E402
    RepStateMachine,
    calibrate_thresholds,
    smooth_signal,
)

PROCESSED_DIR = ML_DIR / "data" / "processed"

# Physiological plausibility band for a push-up rep, in seconds.
PLAUSIBLE_MIN_S = 0.7
PLAUSIBLE_MAX_S = 6.0
# Expected reps for a ~25-35s training clip.
EXPECTED_MIN_REPS = 5
EXPECTED_MAX_REPS = 25


def load_clip(path: Path) -> tuple[np.ndarray, np.ndarray, str]:
    d = np.load(path, allow_pickle=True)
    cols = list(d["frame_columns"])
    elbow = d["frames"][:, cols.index("elbow_angle")].astype(float)
    ts = d["frame_times"].astype(float)
    view = str(d["view"][()]) if d["view"].shape == () else str(d["view"])
    return elbow, ts, view


def run_clip(
    elbow: np.ndarray,
    ts: np.ndarray,
    up_fraction: float | None = None,
    down_fraction: float | None = None,
) -> tuple[list, dict]:
    """Segment one clip, optionally overriding the autorange fractions."""
    import src.rep_segmenter as rs

    orig_up, orig_down = rs.UP_FRACTION, rs.DOWN_FRACTION
    if up_fraction is not None:
        rs.UP_FRACTION = up_fraction
    if down_fraction is not None:
        rs.DOWN_FRACTION = down_fraction
    try:
        smoothed = smooth_signal(elbow)
        cal = calibrate_thresholds(smoothed)
        fsm = RepStateMachine(
            up_enter=cal["up_enter"],
            up_exit=cal["up_exit"],
            down_enter=cal["down_enter"],
            down_exit=cal["down_exit"],
        )
        for i, (a, t) in enumerate(zip(smoothed, ts)):
            if np.isfinite(a):
                fsm.feed(float(a), float(t), i)
        return fsm.reps, cal
    finally:
        rs.UP_FRACTION, rs.DOWN_FRACTION = orig_up, orig_down


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--view", default=None, help="filter to front|side|diagonal")
    ap.add_argument("--quality", default=None, help="filter to good|bad")
    ap.add_argument("--sweep", action="store_true", help="sweep UP_FRACTION")
    args = ap.parse_args()

    files = sorted(Path(p) for p in glob.glob(str(PROCESSED_DIR / "*.npz")))
    if args.view:
        files = [f for f in files if f"_{args.view}_" in f.name]
    if args.quality:
        files = [f for f in files if f.name.startswith(f"{args.quality}_")]

    if not files:
        print("No processed clips found. Run extract_pose_features.py first.")
        return 1

    if args.sweep:
        print("Sweeping UP_FRACTION (reps per clip)\n")
        header = f"{'clip':<38}" + "".join(f"u={u:<5.2f}" for u in [0.60, 0.65, 0.70, 0.75, 0.80])
        print(header)
        print("-" * len(header))
        for f in files:
            elbow, ts, _ = load_clip(f)
            row = f"{f.stem[:37]:<38}"
            for u in [0.60, 0.65, 0.70, 0.75, 0.80]:
                reps, _ = run_clip(elbow, ts, up_fraction=u)
                row += f"{len(reps):<9d}"
            print(row)
        print()
        return 0

    # -------- per-clip report --------
    print(f"{'clip':<40} {'calib':<6} {'up/dn':<11} {'reps':<5} {'durations':<16} {'flag'}")
    print("-" * 100)

    flags = 0
    for f in files:
        elbow, ts, view = load_clip(f)
        reps, cal = run_clip(elbow, ts)
        durs = [r.duration_s for r in reps]

        if durs:
            dur_txt = f"{min(durs):.1f}-{max(durs):.1f}s"
            bad_dur = [d for d in durs if d < PLAUSIBLE_MIN_S or d > PLAUSIBLE_MAX_S]
            flag = ""
            if len(reps) < EXPECTED_MIN_REPS:
                flag = "LOW COUNT"
            elif len(reps) > EXPECTED_MAX_REPS:
                flag = "HIGH COUNT"
            elif bad_dur:
                flag = f"{len(bad_dur)} odd duration"
            if flag:
                flags += 1
        else:
            dur_txt = "-"
            flag = "NO REPS"
            flags += 1

        print(
            f"{f.stem[:39]:<40} {str(cal['calibrated']):<6} "
            f"{cal['up_enter']:4.0f}/{cal['down_enter']:<5.0f} {len(reps):<5} {dur_txt:<16} {flag}"
        )

    print()
    print(f"  clips: {len(files)}   flagged: {flags}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
