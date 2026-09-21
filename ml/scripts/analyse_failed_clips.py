"""
ml/scripts/analyse_failed_clips.py

Agent 6 — DATASET RECOVERY ENGINEER

Analyzes all 25 clips that currently yield zero rep windows in V1.
For every clip:
- computes pose confidence, elbow trace, left/right elbow traces
- identifies detected extrema and tracking quality
- categorizes rejection and segmentation reasons
- determines whether the failure is recoverable
- produces ml/reports/failed_clip_analysis.json
- produces ml/data/manual_rep_boundaries.json for recoverable train/dev clips
"""

import glob
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

import numpy as np

PROCESSED_DIR = Path("ml/data/processed")
REPORTS_DIR = Path("ml/reports")
DATA_DIR = Path("ml/data")
PLOTS_DIR = Path("ml/reports/failed_clip_plots")

REPORTS_DIR.mkdir(parents=True, exist_ok=True)
PLOTS_DIR.mkdir(parents=True, exist_ok=True)

# Held-out test subjects: MUST REMAIN UNTOUCHED for model training/tuning
TEST_SUBJECTS = {"010", "016", "023", "024"}

def find_zero_clips():
    zero_clips = []
    for p in sorted(PROCESSED_DIR.glob("*.npz")):
        data = np.load(p, allow_pickle=True)
        reps = data["rep_vectors"]
        if len(reps) == 0:
            zero_clips.append((p.stem, p))
    return zero_clips

def analyze_clip(stem, path):
    data = np.load(path, allow_pickle=True)
    frames = data["frames"] # (N, 17)
    frame_cols = list(data["frame_columns"])
    frame_times = data["frame_times"]
    label = str(data["label"]) if "label" in data else ("good" if "good" in stem else "bad")
    quality = str(data["quality"]) if "quality" in data else label
    view = str(data["view"]) if "view" in data else ("front" if "front" in stem else ("side" if "side" in stem else "diagonal"))
    subject = str(data["subject"]) if "subject" in data else stem.split("_")[-1]
    
    col_map = {col: i for i, col in enumerate(frame_cols)}
    
    elbow_angle = frames[:, col_map["elbow_angle"]] if "elbow_angle" in col_map else np.full(len(frames), np.nan)
    elbow_opp = frames[:, col_map["elbow_angle_opposite"]] if "elbow_angle_opposite" in col_map else np.full(len(frames), np.nan)
    mean_vis = frames[:, col_map["mean_visibility"]] if "mean_visibility" in col_map else np.full(len(frames), np.nan)
    min_vis = frames[:, col_map["min_visibility"]] if "min_visibility" in col_map else np.full(len(frames), np.nan)
    valid_mask = frames[:, col_map["valid"]].astype(bool) if "valid" in col_map else np.ones(len(frames), dtype=bool)
    
    finite_elbow = elbow_angle[np.isfinite(elbow_angle)]
    rom = float(np.percentile(finite_elbow, 95) - np.percentile(finite_elbow, 5)) if len(finite_elbow) >= 10 else 0.0
    median_elbow = float(np.median(finite_elbow)) if len(finite_elbow) else 0.0
    min_elbow = float(np.min(finite_elbow)) if len(finite_elbow) else 0.0
    max_elbow = float(np.max(finite_elbow)) if len(finite_elbow) else 0.0
    
    track_reason = str(data.get("track_quality_reason", "unknown"))
    n_frames = len(frames)
    valid_frames = int(np.sum(valid_mask))
    mean_pose_conf = float(np.nanmean(mean_vis)) if len(mean_vis) else 0.0
    
    # Detect extrema in elbow angle
    minima_indices = []
    maxima_indices = []
    if len(finite_elbow) >= 15:
        from scipy.signal import find_peaks
        # Smooth for peak finding
        from ml.src.rep_segmenter import smooth_signal
        sm = smooth_signal(elbow_angle)
        peaks, _ = find_peaks(sm, distance=15, prominence=10)
        valleys, _ = find_peaks(-sm, distance=15, prominence=10)
        maxima_indices = [int(p) for p in peaks]
        minima_indices = [int(v) for v in valleys]
    
    # Categorization logic
    category = "SEGMENTATION_FAILURE"
    recoverable = False
    rejection_reason = ""
    candidate_reps = []
    
    if n_frames < 30 or valid_frames < 15:
        category = "POSE_FAILURE"
        rejection_reason = f"Insufficient frames ({n_frames} total, {valid_frames} valid)"
        recoverable = False
    elif "frozen_signal" in track_reason:
        category = "POSE_FAILURE"
        rejection_reason = "Frozen tracking: pose landmarks did not move with body"
        recoverable = False
    elif rom < 15.0:
        category = "UNUSUAL_BAD_FORM"
        rejection_reason = f"Negligible movement excursion (ROM = {rom:.1f}° < 15°)"
        recoverable = False
    elif "unstable_signal" in track_reason:
        # Check if genuine peaks/valleys exist
        if len(valleys) >= 1 and rom >= 20.0:
            category = "SEGMENTATION_FAILURE"
            rejection_reason = f"Flagged unstable_signal due to reversal_fraction but genuine ROM ({rom:.1f}°) and {len(valleys)} valleys exist"
            recoverable = True
        else:
            category = "UNUSUAL_BAD_FORM"
            rejection_reason = f"High noise/irregular motion with weak periodic structure (ROM={rom:.1f}°)"
            recoverable = False
    elif track_reason == "ok":
        # Tracking was declared OK, but segmenter produced 0 reps
        category = "CALIBRATION_FAILURE"
        rejection_reason = f"Preamble calibration set thresholds outside observed descent (min={min_elbow:.1f}°, max={max_elbow:.1f}°, ROM={rom:.1f}°)"
        recoverable = len(valleys) >= 1
    
    # Construct candidate rep boundaries if recoverable
    if recoverable and len(valleys) >= 1:
        # Build rep boundaries from peaks flanking valleys
        for v in valleys:
            # find preceding peak
            prec_peaks = [p for p in peaks if p < v]
            succ_peaks = [p for p in peaks if p > v]
            if prec_peaks and succ_peaks:
                start_f = int(prec_peaks[-1])
                end_f = int(succ_peaks[0])
                if end_f - start_f >= 10 and (end_f - start_f) <= 150:
                    candidate_reps.append([start_f, end_f])
        # Deduplicate overlapping rep intervals
        cleaned = []
        for r in candidate_reps:
            if not cleaned or r[0] >= cleaned[-1][1] - 5:
                cleaned.append(r)
        candidate_reps = cleaned
        if not candidate_reps:
            recoverable = False

    return {
        "clip_id": stem,
        "subject": subject,
        "label": label,
        "quality": quality,
        "view": view,
        "is_held_out_test": subject in TEST_SUBJECTS,
        "total_frames": n_frames,
        "valid_frames": valid_frames,
        "mean_pose_confidence": round(mean_pose_conf, 3),
        "observed_rom_deg": round(rom, 1),
        "min_elbow_angle": round(min_elbow, 1),
        "max_elbow_angle": round(max_elbow, 1),
        "tracking_quality_reason": track_reason,
        "category": category,
        "rejection_reason": rejection_reason,
        "detected_peaks": maxima_indices,
        "detected_valleys": minima_indices,
        "recoverable": recoverable,
        "candidate_rep_boundaries": candidate_reps,
    }

