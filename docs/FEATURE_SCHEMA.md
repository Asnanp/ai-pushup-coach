# FEATURE_SCHEMA.md — Biomechanical Feature Contract

**This is the single most important interface in the project.**

The TypeScript runtime extractor (`packages/biomechanics`) and the Python training
extractor (`ml/src/features.py`) MUST produce the same values for the same landmarks.
Any change here requires updating both, plus `docs/POSE_SCHEMA.md`.

All features are **scale-invariant and translation-invariant**. We never feed raw pixel
coordinates to the model. The model must learn *body geometry and movement*, never the
person's background, clothing, or distance from the camera.

---

## 0. Input: Normalized Landmarks

MediaPipe Pose emits 33 landmarks at indices:

| Index | Name | Index | Name |
|---|---|---|---|
| 0 | nose | 17 | left_pinky |
| 1 | left_eye_inner | 18 | right_pinky |
| 2 | left_eye | 19 | left_index |
| 3 | left_eye_outer | 20 | right_index |
| 4 | right_eye_inner | 21 | left_thumb |
| 5 | right_eye | 22 | right_thumb |
| 6 | right_eye_outer | 23 | **left_hip** |
| 7 | left_ear | 24 | **right_hip** |
| 8 | right_ear | 25 | **left_knee** |
| 9 | mouth_left | 26 | **right_knee** |
| 10 | mouth_right | 27 | **left_ankle** |
| 11 | **left_shoulder** | 28 | **right_ankle** |
| 12 | **right_shoulder** | 29 | left_heel |
| 13 | **left_elbow** | 30 | right_heel |
| 14 | **right_elbow** | 31 | left_foot_index |
| 15 | **left_wrist** | 32 | right_foot_index |
| 16 | **right_wrist** | | |

Bold = used by the push-up analysis.

**Coordinate convention (MediaPipe standard):**
- `x`, `y` in `[0,1]`, relative to image width/height. Origin top-left. `y` increases downward.
- `z` = depth relative to hips, roughly in the same scale as `x`.
- `visibility` ∈ `[0,1]`.

### 0.1 Side selection — CRITICAL

In a **side view**, one body side faces the camera and the other is occluded.
Measured on our dataset (`subject_001_push_up_good_side`, frame 100):
visible side visibility ≈ **0.98–1.00**; occluded side ≈ **0.18–0.42**.

Averaging both sides therefore injects occluded-landmark garbage into every feature.
**Rule: pick one side per frame and use it consistently.**

```
score_left  = mean(visibility of L shoulder, elbow, wrist, hip, knee, ankle)
score_right = mean(visibility of R shoulder, elbow, wrist, hip, knee, ankle)
active_side = argmax(score_left, score_right)
```

The chosen side is **sticky**: switching sides mid-rep would create discontinuous angles
and break the state machine. Re-evaluate the side only:
- at the start of the session, and
- at a rep boundary, and only if the other side exceeds the current side by `SIDE_SWITCH_MARGIN = 0.15`.

If the active side's mean visibility < `MIN_VISIBILITY = 0.5`, the frame is **invalid**:
emit `confidence: 0` and let downstream pause. Do not silently extrapolate.

---

## 1. Reference Frame Construction

Raw image coordinates are discarded. Everything is expressed relative to the body.

```
torso_vector   = shoulder_mid - hip_mid          # 2D, points "up the body"
torso_angle    = atan2(torso_vector.y, torso_vector.x)
R              = rotation by -torso_angle        # aligns torso to the +x axis after rotation

# Rotate every landmark into torso-aligned space
p' = R @ (p - hip_mid)
```

`torso_height = ||shoulder_mid - hip_mid||` is the **scale reference**.

```
# Normalize by torso length so distance-from-camera cancels out
p'' = (R @ (p - hip_mid)) / torso_height
```

**Key insight:** after this transform, a body in a perfect plank has torso pointing
along +x, and `y''` deviations are *sag/pike* directly. Depth-from-camera and subject
size are eliminated.

