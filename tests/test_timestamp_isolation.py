"""
Regression guards for the shared-object timestamp corruption.

`FrameFeatures` objects are shared between the full-clip list and every rep
window slice. Re-timing a window by mutating `timestamp` in place therefore
shifts frames that later windows read too -- cumulatively, and twice for each
boundary frame. That bug produced rep durations of 21.9 s for a 2.7 s window
and corrupted 82% of the training vectors before it was found.

These tests assert the property that was violated, not the current
implementation, so a refactor cannot silently reintroduce it.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "ml") not in sys.path:
    sys.path.insert(0, str(ROOT / "ml"))

from src.features import FrameFeatures, aggregate_rep_window, retime_window  # noqa: E402

FPS = 15.0
DT = 1.0 / FPS


def make_frames(n: int, start_t: float = 0.0) -> list[FrameFeatures]:
    """A synthetic descending-then-ascending rep, all frames valid."""
    out = []
    for i in range(n):
        half = (n - 1) / 2
        # elbow goes 160 -> 70 -> 160 across the window
        elbow = 70.0 + 90.0 * abs(i - half) / half if half > 0 else 90.0
        out.append(
            FrameFeatures(
                valid=True,
                side="left",
                elbow_angle=elbow,
                hip_height_rel=0.5,
                shoulder_height_rel=0.8,
                timestamp=start_t + i * DT,
            )
        )
    return out


def test_retime_window_does_not_mutate_its_input() -> None:
    frames = make_frames(40, start_t=10.0)
    originals = [f.timestamp for f in frames]

    retimed = retime_window(frames)

    # The input must be untouched -- this is the whole point of the fix.
    assert [f.timestamp for f in frames] == pytest.approx(originals)
    # The output starts at zero and preserves relative spacing.
    assert retimed[0].timestamp == pytest.approx(0.0)
    assert retimed[-1].timestamp == pytest.approx(39 * DT)
    # New objects, not aliases.
    assert retimed[0] is not frames[0]


def test_retime_window_is_idempotent() -> None:
    """Re-timing the same window repeatedly must give the same answer.

    NOTE: this alone does NOT catch the original bug -- an in-place shift
    becomes a no-op on the second call because t0 is then 0. It is kept as a
    cheap invariant; the discriminating guards are the overlapping-window and
    boundary-frame tests below.
    """
    frames = make_frames(40, start_t=10.0)

    first = [f.timestamp for f in retime_window(frames)]
    second = [f.timestamp for f in retime_window(frames)]
    third = [f.timestamp for f in retime_window(frames)]

    assert first == pytest.approx(second)
    assert second == pytest.approx(third)


def test_overlapping_windows_do_not_drift() -> None:
    """Simulate the real access pattern exactly.

    `segment_reps` emits windows that SHARE their boundary frame: rep N ends at
    frame k and rep N+1 starts at frame k. (Verified against the extracted
    data: [12,39], [39,71], [71,103], ...). With shared objects and in-place
    re-timing, window N+1 reads a boundary frame that window N already shifted,
    so its t0 is wrong and the error accumulates down the clip.

    Every window here is 41 frames at 15 fps, so every duration must be the
    same ~2.67 s. The bug produced 12.7 s and growing.
    """
    shared = make_frames(200, start_t=10.0)
    # Overlapping: each window starts where the previous one ended.
    windows = [(0, 40), (40, 80), (80, 120), (120, 160)]

    durations = []
    for start_i, end_i in windows:
        window = shared[start_i : end_i + 1]
        _, raw = aggregate_rep_window(
            retime_window(window), total_frames_in_window=end_i - start_i + 1
        )
        durations.append(raw.get("rep_duration_s", float("nan")))

    durations = np.asarray(durations, dtype=float)
    assert np.isfinite(durations).all()

    expected = 40 * DT
    assert durations == pytest.approx(expected, abs=1e-6), (
        f"durations diverged (cumulative drift): {durations.tolist()} "
        f"expected all ~{expected:.4f}"
    )


def test_boundary_frame_survives_neighbour_being_retimed() -> None:
    """The shared boundary frame must keep its original timestamp.

    This is the direct assertion of the violated property: re-timing one window
    must not be observable from any other window that shares a frame with it.
    """
    shared = make_frames(200, start_t=10.0)
    originals = [f.timestamp for f in shared]

    # Re-time the first three overlapping windows.
    for start_i, end_i in [(0, 40), (40, 80), (80, 120)]:
        retime_window(shared[start_i : end_i + 1])

    assert [f.timestamp for f in shared] == pytest.approx(originals)


def test_aggregation_reports_physically_plausible_duration() -> None:
    """A 40-frame rep at 15 fps cannot take 20 seconds.

    This is the guard that would have failed on the shipped training data,
    where rep_duration_s reached 21.87 s.
    """
    frames = make_frames(40, start_t=0.0)
    _, raw = aggregate_rep_window(retime_window(frames), total_frames_in_window=40)

    duration = raw.get("rep_duration_s", float("nan"))
    assert np.isfinite(duration)
    assert 0.2 <= duration <= 8.0, f"implausible rep duration: {duration}"


def test_aggregate_rep_window_leaves_timestamps_alone() -> None:
    """Defence in depth: the aggregator itself must not mutate its input."""
    frames = make_frames(30, start_t=5.0)
    before = [f.timestamp for f in frames]

    aggregate_rep_window(frames, total_frames_in_window=30)

    assert [f.timestamp for f in frames] == pytest.approx(before)