def main():
    zero_clips = find_zero_clips()
    print(f"Analyzing {len(zero_clips)} zero-rep clips...")
    
    results = []
    manual_boundaries = {}
    
    for stem, path in zero_clips:
        res = analyze_clip(stem, path)
        results.append(res)
        
        # Save manual rep boundaries for recoverable clips
        # Note: Test set boundaries can only be used for ground-truth evaluation, not training
        if res["recoverable"] and res["candidate_rep_boundaries"]:
            manual_boundaries[stem] = {
                "subject": res["subject"],
                "view": res["view"],
                "quality": res["quality"],
                "is_held_out_test": res["is_held_out_test"],
                "boundaries": res["candidate_rep_boundaries"],
                "provenance": "scipy_peak_valley_recovery_agent_6",
            }
    
    # Summary statistics
    categories = {}
    recoverable_count = 0
    recoverable_train_count = 0
    recoverable_test_count = 0
    
    for r in results:
        cat = r["category"]
        categories[cat] = categories.get(cat, 0) + 1
        if r["recoverable"]:
            recoverable_count += 1
            if r["is_held_out_test"]:
                recoverable_test_count += 1
            else:
                recoverable_train_count += 1
                
    summary = {
        "total_zero_clips": len(results),
        "category_breakdown": categories,
        "recoverable_clips": recoverable_count,
        "recoverable_train_dev_clips": recoverable_train_count,
        "recoverable_held_out_test_clips": recoverable_test_count,
        "clips": results,
    }
    
    out_json = REPORTS_DIR / "failed_clip_analysis.json"
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)
    print(f"Wrote analysis report to {out_json}")
    
    out_boundaries = DATA_DIR / "manual_rep_boundaries.json"
    with open(out_boundaries, "w", encoding="utf-8") as f:
        json.dump(manual_boundaries, f, indent=2)
    print(f"Wrote recoverable rep boundaries to {out_boundaries} ({len(manual_boundaries)} clips recovered)")

if __name__ == "__main__":
    main()
