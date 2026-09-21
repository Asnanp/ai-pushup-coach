"""Unit tests for the rep counting engine.

These tests encode the specific bugs found while building the dataset pipeline.
Each one would have caught a real, silent failure that degraded training data.

Run:
    pytest tests/test_rep_counter.py -v
"""
from __future__ import annotations

import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from ml.src.rep_segmenter import (  # noqa: E402
    ELBOW_ANGLE_MIN_PLAUSIBLE,
    MAX_REP_SECONDS,
    MIN_REP_SECONDS,
    calibrate_thresholds,
    mask_implausible,
    segment_reps,
    smooth_signal,
    tracking_quality,
)

FPS = 15.0


def make_reps(
    n_reps: int,
    top: float = 168.0,
    bottom: float = 95.0,
    rep_seconds: float = 1.8,
    start_at_top: bool = True,
    fps: float = FPS,
) -> tuple[np.ndarray, np.ndarray]:
    """Synthesise a clean triangle-wave push-up signal."""
    frames_per_rep = max(4, int(round(rep_seconds * fps)))
    angles: list[float] = []
    for _ in range(n_reps):
        for i in range(frames_per_rep):
            frac = i / frames_per_rep
            # top -> bottom -> back toward top
            if frac < 0.5:
                angles.append(top + (bottom - top) * (frac / 0.5))
            else:
                angles.append(bottom + (top - bottom) * ((frac - 0.5) / 0.5))
    if not start_at_top:
        half = frames_per_rep // 2
        angles = angles[half:] + angles[:half]

    arr = np.array(angles, dtype=float)
    times = np.arange(arr.size, dtype=float) / fps
    return arr, times


# --------------------------------------------------------------------------
# Calibration
# --------------------------------------------------------------------------


def test_calibration_finds_sane_thresholds_on_clean_signal():
    angles, _ = make_reps(6)
    cal = calibrate_thresholds(angles)

    assert cal["calibrated"] is True
    assert cal["down_enter"] < cal["down_exit"] < cal["up_exit"] < cal["up_enter"]
    # Thresholds must sit inside the signal, not outside it.
    assert angles.min() - 10 <= cal["down_enter"] <= angles.min() + 20
    assert angles.max() - 20 <= cal["up_enter"] <= angles.max() + 2


def test_thresholds_are_always_reachable():
    """
    Regression: an absolute DOWN clamp once rejected every real rep.

    good_side_subject_004 sweeps 129-177 deg. With DOWN_ENTER_MAX pinned at 120
    the DOWN state was unreachable and the clip yielded zero reps.
    """
    for bottom, top in [(129, 177), (150, 175), (60, 140), (95, 165)]:
        angles, _ = make_reps(5, top=top, bottom=bottom)
        cal = calibrate_thresholds(angles)
        assert cal["down_enter"] >= angles.min() - 5, (bottom, top, cal)
        assert cal["up_enter"] <= angles.max() + 2, (bottom, top, cal)


def test_single_extreme_excursion_does_not_break_calibration():
    """
    Regression: good_diagonal_subject_022.

    The clip oscillates 77-124 deg for most of its length (clean reps) then
    extends to 169 once at the very end. A p95-based band put upEnter at 139,
    above the 122 reached on every real rep, so the FSM never left READY and
    the clip scored zero reps.
    """
    angles, _ = make_reps(10, top=122.0, bottom=80.0, rep_seconds=1.6)
    # One big extension at the end.
    angles = np.concatenate([angles, np.linspace(122, 169, 18)])

    cal = calibrate_thresholds(angles)

    assert cal["calibrated"] is True
    # The threshold has to be reachable by the repeated part of the movement.
    assert cal["up_enter"] <= 130, cal


def test_shallow_reps_still_calibrate():
    """A shallow push-up is a real rep and must not be silently discarded."""
    angles, _ = make_reps(6, top=163.0, bottom=140.0)
    cal = calibrate_thresholds(angles)
    assert cal["calibrated"] is True
    assert cal["up_enter"] > cal["down_enter"]


# --------------------------------------------------------------------------
# Plausibility masking
# --------------------------------------------------------------------------


def test_impossible_elbow_angles_are_masked():
    series = np.array([170.0, 165.0, 12.0, 9.0, 160.0, 179.9])
    masked, frac = mask_implausible(series)

    assert frac == pytest.approx(3 / 6)
    assert np.isfinite(masked[0]) and np.isfinite(masked[1])
    assert not np.isfinite(masked[2]) and not np.isfinite(masked[3])
    assert not np.isfinite(masked[5])  # 179.9 exceeds the ceiling


