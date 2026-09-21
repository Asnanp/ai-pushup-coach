"""
scripts/extract_pose_features.py

Agent 10 — POSE EXTRACTION ENGINEER

Processes every dataset video: sample frames -> MediaPipe pose -> per-frame
features -> rep segmentation -> per-rep aggregated feature vectors.
Results are cached to disk so training never re-decodes video.

Outputs (per video):
    ml/data/processed/<quality>_<view>_subject_<id>.npz
        frames        (N, F)  float32  per-frame features
        rep_vectors   (R, 37) float32  one row per detected rep
        rep_meta      (R, K)  float32  [start_frame, end_frame, min_elbow, max_elbow, duration]
        label         0=good 1=bad
        view_idx      0=front 1=side 2=diagonal

Run:
    python ml/scripts/extract_pose_features.py
    python ml/scripts/extract_pose_features.py --limit 5 --workers 1
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import traceback
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np

SCRIPT_DIR = Path(__file__).resolve().parent
ML_DIR = SCRIPT_DIR.parent
PROJECT_DIR = ML_DIR.parent
REPO_ROOT = PROJECT_DIR.parent
sys.path.insert(0, str(ML_DIR))

from src.features import (  # noqa: E402
    FEATURE_NAMES,
    FEATURE_SPEC_VERSION,
    Landmark,
    N_FEATURES,
    extract_frame_features,
)
from src.rep_segmenter import segment_reps  # noqa: E402

PROCESSED_DIR = ML_DIR / "data" / "processed"
MANIFEST_PATH = ML_DIR / "data" / "dataset_manifest.csv"

# Pose detection settings. The dataset is 15 FPS, so we process every frame —
# downsampling further would leave too few samples per rep phase.
POSE_MODEL_COMPLEXITY = 1
MIN_DETECTION_CONFIDENCE = 0.5
MIN_TRACKING_CONFIDENCE = 0.5

VIEW_IDX = {"front": 0, "side": 1, "diagonal": 2}

# Per-frame feature column order for the cached array.
FRAME_COLUMNS = [
    "elbow_angle",
    "elbow_angle_opposite",
    "shoulder_angle",
    "hip_angle",
    "knee_angle",
    "ankle_angle",
    "body_line_deviation",
    "shoulder_hip_ankle_angle",
    "torso_slope",
    "hip_height_rel",
    "shoulder_height_rel",
    "shoulder_elbow_height_delta",
    "shoulder_ankle_height_delta",
    "mean_visibility",
    "min_visibility",
    "jitter",
    "valid",
]


def _quiet_mediapipe() -> None:
    """MediaPipe/absl spam the console; keep stderr readable."""
    os.environ.setdefault("GLOG_minloglevel", "3")
    os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
    try:
        import absl.logging  # type: ignore

        absl.logging.set_verbosity("error")
    except Exception:  # noqa: BLE001
        pass


def process_video(row: dict) -> dict:
    """Extract features from one video. Runs in a worker process."""
    _quiet_mediapipe()
    import cv2  # imported here so each worker gets its own copy
    from mediapipe.python.solutions import pose as mp_pose

    video_path = REPO_ROOT / row["path"]
    stem = f"{row['quality']}_{row['view']}_subject_{row['subject']}"
    out_path = PROCESSED_DIR / f"{stem}.npz"

    result = {
        "stem": stem,
        "ok": False,
        "n_frames": 0,
        "n_rep_windows": 0,
        "error": "",
        "quality": row["quality"],
        "view": row["view"],
        "subject": row["subject"],
    }

    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        result["error"] = "cv2 could not open video"
        return result

    src_fps = cap.get(cv2.CAP_PROP_FPS) or 15.0
    dt = 1.0 / src_fps if src_fps > 0 else 1.0 / 15.0

    frame_features: list[list[float]] = []
    frame_times: list[float] = []
    raw_frames: list = []  # keep FrameFeatures objects for rep aggregation
    prev_norm = None
    current_side: str | None = None
    frame_idx = 0

    pose = mp_pose.Pose(
        static_image_mode=False,
        model_complexity=POSE_MODEL_COMPLEXITY,
        smooth_landmarks=True,
        min_detection_confidence=MIN_DETECTION_CONFIDENCE,
        min_tracking_confidence=MIN_TRACKING_CONFIDENCE,
    )

    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break

            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            rgb.flags.writeable = False
            res = pose.process(rgb)

            if res.pose_landmarks is None:
                # Emit an invalid frame so the rep window keeps its time base
                frame_features.append([np.nan] * (len(FRAME_COLUMNS) - 1) + [0.0])
                frame_times.append(frame_idx * dt)
                raw_frames.append(None)
                frame_idx += 1
                continue

            lms = [
                Landmark(x=lm.x, y=lm.y, z=lm.z, visibility=lm.visibility)
                for lm in res.pose_landmarks.landmark
            ]

            ff = extract_frame_features(
                lms,
                timestamp=frame_idx * dt,
                current_side=current_side,
                allow_side_switch=True,
                prev_normalized=prev_norm,
            )

            # Side is sticky across the whole clip: switching mid-rep would
            # create a discontinuous elbow-angle signal.
            if ff.valid and ff.side != current_side:
                if current_side is None:
                    current_side = ff.side

            row_vals = [float(getattr(ff, col)) for col in FRAME_COLUMNS[:-1]]
            row_vals.append(1.0 if ff.valid else 0.0)
            frame_features.append(row_vals)
            frame_times.append(frame_idx * dt)
            raw_frames.append(ff)

            frame_idx += 1
    finally:
        pose.close()
        cap.release()

    if not frame_features:
        result["error"] = "no frames decoded"
        return result

    arr = np.asarray(frame_features, dtype=np.float32)
    times = np.asarray(frame_times, dtype=np.float32)

    # ---- rep segmentation on the elbow-angle signal ----
    elbow_col = FRAME_COLUMNS.index("elbow_angle")
    elbow_series = arr[:, elbow_col].astype(np.float64)

    # Smoothing + calibration happen inside segment_reps, matching the live
    # pipeline order (docs/FEATURE_SCHEMA.md, ml/src/rep_segmenter.py).
    events, windows, track_quality = segment_reps(
        elbow_series, times.astype(np.float64), view=row["view"]
    )

    # ---- aggregate each rep window into the 37-vector ----
    from src.features import aggregate_rep_window, retime_window

    rep_vectors: list[np.ndarray] = []
    rep_meta: list[list[float]] = []

    for (start_i, end_i) in windows:
        window = [
            raw_frames[i]
            for i in range(start_i, end_i + 1)
            if 0 <= i < len(raw_frames) and raw_frames[i] is not None
        ]
        if not window:
            continue

        # Re-time the window so the aggregation sees t=0 at rep start.
        #
        # This MUST operate on copies. `window` holds references to the shared
        # `raw_frames` objects, and consecutive windows overlap by one frame
        # ([s, e] then [e, ...]). Mutating in place therefore (a) accumulates
        # across reps and (b) shifts the shared boundary frame twice while its
        # neighbours shift once. The offset stops being uniform inside the
        # window, and since rep_duration_s is t[-1] - t[0] with t[0] being the
        # doubly-shifted frame, every duration after the first rep in a clip was
        # wrong -- and the corrupted dt also poisoned every velocity feature.
        # Copy-based re-timing: see ml/src/features.py::retime_window. Never
        # mutate these in place -- the objects are shared across windows.
        re_timed = retime_window(window)

        vec, raw = aggregate_rep_window(re_timed, total_frames_in_window=end_i - start_i + 1)
        if not np.isfinite(vec).any():
            continue

        rep_vectors.append(vec)
        rep_meta.append(
            [
                float(start_i),
                float(end_i),
                raw.get("min_elbow_angle_deg", np.nan),
                raw.get("elbow_angle_deg_max", np.nan),
                raw.get("rep_duration_s", np.nan),
            ]
        )

    label = 0 if row["quality"] == "good" else 1

    np.savez_compressed(
        out_path,
        frames=arr,
        frame_times=times,
        frame_columns=np.array(FRAME_COLUMNS),
        rep_vectors=np.asarray(rep_vectors, dtype=np.float32).reshape(-1, N_FEATURES)
        if rep_vectors
        else np.zeros((0, N_FEATURES), dtype=np.float32),
        rep_meta=np.asarray(rep_meta, dtype=np.float32).reshape(-1, 5)
        if rep_meta
        else np.zeros((0, 5), dtype=np.float32),
        label=np.int32(label),
        view_idx=np.int32(VIEW_IDX[row["view"]]),
        quality=np.array(row["quality"]),
        view=np.array(row["view"]),
        subject=np.array(row["subject"]),
        feature_names=np.array(FEATURE_NAMES),
        feature_spec_version=np.int32(FEATURE_SPEC_VERSION),
        fps=np.float32(src_fps),
        # Tracking verdict. A clip with zero reps has two very different
        # meanings -- "the subject was not doing push-ups" and "MediaPipe lost
        # the arm". Only the first is a usable training signal. Persisting the
        # verdict lets the trainer exclude untracked clips explicitly instead of
        # silently treating a tracking failure as a hard negative example.
        track_quality_reason=np.array(str(track_quality.get("reason", "unknown"))),
        track_quality_tracked=np.bool_(track_quality.get("tracked", False)),
        track_quality_rom=np.float32(track_quality.get("rom", np.nan)),
        track_quality_masked_fraction=np.float32(
            float(np.mean(~np.isfinite(elbow_series))) if elbow_series.size else np.nan
        ),
    )

    result["ok"] = True
    result["n_frames"] = int(arr.shape[0])
    result["n_rep_windows"] = len(rep_vectors)
    return result


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="process only N videos")
    ap.add_argument("--workers", type=int, default=0, help="0 = auto")
    ap.add_argument("--force", action="store_true", help="recompute existing outputs")
    args = ap.parse_args()

    import csv

    if not MANIFEST_PATH.exists():
        print("Manifest missing. Run inspect_dataset.py first.", file=sys.stderr)
        return 1

    with MANIFEST_PATH.open(encoding="utf-8") as fh:
        rows = [r for r in csv.DictReader(fh) if r["readable"] == "True"]

    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)

    if not args.force:
        before = len(rows)
        rows = [
            r
            for r in rows
            if not (PROCESSED_DIR / f"{r['quality']}_{r['view']}_subject_{r['subject']}.npz").exists()
        ]
        skipped = before - len(rows)
        if skipped:
            print(f"Skipping {skipped} already-processed videos (use --force to redo).")

    if args.limit:
        rows = rows[: args.limit]

    if not rows:
        print("Nothing to process.")
        return 0

    workers = args.workers or max(1, (os.cpu_count() or 4) - 1)
    print(f"Processing {len(rows)} videos with {workers} workers...")
    print()

    t_start = time.time()
    done = 0
    failed: list[dict] = []
    total_reps = 0

    with ProcessPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(process_video, row): row for row in rows}
        for fut in as_completed(futures):
            row = futures[fut]
            done += 1
            try:
                res = fut.result()
            except Exception:  # noqa: BLE001
                res = {
                    "stem": row["filename"],
                    "ok": False,
                    "error": traceback.format_exc()[-300:],
                }

            if res.get("ok"):
                total_reps += res.get("n_rep_windows", 0)
                status = f"ok  frames={res['n_frames']:4d} reps={res['n_rep_windows']:3d}"
            else:
                failed.append(res)
                status = f"FAIL {res.get('error', '')[:80]}"

            elapsed = time.time() - t_start
            rate = done / elapsed if elapsed > 0 else 0
            eta = (len(rows) - done) / rate if rate > 0 else 0
            print(
                f"[{done:3d}/{len(rows)}] {res.get('stem', '?')[:46]:46s} {status}  "
                f"eta {eta:5.0f}s"
            )

    elapsed = time.time() - t_start
    print()
    print("=" * 62)
    print(f"  processed      : {done - len(failed)}/{len(rows)}")
    print(f"  failed         : {len(failed)}")
    print(f"  rep windows    : {total_reps}")
    print(f"  total time     : {elapsed:.1f}s  ({elapsed / max(done, 1):.2f}s/video)")
    print(f"  output dir     : {PROCESSED_DIR}")
    if failed:
        print()
        print("  Failures:")
        for f in failed[:10]:
            print(f"    {f.get('stem')}: {f.get('error')}")

    summary_path = ML_DIR / "data" / "extraction_summary.json"
    summary_path.write_text(
        json.dumps(
            {
                "processed": done - len(failed),
                "failed": len(failed),
                "total_rep_windows": total_reps,
                "elapsed_s": round(elapsed, 2),
                "failures": failed,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    return 0 if not failed else 2


if __name__ == "__main__":
    raise SystemExit(main())
