"""Audit rep segmentation across the whole dataset.

Reports, per clip, the rep count produced by the current segmenter alongside
the tracking-quality verdict, so silent zero-rep clips are visible.

Usage:
    python ml/scripts/audit_rep_counts.py
    python ml/scripts/audit_rep_counts.py --replay   # re-run segmentation
"""
from __future__ import annotations

import argparse
import csv
import os
import sys
from collections import defaultdict

import numpy as np

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from ml.src.rep_segmenter import segment_reps  # noqa: E402

MANIFEST = "ml/data/dataset_manifest.csv"
PROCESSED = "ml/data/processed"


def clip_key(row: dict) -> str:
    stem = os.path.splitext(row["filename"])[0]
    return f"{row['quality']}_{row['view']}_{stem.split('_push_up')[0]}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--processed-dir", default=PROCESSED)
    ap.add_argument("--manifest", default=MANIFEST)
    ap.add_argument("--fps", type=float, default=15.0)
    args = ap.parse_args()

    meta: dict[str, dict] = {}
    with open(args.manifest, newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            meta[clip_key(row)] = row

    rows = []
    for key, row in sorted(meta.items()):
        path = os.path.join(args.processed_dir, f"{key}.npz")
        if not os.path.exists(path):
            rows.append((key, row, None, None, "missing"))
            continue

        data = np.load(path, allow_pickle=True)
        cols = [str(c) for c in data["frame_columns"]]
        frames = np.asarray(data["frames"], dtype=np.float64)
        times = np.asarray(data["frame_times"], dtype=np.float64)

        elbow = frames[:, cols.index("elbow_angle")].copy()
        valid = frames[:, cols.index("valid")] > 0.5
        elbow = np.where(valid, elbow, np.nan)

        reps, _windows, quality = segment_reps(elbow, times, view=row["view"])
        rows.append((key, row, len(reps), quality, "ok"))

    # ---- summary by group -------------------------------------------------
    groups: dict[tuple[str, str], list] = defaultdict(list)
    for key, row, count, quality, status in rows:
        groups[(row["quality"], row["view"])].append((key, count, quality, status))

    print(f"{'group':18s} {'clips':>5s} {'reps':>5s} {'zero':>5s} {'untracked':>9s} {'median':>7s}")
    print("-" * 62)
    total_zero = 0
    total_untracked = 0
    for (quality, view), items in sorted(groups.items()):
        counts = [c for _k, c, _q, _s in items if c is not None]
        zeros = sum(1 for c in counts if c == 0)
        untracked = sum(1 for _k, _c, q, _s in items if q and not q.get("tracked", True))
        total_zero += zeros
        total_untracked += untracked
        med = float(np.median(counts)) if counts else 0.0
        print(
            f"{quality + '/' + view:18s} {len(items):5d} {sum(counts):5d} "
            f"{zeros:5d} {untracked:9d} {med:7.1f}"
        )
    print("-" * 62)

    all_counts = [c for _k, _r, c, _q, _s in rows if c is not None]
    print(f"{'ALL':18s} {len(rows):5d} {sum(all_counts):5d} {total_zero:5d} {total_untracked:9d}")

    # ---- detail on zero-rep clips ----------------------------------------
    print()
    print("Clips yielding zero reps (with tracking verdict):")
    any_zero = False
    for key, row, count, quality, status in rows:
        if count == 0:
            any_zero = True
            reason = (quality or {}).get("reason", "n/a")
            rom = (quality or {}).get("rom", float("nan"))
            print(f"  {key:34s} tracked={str((quality or {}).get('tracked')):5s} "
                  f"rom={rom:6.1f} reason={reason}")
    if not any_zero:
        print("  (none)")

    # ---- implausible durations -------------------------------------------
    print()
    print("Clips containing suspiciously long reps (>6s):")
    any_long = False
    for key, row, count, quality, status in rows:
        if not count:
            continue
        path = os.path.join(args.processed_dir, f"{key}.npz")
        data = np.load(path, allow_pickle=True)
        cols = [str(c) for c in data["frame_columns"]]
        frames = np.asarray(data["frames"], dtype=np.float64)
        times = np.asarray(data["frame_times"], dtype=np.float64)
        elbow = np.where(frames[:, cols.index("valid")] > 0.5,
                         frames[:, cols.index("elbow_angle")], np.nan)
        reps, _w, _q = segment_reps(elbow, times, view=row["view"])
        longest = max((r.duration_s for r in reps), default=0.0)
        if longest > 6.0:
            any_long = True
            print(f"  {key:34s} reps={count:3d} longest={longest:5.1f}s")
    if not any_long:
        print("  (none)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
