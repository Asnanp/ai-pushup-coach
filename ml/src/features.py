"""
ml/src/features.py

Agent 7 — BIOMECHANICS / FEATURE ENGINEER

Reference implementation of docs/FEATURE_SCHEMA.md.

The TypeScript runtime extractor (packages/biomechanics) mirrors this file.
Any change here MUST be mirrored there, and `ml/scripts/check_parity.py` must
still pass.

Data flow:
    landmarks (per frame)  ->  per-frame features  ->  rep-window aggregate  ->  vector
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, replace
from typing import Iterable, Sequence

import numpy as np

FEATURE_SPEC_VERSION = 1

# --------------------------------------------------------------------------
# MediaPipe landmark indices
# --------------------------------------------------------------------------

NOSE = 0
L_SHOULDER, R_SHOULDER = 11, 12
L_ELBOW, R_ELBOW = 13, 14
L_WRIST, R_WRIST = 15, 16
L_HIP, R_HIP = 23, 24
L_KNEE, R_KNEE = 25, 26
L_ANKLE, R_ANKLE = 27, 28
L_HEEL, R_HEEL = 29, 30
L_FOOT, R_FOOT = 31, 32

LEFT_SIDE = (L_SHOULDER, L_ELBOW, L_WRIST, L_HIP, L_KNEE, L_ANKLE)
RIGHT_SIDE = (R_SHOULDER, R_ELBOW, R_WRIST, R_HIP, R_KNEE, R_ANKLE)

MIN_VISIBILITY = 0.5
SIDE_SWITCH_MARGIN = 0.15

# --------------------------------------------------------------------------
# Thresholds — derived from the dataset (see docs/FORM_SCORE.md)
# --------------------------------------------------------------------------

DEPTH_TARGET_DEG = 90.0
DEPTH_TOP_DEG = 160.0
ALIGNMENT_TOLERANCE = 0.18
ALIGNMENT_FREE = 0.05
TEMPO_IDEAL_MIN = 1.2
TEMPO_IDEAL_MAX = 4.0

# The 37 features, in the exact order mandated by FEATURE_SCHEMA.md §8.
FEATURE_NAMES: list[str] = [
    # A — angles (7)
    "elbow_angle_deg_mean",
    "elbow_angle_deg_min",
    "elbow_angle_deg_max",
    "shoulder_angle_deg_mean",
    "hip_angle_deg_mean",
    "hip_angle_deg_min",
    "knee_angle_deg_mean",
    # B — alignment (6)
    "body_line_deviation_mean",
    "body_line_deviation_max_abs",
    "body_line_deviation_std",
    "shoulder_hip_ankle_angle_deg_mean",
    "torso_slope_deg_mean",
    "shoulder_ankle_height_delta_mean",
    # C — depth / ROM (5)
    "shoulder_elbow_height_delta_min",
    "shoulder_elbow_height_delta_mean",
    "rom_elbow_deg",
    "min_elbow_angle_deg",
    "depth_ratio",
    # D — tempo (8)
    "elbow_angular_velocity_max",
    "elbow_angular_velocity_mean",
    "elbow_velocity_down_mean",
    "elbow_velocity_up_mean",
    "rep_duration_s",
    "descent_duration_s",
    "ascent_duration_s",
    "descent_ascent_ratio",
    # E — stability (7)
    "elbow_angle_std",
    "hip_height_std",
    "hip_vertical_velocity_max",
    "shoulder_vertical_velocity_max",
    "pause_at_bottom_s",
    "jitter_score",
    "body_line_deviation_range",
    # F — quality (4)
    "mean_visibility",
    "min_visibility",
    "tracking_gap_ratio",
    "elbow_angle_opposite_deg_mean",
]

N_FEATURES = len(FEATURE_NAMES)
assert N_FEATURES == 37, f"expected 37 features, got {N_FEATURES}"


# --------------------------------------------------------------------------
# Geometry primitives
# --------------------------------------------------------------------------


def angle_deg(a: np.ndarray, b: np.ndarray, c: np.ndarray) -> float:
    """Angle at vertex b, in degrees, clamped to [0,180]."""
    ba = a - b
    bc = c - b
    nba = np.linalg.norm(ba)
    nbc = np.linalg.norm(bc)
    if nba < 1e-9 or nbc < 1e-9:
        return float("nan")
    cos = float(np.dot(ba, bc) / (nba * nbc))
    cos = max(-1.0, min(1.0, cos))
    return math.degrees(math.acos(cos))


@dataclass
class Landmark:
    x: float
    y: float
    z: float = 0.0
    visibility: float = 1.0


@dataclass
class FrameFeatures:
    """Per-frame derived features before rep-window aggregation."""

    valid: bool
    side: str  # "left" | "right"
    elbow_angle: float = float("nan")
    elbow_angle_opposite: float = float("nan")
    shoulder_angle: float = float("nan")
    hip_angle: float = float("nan")
    knee_angle: float = float("nan")
    ankle_angle: float = float("nan")
    body_line_deviation: float = float("nan")
    shoulder_hip_ankle_angle: float = float("nan")
    torso_slope: float = float("nan")
    hip_height_rel: float = float("nan")
    shoulder_height_rel: float = float("nan")
    shoulder_elbow_height_delta: float = float("nan")
    shoulder_ankle_height_delta: float = float("nan")
    mean_visibility: float = 0.0
    min_visibility: float = 0.0
    jitter: float = 0.0
    timestamp: float = 0.0


# --------------------------------------------------------------------------
# Side selection
# --------------------------------------------------------------------------


def side_visibility(landmarks: Sequence[Landmark], indices: Iterable[int]) -> float:
    vals = [landmarks[i].visibility for i in indices if i < len(landmarks)]
    return float(np.mean(vals)) if vals else 0.0


def choose_side(
    landmarks: Sequence[Landmark],
    current_side: str | None = None,
    allow_switch: bool = True,
) -> tuple[str, float, float]:
    """
    Pick the trusted body side. Sticky: once chosen we keep it unless the other
    side is clearly better, because switching mid-rep creates discontinuity.

    Returns (side, score_of_chosen, score_of_other).
    """
    l_score = side_visibility(landmarks, LEFT_SIDE)
    r_score = side_visibility(landmarks, RIGHT_SIDE)

    if current_side is None or not allow_switch:
        # Fresh decision
        return ("left", l_score, r_score) if l_score >= r_score else ("right", r_score, l_score)

    cur_score = l_score if current_side == "left" else r_score
    other_score = r_score if current_side == "left" else l_score
    other_side = "right" if current_side == "left" else "left"

    if other_score > cur_score + SIDE_SWITCH_MARGIN:
        return other_side, other_score, cur_score
    return current_side, cur_score, other_score


# --------------------------------------------------------------------------
# Torso normalization
# --------------------------------------------------------------------------


def _pt(landmarks: Sequence[Landmark], idx: int) -> np.ndarray:
    lm = landmarks[idx]
    return np.array([lm.x, lm.y], dtype=float)


def torso_frame(
    landmarks: Sequence[Landmark], side: str
) -> tuple[np.ndarray, np.ndarray, float, float]:
    """
    Build the torso-aligned, scale-normalized reference frame.

    Returns (origin=hip_mid, rotation_basis, torso_height, torso_angle).
    """
    ls, rs = _pt(landmarks, L_SHOULDER), _pt(landmarks, R_SHOULDER)
    lh, rh = _pt(landmarks, L_HIP), _pt(landmarks, R_HIP)

    shoulder_mid = (ls + rs) / 2.0
    hip_mid = (lh + rh) / 2.0

    torso_vec = shoulder_mid - hip_mid
    torso_height = float(np.linalg.norm(torso_vec))
    if torso_height < 1e-6:
        torso_height = 1e-6

    torso_angle = math.atan2(float(torso_vec[1]), float(torso_vec[0]))
    return hip_mid, torso_vec, torso_height, torso_angle


def normalize_points(
    landmarks: Sequence[Landmark], hip_mid: np.ndarray, torso_angle: float, torso_height: float
) -> list[np.ndarray]:
    """Rotate every landmark into torso space and scale by torso height."""
    cos_a = math.cos(-torso_angle)
    sin_a = math.sin(-torso_angle)
    rot = np.array([[cos_a, -sin_a], [sin_a, cos_a]], dtype=float)

    out: list[np.ndarray] = []
    for lm in landmarks:
        rel = np.array([lm.x, lm.y], dtype=float) - hip_mid
        out.append((rot @ rel) / torso_height)
    return out


def signed_body_line_deviation(
    shoulder_mid: np.ndarray, hip_mid: np.ndarray, ankle_mid: np.ndarray
) -> float:
    """
    Perpendicular offset of the hip from the shoulder->ankle line, in the
    torso-normalized frame, with a consistent sign.

    Positive  -> hips below the line (sagging toward the floor)
    Negative  -> hips above the line (piked up)
    """
    a = shoulder_mid
    b = ankle_mid
    ab = b - a
    norm = np.linalg.norm(ab)
    if norm < 1e-9:
        return float("nan")

    ap = hip_mid - a
    # 2D cross product gives the signed perpendicular magnitude
    cross = float(ab[0] * ap[1] - ab[1] * ap[0])
    return cross / norm


# --------------------------------------------------------------------------
# Per-frame extraction
# --------------------------------------------------------------------------


def extract_frame_features(
    landmarks: Sequence[Landmark],
    timestamp: float = 0.0,
    current_side: str | None = None,
    allow_side_switch: bool = True,
    prev_normalized: list[np.ndarray] | None = None,
) -> FrameFeatures:
    """Derive all per-frame geometry from one pose frame."""
    side, side_score, other_score = choose_side(
        landmarks, current_side=current_side, allow_switch=allow_side_switch
    )

    mean_vis = (side_score + other_score) / 2.0
    min_vis = min(
        landmarks[i].visibility
        for i in (L_SHOULDER, R_SHOULDER, L_HIP, R_HIP, L_ANKLE, R_ANKLE)
        if i < len(landmarks)
    )

    # Active-side indices
    if side == "left":
        sh, el, wr, hp, kn, an = L_SHOULDER, L_ELBOW, L_WRIST, L_HIP, L_KNEE, L_ANKLE
        o_sh, o_el, o_wr = R_SHOULDER, R_ELBOW, R_WRIST
    else:
        sh, el, wr, hp, kn, an = R_SHOULDER, R_ELBOW, R_WRIST, R_HIP, R_KNEE, R_ANKLE
        o_sh, o_el, o_wr = L_SHOULDER, L_ELBOW, L_WRIST

    # Validity gate — occluded side means we cannot trust any angle from it
    if side_score < MIN_VISIBILITY:
        return FrameFeatures(
            valid=False,
            side=side,
            mean_visibility=mean_vis,
            min_visibility=min_vis,
            timestamp=timestamp,
        )

    hip_mid, torso_vec, torso_height, torso_angle = torso_frame(landmarks, side)
    norm = normalize_points(landmarks, hip_mid, torso_angle, torso_height)

    # --- angles in normalized space (scale-free, view-agnostic) ---
    elbow_angle = angle_deg(norm[sh], norm[el], norm[wr])
    elbow_angle_opp = angle_deg(norm[o_sh], norm[o_el], norm[o_wr])
    shoulder_angle = angle_deg(norm[el], norm[sh], norm[hp])
    hip_angle = angle_deg(norm[sh], norm[hp], norm[kn])
    knee_angle = angle_deg(norm[hp], norm[kn], norm[an])
    foot_idx = L_FOOT if side == "left" else R_FOOT
    ankle_angle = angle_deg(norm[kn], norm[an], norm[foot_idx])

    # --- midline points in normalized space ---
    l_sh_mid = (norm[L_SHOULDER] + norm[R_SHOULDER]) / 2.0
    l_hip_mid = (norm[L_HIP] + norm[R_HIP]) / 2.0
    l_ankle_mid = (norm[L_ANKLE] + norm[R_ANKLE]) / 2.0

    body_line_dev = signed_body_line_deviation(l_sh_mid, l_hip_mid, l_ankle_mid)
    sha_angle = angle_deg(l_sh_mid, l_hip_mid, l_ankle_mid)

    shoulder_to_hip = l_sh_mid - l_hip_mid
    torso_slope = math.degrees(math.atan2(float(shoulder_to_hip[1]), float(shoulder_to_hip[0])))

    hip_h = float(l_hip_mid[1])
    sh_h = float(l_sh_mid[1])
    sh_elbow_delta = float(norm[el][1] - norm[sh][1])
    sh_ankle_delta = float(sh_h - l_ankle_mid[1])

    # --- jitter: frame-to-frame landmark movement ---
    jitter = 0.0
    if prev_normalized is not None:
        key = [L_SHOULDER, R_SHOULDER, L_ELBOW, R_ELBOW, L_HIP, R_HIP, L_KNEE, R_KNEE, L_ANKLE, R_ANKLE]
        deltas = [
            float(np.linalg.norm(norm[i] - prev_normalized[i]))
            for i in key
            if i < len(norm) and i < len(prev_normalized)
        ]
        jitter = float(np.mean(deltas)) if deltas else 0.0

    return FrameFeatures(
        valid=True,
        side=side,
        elbow_angle=elbow_angle,
        elbow_angle_opposite=elbow_angle_opp,
        shoulder_angle=shoulder_angle,
        hip_angle=hip_angle,
        knee_angle=knee_angle,
        ankle_angle=ankle_angle,
        body_line_deviation=body_line_dev,
        shoulder_hip_ankle_angle=sha_angle,
        torso_slope=torso_slope,
        hip_height_rel=hip_h,
        shoulder_height_rel=sh_h,
        shoulder_elbow_height_delta=sh_elbow_delta,
        shoulder_ankle_height_delta=sh_ankle_delta,
        mean_visibility=mean_vis,
        min_visibility=min_vis,
        jitter=jitter,
        timestamp=timestamp,
    )


# --------------------------------------------------------------------------
# Rep-window aggregation -> the 37-vector
# --------------------------------------------------------------------------


def _safe(values: Sequence[float], fn, default: float = 0.0) -> float:
    arr = np.asarray([v for v in values if v is not None and np.isfinite(v)], dtype=float)
    if arr.size == 0:
        return default
    return float(fn(arr))


def _std(values: Sequence[float], default: float = 0.0) -> float:
    arr = np.asarray([v for v in values if v is not None and np.isfinite(v)], dtype=float)
    if arr.size < 2:
        return default
    return float(np.std(arr))


def retime_window(frames: Sequence[FrameFeatures]) -> list[FrameFeatures]:
    """
    Return the frames re-timed so the window starts at t=0.

    This MUST copy. `FrameFeatures` objects are shared between the whole-clip
    list and every window slice, so mutating `timestamp` in place shifts frames
    that later windows also read -- cumulatively, and twice for each boundary
    frame. That silently produced rep durations of 20+ s for 2.7 s windows and
    corrupted every velocity feature in the training set. See
    docs/BUILD_STATUS.md for the measurement.
    """
    if not frames:
        return []
    t0 = frames[0].timestamp
    return [replace(f, timestamp=f.timestamp - t0) for f in frames]


def aggregate_rep_window(
    frames: Sequence[FrameFeatures],
    total_frames_in_window: int | None = None,
) -> tuple[np.ndarray, dict[str, float]]:
    """
    Turn the per-frame features of one rep into the 37-dim model vector.

    Returns (vector, raw_feature_dict). The raw dict is retained so the
    form-feedback layer can use interpretable values without re-deriving them.
    """
    n_window = total_frames_in_window if total_frames_in_window is not None else len(frames)
    valid_frames = [f for f in frames if f.valid]

    if not valid_frames:
        return np.full(N_FEATURES, np.nan, dtype=float), {
            "tracking_gap_ratio": 1.0,
            "valid": False,
        }

    t = np.array([f.timestamp for f in valid_frames], dtype=float)
    elbow = np.array([f.elbow_angle for f in valid_frames], dtype=float)
    hip_h = np.array([f.hip_height_rel for f in valid_frames], dtype=float)
    sh_h = np.array([f.shoulder_height_rel for f in valid_frames], dtype=float)
    bline = np.array([f.body_line_deviation for f in valid_frames], dtype=float)

    # --- temporal derivatives (guard against zero/duplicate timestamps) ---
    def derivative(series: np.ndarray) -> np.ndarray:
        if series.size < 2:
            return np.zeros_like(series)
        dt = np.diff(t)
        dt = np.where(dt <= 1e-6, 1e-6, dt)
        return np.diff(series) / dt

    d_elbow = derivative(elbow)
    d_hip = derivative(hip_h)
    d_sh = derivative(sh_h)

    # --- rep timing derived from the elbow signal ---
    peak_idx = int(np.argmax(elbow))  # top of the rep (most extended)
    trough_idx = int(np.argmin(elbow))  # bottom (most flexed)
    # Elbow angle DEcreases during descent, so trough must follow peak.
    if trough_idx < peak_idx:
        # handle a window that starts mid-descent
        peak_idx, trough_idx = trough_idx, peak_idx

    rep_duration = float(t[-1] - t[0]) if t.size >= 2 else 0.0
    descent_duration = float(t[trough_idx] - t[peak_idx])
    ascent_duration = float(t[-1] - t[trough_idx])
    # Guard: partial windows can give degenerate splits
    if descent_duration < 0:
        descent_duration = 0.0
    if ascent_duration < 0:
        ascent_duration = 0.0
    descent_ascent_ratio = (
        descent_duration / ascent_duration if ascent_duration > 1e-6 else 0.0
    )

    down_vel = d_elbow[d_elbow < 0]
    up_vel = d_elbow[d_elbow > 0]

    elbow_min = float(np.min(elbow))
    elbow_max = float(np.max(elbow))
    rom = elbow_max - elbow_min

    # Pause detection: frames close to the extremes
    bottom_band = elbow <= elbow_min + 10.0
    top_band = elbow >= elbow_max - 10.0
    pause_bottom = _pause_duration(t, bottom_band)
    pause_top = _pause_duration(t, top_band)

    depth_ratio = float(
        np.clip((DEPTH_TOP_DEG - elbow_min) / (DEPTH_TOP_DEG - DEPTH_TARGET_DEG), 0.0, 1.0)
    )

    mean_vis = float(np.mean([f.mean_visibility for f in valid_frames]))
    min_vis = float(np.min([f.min_visibility for f in valid_frames]))
    gap_ratio = 1.0 - (len(valid_frames) / max(n_window, 1))

    raw: dict[str, float] = {
        "elbow_angle_deg_mean": float(np.mean(elbow)),
        "elbow_angle_deg_min": elbow_min,
        "elbow_angle_deg_max": elbow_max,
        "shoulder_angle_deg_mean": float(np.mean([f.shoulder_angle for f in valid_frames])),
        "hip_angle_deg_mean": float(np.mean([f.hip_angle for f in valid_frames])),
        "hip_angle_deg_min": float(np.min([f.hip_angle for f in valid_frames])),
        "knee_angle_deg_mean": float(np.mean([f.knee_angle for f in valid_frames])),
        "body_line_deviation_mean": float(np.mean(bline)),
        "body_line_deviation_max_abs": float(np.max(np.abs(bline))),
        "body_line_deviation_std": float(np.std(bline)),
        "body_line_deviation_range": float(np.max(bline) - np.min(bline)),
        "shoulder_hip_ankle_angle_deg_mean": float(
            np.mean([f.shoulder_hip_ankle_angle for f in valid_frames])
        ),
        "torso_slope_deg_mean": float(np.mean([f.torso_slope for f in valid_frames])),
        "shoulder_ankle_height_delta_mean": float(
            np.mean([f.shoulder_ankle_height_delta for f in valid_frames])
        ),
        "shoulder_elbow_height_delta_min": float(
            np.min([f.shoulder_elbow_height_delta for f in valid_frames])
        ),
        "shoulder_elbow_height_delta_mean": float(
            np.mean([f.shoulder_elbow_height_delta for f in valid_frames])
        ),
        "rom_elbow_deg": rom,
        "min_elbow_angle_deg": elbow_min,
        "depth_ratio": depth_ratio,
        "elbow_angular_velocity_max": float(np.max(np.abs(d_elbow))) if d_elbow.size else 0.0,
        "elbow_angular_velocity_mean": float(np.mean(d_elbow)) if d_elbow.size else 0.0,
        "elbow_velocity_down_mean": float(np.mean(down_vel)) if down_vel.size else 0.0,
        "elbow_velocity_up_mean": float(np.mean(up_vel)) if up_vel.size else 0.0,
        "rep_duration_s": rep_duration,
        "descent_duration_s": descent_duration,
        "ascent_duration_s": ascent_duration,
        "descent_ascent_ratio": descent_ascent_ratio,
        "elbow_angle_std": float(np.std(elbow)),
        "hip_height_std": float(np.std(hip_h)),
        "hip_vertical_velocity_max": float(np.max(np.abs(d_hip))) if d_hip.size else 0.0,
        "shoulder_vertical_velocity_max": float(np.max(np.abs(d_sh))) if d_sh.size else 0.0,
        "pause_at_bottom_s": pause_bottom,
        "pause_at_top_s": pause_top,
        "jitter_score": float(np.mean([f.jitter for f in valid_frames])),
        "mean_visibility": mean_vis,
        "min_visibility": min_vis,
        "tracking_gap_ratio": gap_ratio,
        "elbow_angle_opposite_deg_mean": float(
            np.mean([f.elbow_angle_opposite for f in valid_frames])
        ),
    }

    vector = np.array([raw.get(name, np.nan) for name in FEATURE_NAMES], dtype=float)
    return vector, raw


def _pause_duration(t: np.ndarray, mask: np.ndarray) -> float:
    """Longest contiguous run of True in `mask`, in seconds."""
    best = 0.0
    run_start = None
    for i, flag in enumerate(mask):
        if flag and run_start is None:
            run_start = i
        elif not flag and run_start is not None:
            best = max(best, float(t[i - 1] - t[run_start]))
            run_start = None
    if run_start is not None:
        best = max(best, float(t[-1] - t[run_start]))
    return best
