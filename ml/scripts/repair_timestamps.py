"""ml/scripts/repair_timestamps.py

Recompute the cached rep-window features with CORRECT re-timing.

Background
----------
``extract_pose_features.py`` used to re-time each rep window by mutating
``FrameFeatures.timestamp`` in place::

    t0 = window[0].timestamp
    for w in window:
        w.timestamp = w.timestamp - t0

``window`` holds references into the per-clip ``raw_frames`` list, and
consecutive windows overlap by exactly one frame (``[s, e]`` then ``[e, ...]``).
So the shift accumulated across reps, and the shared boundary frame was shifted
twice while its neighbours shifted once. The offset stopped being uniform within
a window, which corrupts ``rep_duration_s`` (``t[-1] - t[0]``, where ``t[0]``
is the doubly-shifted frame) and every velocity feature, because ``dt`` across
that boundary is wrong too.

``tests/prove_timestamp_bug.py`` demonstrates this: replaying the buggy path
reproduces 6910/7336 of the stored timing features, the correct path only
4762/7336.

The bug is fixed at source. This script repairs the already-extracted
``ml/data/processed/*.npz`` files WITHOUT re-running MediaPipe -- the cached
per-frame features are intact, only the per-rep aggregation was wrong, and that
is cheap to redo.

Safety
------
Originals are copied to ``ml/data/processed_pre_repair/`` first (3 MB, trivial)
and each file is written via a temp file + atomic replace. Re-running is
idempotent: a repaired file produces the same output again.

Usage::

    python ml/scripts/repair_timestamps.py            # repair all
    python ml/scripts/repair_timestamps.py --dry-run  # report only
"""

from __future__ import annotations

import argparse
import shutil
import sys
from dataclasses import replace
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src.features import (  # noqa: E402
    FEATURE_NAMES,
    N_FEATURES,
    FrameFeatures,
    aggregate_rep_window,
)

PROCESSED = ROOT / "data" / "processed"
BACKUP = ROOT / "data" / "processed_pre_repair"

FIELD_MAP = {
    "elbow_angle": "elbow_angle",
    "elbow_angle_opposite": "elbow_angle_opposite",
    "shoulder_angle": "shoulder_angle",
    "hip_angle": "hip_angle",
    "knee_angle": "knee_angle",
    "ankle_angle": "ankle_angle",
    "body_line_deviation": "body_line_deviation",
    "shoulder_hip_ankle_angle": "shoulder_hip_ankle_angle",
    "torso_slope": "torso_slope",
    "hip_height_rel": "hip_height_rel",
    "shoulder_height_rel": "shoulder_height_rel",
    "shoulder_elbow_height_delta": "shoulder_elbow_height_delta",
    "shoulder_ankle_height_delta": "shoulder_ankle_height_delta",
    "mean_visibility": "mean_visibility",
    "min_visibility": "min_visibility",
    "jitter": "jitter",
}

TIMING_FEATURES = [
    "rep_duration_s",
    "descent_duration_s",
    "ascent_duration_s",
    "descent_ascent_ratio",
    "elbow_angular_velocity_max",
    "elbow_angular_velocity_mean",
    "elbow_velocity_down_mean",
    "elbow_velocity_up_mean",
]


def build_frames(arr, columns, times) -> list[FrameFeatures]:
    cols = {str(c): i for i, c in enumerate(columns)}
    out = []
    for i, row in enumerate(arr):
        kw = {attr: float(row[cols[col]]) for col, attr in FIELD_MAP.items()}
        out.append(
            FrameFeatures(
                valid=bool(row[cols["valid"]]) == 1,
                side="left",
                timestamp=float(times[i]),
                **kw,
            )
        )
    return out