---

## 2. Joint Angles

Angles are computed at the **active side** unless stated otherwise.
Formula (3-point angle at vertex `b`, in degrees, 0–180):

```
angle(a, b, c) = degrees(acos( clamp( dot(a-b, c-b) / (||a-b|| * ||c-b||), -1, 1 ) ))
```

| # | Feature | Definition | Push-up meaning |
|---|---|---|---|
| 1 | `elbow_angle_deg` | `angle(shoulder, elbow, wrist)` | primary rep-phase signal |
| 2 | `shoulder_angle_deg` | `angle(elbow, shoulder, hip)` | upper-arm-to-torso relationship |
| 3 | `hip_angle_deg` | `angle(shoulder, hip, knee)` | pike vs sag |
| 4 | `knee_angle_deg` | `angle(hip, knee, ankle)` | knee bend (cheating / kneeling) |
| 5 | `ankle_angle_deg` | `angle(knee, ankle, foot_index)` | foot support |
| 6 | `elbow_angle_opposite_deg` | same as #1 on the other side | asymmetry / flare detection |

## 3. Alignment & Collinearity

| # | Feature | Definition |
|---|---|---|
| 7 | `body_line_deviation` | Perpendicular distance from `hip_mid` to the line `shoulder_mid → ankle_mid`, expressed in `torso_height` units. **Signed**: positive = hips sag toward the floor, negative = hips pike up. |
| 8 | `shoulder_hip_ankle_angle_deg` | `angle(shoulder_mid, hip_mid, ankle_mid)` |
| 9 | `torso_slope_deg` | Angle of `shoulder_mid → hip_mid` relative to the horizontal image axis. Plank ≈ 0°. |
| 10 | `hip_height_rel` | `hip_mid.y''` (torso-normalized). Relative, so camera position cancels. |
| 11 | `shoulder_height_rel` | `shoulder_mid.y''` |
| 12 | `ankle_height_rel` | `ankle_mid.y''` |
| 13 | `shoulder_ankle_height_delta` | `shoulder_mid.y'' - ankle_mid.y''` |

**Note on `body_line_deviation` sign:** derived from the cross product of
`(ankle_mid - shoulder_mid)` and `(hip_mid - shoulder_mid)`, so the sign is meaningful
and consistent in torso-normalized space regardless of which way the person faces.

## 4. Depth & Range of Motion

Depth is only meaningful **relative to the person**, never in pixels.

| # | Feature | Definition |
|---|---|---|
| 14 | `shoulder_elbow_height_delta` | Vertical gap `elbow.y'' - shoulder.y''`. Near 0 at full depth in a good rep. |
| 15 | `chest_height_rel` | `shoulder_mid.y''` at the rep's lowest point |
| 16 | `rom_elbow_deg` | `elbow_angle_max - elbow_angle_min` across the rep window |
| 17 | `min_elbow_angle_deg` | deepest flexion reached during the rep |
| 18 | `depth_ratio` | `(rom_elbow_deg) / (elbow_angle_max - DOWN_TARGET)` clamped to `[0,1]` |

## 5. Temporal / Velocity Features

Computed per rep window (see §7). `t` is seconds since rep start.

| # | Feature | Definition |
|---|---|---|
| 19 | `elbow_angular_velocity_max` | `max |d(elbow_angle)/dt|` (deg/s) |
| 20 | `elbow_angular_velocity_mean` | `mean(d(elbow_angle)/dt)` |
| 21 | `elbow_velocity_down_mean` | mean `d(elbow_angle)/dt` during descent (negative) |
| 22 | `elbow_velocity_up_mean` | mean `d(elbow_angle)/dt` during ascent (positive) |
| 23 | `hip_vertical_velocity_max` | `max |d(hip_height_rel)/dt|` |
| 24 | `shoulder_vertical_velocity_max` | `max |d(shoulder_height_rel)/dt|` |
| 25 | `rep_duration_s` | rep window length in seconds |
| 26 | `descent_duration_s` | time from top to bottom |
| 27 | `ascent_duration_s` | time from bottom to top |
| 28 | `descent_ascent_ratio` | `descent_duration_s / ascent_duration_s` |
| 29 | `pause_at_bottom_s` | time spent within 10° of `min_elbow_angle_deg` |
| 30 | `pause_at_top_s` | time spent within 10° of top position |