def test_collapsed_arm_frames_do_not_poison_calibration():
    """
    Regression: bad_diagonal_subject_019 had 32.8% of frames below 25 deg,
    which stretched the band to 10-163 and placed down_enter at 29 -- below
    every real frame, so the clip scored zero reps.
    """
    angles, _ = make_reps(6, top=165.0, bottom=95.0)
    polluted = angles.copy()
    idx = np.arange(0, polluted.size, 3)
    polluted[idx] = 11.0  # collapsed arm every third frame

    clean_cal = calibrate_thresholds(angles)
    polluted_cal = calibrate_thresholds(polluted)

    assert polluted_cal["down_enter"] == pytest.approx(clean_cal["down_enter"], abs=15)
    assert polluted_cal["up_enter"] == pytest.approx(clean_cal["up_enter"], abs=15)


# --------------------------------------------------------------------------
# Tracking quality
# --------------------------------------------------------------------------


def test_flat_signal_is_reported_untracked():
    """bad_side_subject_016 spans 10.3 deg over 405 frames -- not a movement."""
    flat = 175.0 + np.random.default_rng(0).normal(0, 0.6, 405)
    quality = tracking_quality(flat)
    assert quality["tracked"] is False
    assert "insufficient_range" in str(quality["reason"])


def test_clean_pushups_are_tracked():
    angles, _ = make_reps(8)
    quality = tracking_quality(angles)
    assert quality["tracked"] is True


def test_short_clip_is_untracked():
    quality = tracking_quality(np.array([100.0, 120.0]))
    assert quality["tracked"] is False
    assert quality["reason"] == "too_few_frames"


# --------------------------------------------------------------------------
# Segmenting
# --------------------------------------------------------------------------


def test_counts_the_right_number_of_reps():
    for n in (3, 5, 8, 12):
        angles, times = make_reps(n)
        reps, _windows, quality = segment_reps(angles, times)
        assert quality["tracked"] is True
        assert len(reps) == n, f"expected {n} reps, got {len(reps)}"


def test_counts_reps_when_clip_starts_mid_movement():
    """
    Regression: starting in the down position must not discard the whole clip.

    good_diagonal_subject_022 only reached up_enter at frame 249 of 266, so a
    strict READY state threw away every rep it contained.
    """
    angles, times = make_reps(6, start_at_top=False)
    reps, _w, _q = segment_reps(angles, times)
    assert len(reps) >= 4, f"expected most reps to survive, got {len(reps)}"


def test_no_double_counting_from_noise():
    """Hysteresis must absorb jitter around a threshold."""
    angles, times = make_reps(6)
    rng = np.random.default_rng(1)
    noisy = angles + rng.normal(0, 2.0, angles.size)

    reps, _w, _q = segment_reps(noisy, times)
    assert 4 <= len(reps) <= 8, f"noise changed the count too much: {len(reps)}"


def test_tiny_arm_movements_do_not_count():
    """A small twitch is not a rep."""
    angles, times = make_reps(2, top=160.0, bottom=155.0, rep_seconds=0.8)
    reps, _w, quality = segment_reps(angles, times)
    assert len(reps) == 0 or quality["tracked"] is False


def test_implausibly_slow_rep_is_rejected():
    """A 20s 'rep' is a mismeasured window, not a push-up."""
    angles, times = make_reps(1, rep_seconds=20.0)
    reps, _w, _q = segment_reps(angles, times)
    assert all(r.duration_s <= MAX_REP_SECONDS for r in reps)


def test_implausibly_fast_rep_is_rejected():
    angles, times = make_reps(1, rep_seconds=0.05)
    reps, _w, _q = segment_reps(angles, times)
    assert all(r.duration_s >= MIN_REP_SECONDS for r in reps)


def test_reps_have_plausible_durations_and_rom():
    angles, times = make_reps(7, rep_seconds=2.0)
    reps, _w, _q = segment_reps(angles, times)

    assert len(reps) == 7
    for rep in reps:
        assert MIN_REP_SECONDS <= rep.duration_s <= MAX_REP_SECONDS
        assert rep.min_elbow_angle < rep.max_elbow_angle
        assert rep.frame_end >= rep.frame_start


def test_reps_do_not_overlap():
    angles, times = make_reps(9)
    reps, _w, _q = segment_reps(angles, times)
    for prev, cur in zip(reps, reps[1:]):
        assert cur.frame_start >= prev.frame_end, "rep windows overlap"


def test_empty_and_all_nan_inputs_are_safe():
    reps, windows, quality = segment_reps(np.array([]), np.array([]))
    assert reps == [] and windows == []
    assert quality["tracked"] is False

    nan_angles = np.full(100, np.nan)
    times = np.arange(100, dtype=float) / FPS
    reps, _w, quality = segment_reps(nan_angles, times)
    assert reps == []
    assert quality["tracked"] is False


def test_masking_does_not_change_clean_clip_counts():
    """Plausibility masking should be a no-op on a well-tracked clip."""
    angles, times = make_reps(8)
    reps, _w, _q = segment_reps(angles, times)
    assert len(reps) == 8


def test_smoothing_preserves_rep_count_at_15fps():
    angles, times = make_reps(10, rep_seconds=1.5)
    raw_reps, _w1, _q1 = segment_reps(angles, times)
    smoothed = smooth_signal(angles)
    assert smoothed.size == angles.size
    assert len(raw_reps) == 10