def recompute(path: Path) -> dict:
    d = np.load(path, allow_pickle=True)
    columns = [str(c) for c in d["frame_columns"]]
    arr = d["frames"]
    times = d["frame_times"].astype(np.float64)
    windows = [(int(r[0]), int(r[1])) for r in d["rep_meta"]]
    old_vectors = d["rep_vectors"].astype(np.float64)

    all_frames = build_frames(arr, columns, times)
    vectors = []
    meta = []
    for start_i, end_i in windows:
        window = all_frames[start_i : end_i + 1]
        if not window:
            continue
        t0 = window[0].timestamp
        # The fix: re-time on copies, never the shared objects.
        shifted = [replace(w, timestamp=w.timestamp - t0) for w in window]
        vec, raw = aggregate_rep_window(
            shifted, total_frames_in_window=end_i - start_i + 1
        )
        if not np.isfinite(vec).any():
            continue
        vectors.append(vec)
        meta.append(
            [
                float(start_i),
                float(end_i),
                float(raw.get("min_elbow_angle_deg", np.nan)),
                float(raw.get("elbow_angle_deg_max", np.nan)),
                float(raw.get("rep_duration_s", np.nan)),
            ]
        )

    new_vectors = (
        np.asarray(vectors, dtype=np.float32).reshape(-1, N_FEATURES)
        if vectors
        else np.zeros((0, N_FEATURES), dtype=np.float32)
    )
    new_meta = (
        np.asarray(meta, dtype=np.float32).reshape(-1, 5)
        if meta
        else np.zeros((0, 5), dtype=np.float32)
    )
    return {"d": d, "new_vectors": new_vectors, "new_meta": new_meta, "old": old_vectors}


def write_repaired(path: Path, res: dict) -> None:
    d = res["d"]
    # Materialise everything and close the handle before renaming: on Windows an
    # open NpzFile keeps a lock on the target and os.replace fails with EACCES.
    payload = {k: np.asarray(d[k]) for k in d.files}
    d.close()

    payload["rep_vectors"] = res["new_vectors"]
    payload["rep_meta"] = res["new_meta"]

    # Must end in .npz: numpy appends the extension otherwise, and we would
    # then try to rename a file that was never created.
    tmp = path.with_name(path.name + ".tmp.npz")
    np.savez_compressed(tmp, **payload)
    tmp.replace(path)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="report only, write nothing")
    ap.add_argument("--no-backup", action="store_true", help="skip copying originals")
    args = ap.parse_args()

    files = sorted(PROCESSED.glob("*.npz"))
    if not files:
        print(f"error: no .npz in {PROCESSED}")
        return 1

    if not args.dry_run and not args.no_backup:
        BACKUP.mkdir(parents=True, exist_ok=True)
        for f in files:
            shutil.copy2(f, BACKUP / f.name)
        print(f"backed up {len(files)} files -> {BACKUP.relative_to(ROOT)}\n")

    timing_idx = [FEATURE_NAMES.index(n) for n in TIMING_FEATURES]
    changed = total = 0
    worst_by_feature = {n: 0.0 for n in TIMING_FEATURES}

    for path in files:
        res = recompute(path)
        old, new = res["old"], res["new_vectors"].astype(np.float64)
        n = min(old.shape[0], new.shape[0])
        if n == 0:
            continue
        for j, name in zip(timing_idx, TIMING_FEATURES):
            delta = float(np.nanmax(np.abs(old[:n, j] - new[:n, j])))
            worst_by_feature[name] = max(worst_by_feature[name], delta)
        n_changed = int((~np.isclose(old[:n], new[:n], atol=1e-4, equal_nan=True)).any(axis=1).sum())
        changed += n_changed
        total += n
        if not args.dry_run:
            write_repaired(path, res)

    print(f"reps: {total}   changed: {changed} ({100.0 * changed / max(total,1):.1f}%)")
    print(f"files: {len(files)}   {'DRY RUN - nothing written' if args.dry_run else 'repaired'}")
    print("\nworst absolute change per timing feature (over all clips):")
    for name in TIMING_FEATURES:
        print(f"  {name:32s} {worst_by_feature[name]:12.4f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