## 6. Stability / Quality Features

| # | Feature | Definition |
|---|---|---|
| 31 | `elbow_angle_std` | std-dev of elbow angle over the rep |
| 32 | `hip_height_std` | std-dev of `hip_height_rel` |
| 33 | `body_line_deviation_std` | std-dev of `body_line_deviation` |
| 34 | `body_line_deviation_max_abs` | `max |body_line_deviation|` |
| 35 | `mean_visibility` | mean landmark visibility over the window |
| 36 | `min_visibility` | min landmark visibility over the window |
| 37 | `tracking_gap_ratio` | fraction of frames in the window with invalid pose |
| 38 | `jitter_score` | mean frame-to-frame landmark displacement, normalized |

## 7. Window Aggregation

A **rep window** = all frames between the top of the previous rep and the top of this rep
(as emitted by the rep state machine).

From the per-frame series we compute, for the key signals
(`elbow_angle_deg`, `hip_angle_deg`, `body_line_deviation`, `torso_slope_deg`,
`shoulder_elbow_height_delta`):

```
mean, min, max, std, range (max-min), p10, p50, p90
```

This yields a **flat fixed-length vector** for the classifier. We deliberately use a
hand-designed temporal aggregation rather than a raw frame sequence because:
- the dataset is small (144 videos / 24 subjects) — a sequence model would overfit,
- aggregates are far more interpretable for the form-feedback layer,
- they train in seconds and run in microseconds.

A small temporal model was explored as a comparison (`ml/scripts/train_classifier.py
--compare-sequence`) and required the sequence path in `build_sequences.py`.

## 8. The Final Feature Vector

Ordering is **fixed and versioned**. `FEATURE_SPEC_VERSION` must be written into
`ml/models/metadata.json` and checked at load time in the browser. A mismatch is a
hard error — never silently score with a stale model.

```
FEATURE_SPEC_VERSION = 1

GROUP A — angles (7)
  0  elbow_angle_deg_mean
  1  elbow_angle_deg_min
  2  elbow_angle_deg_max
  3  shoulder_angle_deg_mean
  4  hip_angle_deg_mean
  5  hip_angle_deg_min
  6  knee_angle_deg_mean

GROUP B — alignment (6)
  7  body_line_deviation_mean
  8  body_line_deviation_max_abs
  9  body_line_deviation_std
 10  shoulder_hip_ankle_angle_deg_mean
 11  torso_slope_deg_mean
 12  shoulder_ankle_height_delta_mean

GROUP C — depth / ROM (5)
 13  shoulder_elbow_height_delta_min
 14  shoulder_elbow_height_delta_mean
 15  rom_elbow_deg
 16  min_elbow_angle_deg
 17  depth_ratio

GROUP D — tempo (8)
 18  elbow_angular_velocity_max
 19  elbow_angular_velocity_mean
 20  elbow_velocity_down_mean
 21  elbow_velocity_up_mean
 22  rep_duration_s
 23  descent_duration_s
 24  ascent_duration_s
 25  descent_ascent_ratio

GROUP E — stability (7)
 26  elbow_angle_std
 27  hip_height_std
 28  hip_vertical_velocity_max
 29  shoulder_vertical_velocity_max
 30  pause_at_bottom_s
 31  jitter_score
 32  body_line_deviation_range

GROUP F — quality (4)
 33  mean_visibility
 34  min_visibility
 35  tracking_gap_ratio
 36  elbow_angle_opposite_deg_mean

TOTAL: 37 features
```

Every model artifact records this list. The browser refuses to run a model whose
feature list does not match its own.
