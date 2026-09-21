"""ml/scripts/make_v2_replay_fixture.py

Build an authoritative multi-clip replay fixture from all processed dataset clips
in ml/data/processed/*.npz.

This fixture feeds the TypeScript RepCounter replay runner to produce
ml/reports/v2_rep_replay.json, reporting ground-truth vs counted reps broken down
by view (front, side, diagonal), quality (good, bad), and subject.
"""

from __future__ import annotations

import json
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
PROCESSED = ROOT / "ml" / "data" / "processed"
OUT = ROOT / "tests" / "fixtures" / "v2_rep_replay_fixture.json"


def _num(v: float):
    v = float(v)
    return "NaN" if not np.isfinite(v) else round(v, 4)


def main():
    if not PROCESSED.exists():
        print(f"Error: {PROCESSED} does not exist.")
        return 1

    npz_files = sorted(list(PROCESSED.glob("*.npz")))
    cases = []

    for path in npz_files:
        d = np.load(path, allow_pickle=True)
        frames = d["frames"]
        times = d["frame_times"]
        columns = [str(c) for c in d["frame_columns"]]
        rep_meta = d["rep_meta"]

        parts = path.stem.split("_")
        quality = parts[0]
        view = parts[1]
        subject = parts[-1]

        elbow_idx = columns.index("elbow_angle")
        opp_idx = columns.index("elbow_angle_opposite")
        sh_idx = columns.index("shoulder_height_rel")
        hip_idx = columns.index("hip_height_rel")
        val_idx = columns.index("valid")

        expected_windows = [[int(r[0]), int(r[1])] for r in rep_meta]

        cases.append({
            "name": path.stem,
            "quality": quality,
            "view": view,
            "subject": subject,
            "n_frames": int(len(frames)),
            "fps": float(d["fps"]),
            "frame_times": [_num(t) for t in times],
            "elbow_angles": [_num(frames[i, elbow_idx]) for i in range(len(frames))],
            "elbow_angles_opposite": [_num(frames[i, opp_idx]) for i in range(len(frames))],
            "shoulder_height_rel": [_num(frames[i, sh_idx]) for i in range(len(frames))],
            "hip_height_rel": [_num(frames[i, hip_idx]) for i in range(len(frames))],
            "valid": [bool(frames[i, val_idx] == 1.0) for i in range(len(frames))],
            "expected_n_reps": int(len(expected_windows)),
            "expected_windows": expected_windows,
        })

    payload = {
        "source": "ml/data/processed/*.npz",
        "description": "Full dataset rep replay fixture for TypeScript RepCounter verification",
        "total_clips": len(cases),
        "total_ground_truth_reps": sum(c["expected_n_reps"] for c in cases),
        "cases": cases,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, allow_nan=False), encoding="utf-8")

    size_mb = OUT.stat().st_size / 1_000_000
    print(f"Wrote {OUT} ({size_mb:.2f} MB, {len(cases)} clips, {payload['total_ground_truth_reps']} ground truth reps)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
