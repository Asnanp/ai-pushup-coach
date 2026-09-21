# POSE_SCHEMA.md

## 1. Engine Choice

**MediaPipe Pose Landmarker (Tasks API), running in the browser via WASM/WebGL.**

Chosen over alternatives because:
- runs fully client-side in the browser on the GPU delegate — no frames leave the device,
- 33 landmarks is sufficient for push-up analysis,
- best available accuracy/weight trade-off for real-time use on a school laptop,
- no model download at runtime beyond the bundled `.task` asset.

The Python side uses the equivalent `mediapipe.solutions.pose` implementation so training
and runtime see the **same landmark semantics**. Any divergence here would invalidate
the entire trained model, so the landmark index table below is shared by both.

## 2. Landmark Indices

See `FEATURE_SCHEMA.md §0` for the full 33-landmark table.

Used for push-ups: `11,12` shoulders · `13,14` elbows · `15,16` wrists ·
`23,24` hips · `25,26` knees · `27,28` ankles · `29–32` feet · `0` nose.

## 3. Normalization Pipeline

Raw MediaPipe output is **not** used directly. It passes through four stages:

```
raw landmarks (x,y,z,visibility  ∈ [0,1] image-relative)
        │
        │  1. VALIDITY GATE
        │     reject frame if active-side mean visibility < 0.5
        ▼
     smoothed landmarks
        │
        │  2. TEMPORAL SMOOTHING
        │     One-Euro filter per landmark coordinate
        ▼
     filtered landmarks
        │
        │  3. TORSO NORMALIZATION
        │     translate by hip_mid, rotate by -torso_angle, scale by torso_height
        ▼
     normalized landmarks  ← model + rep counter consume only this
        │
        │  4. FEATURE DERIVATION
        ▼
     feature vector (FEATURE_SCHEMA.md §8)
```

## 4. Smoothing — One-Euro Filter

A plain EMA forces a choice between lag and jitter: heavy smoothing makes the elbow-angle
signal lag behind fast reps, light smoothing lets MediaPipe's per-frame noise trigger
false state transitions. With 15 FPS dataset footage and fast test subjects, both failure
modes are real.

The One-Euro filter adapts its cutoff to signal speed — heavy smoothing when the body is
nearly still, light smoothing during fast movement. That is exactly the required behaviour.

```
# Per coordinate, per landmark
dx_filtered = OneEuro(dx, mincutoff=1.0, beta=0.007, dcutoff=1.0)
```

Parameters were tuned by sweeping on a subset of training clips while measuring
elbow-angle signal-to-noise versus lag. Recorded defaults:
`mincutoff = 1.0`, `beta = 0.007`, `dcutoff = 1.0`.

Additionally, a **median-of-3 pre-filter** runs on the elbow angle before the state
machine, because a single spurious landmark spike can otherwise fake a rep.

## 5. Visibility Handling

MediaPipe reports a `visibility` score per landmark. Two distinct uses, which must not
be conflated:

1. **Side selection** — visibility decides which body side we trust (see
   `FEATURE_SCHEMA.md §0.1`). Measured on our data: visible side 0.98–1.00,
   occluded side 0.18–0.42. The separation is large and reliable, so this is a sound
   discriminator.

2. **Frame gating** — if the active side's mean visibility drops below 0.5, the frame is
   marked invalid. Invalid frames are **excluded from the rep window**, never interpolated.
   Interpolating occluded hips would manufacture alignment measurements that look good
   precisely when the camera could not see them — the worst possible failure mode.

`tracking_gap_ratio` records the fraction of invalid frames per rep, so a rep captured
through a lot of occlusion is scored with visible uncertainty rather than false confidence.

## 6. Camera View Classification

Detected geometrically from the normalized landmarks, not asked of the user:

```
# Apparent body length relative to apparent shoulder width
span_ratio = ||shoulder_mid → ankle_mid||  /  (||shoulder_hip_ankle_angle_deg|| … )
```

Practical rule:
- Apparent shoulder width large relative to torso length, both shoulders similarly
  visible → **front**
- One side clearly dominant, shoulders overlapping, long body span → **side**
- Intermediate → **diagonal**

The detected view is displayed in calibration so the user can confirm or adjust, and
recorded on the session for the Progress page's per-view analytics. It does **not**
change the feature vector — the normalizations already make features view-agnostic, and
the model is evaluated per-view to confirm this.

## 7. Overlay Rendering

- Drawn to a `<canvas>` layered over the `<video>`, sized with `devicePixelRatio`.
- **Never** through React state. The rAF loop writes to canvas directly; React is not
  involved in the per-frame path at all.
- Rejected landmarks are not drawn (avoids the "skeleton jitters across the screen" look).
- Joint dots use the accent colour; low-confidence joints render dimmed, so a viewer can
  literally see when the model is unsure.
- Skeleton connections are drawn only between pairs where both endpoints are valid.

## 8. Feet-in-Frame Detection

Push-up form depends on the ankles, so a frame cut at the ankles is useless even if the
shoulders track perfectly. The gate checks:
- ankle landmarks present AND visible (> 0.5), and
- `ankle_mid.y < 0.98` (not clipped at the bottom edge), and
- `nose.y > 0.02` (head not clipped at the top).

Failing this produces the `FEET_OUT_OF_FRAME` calibration error with the corrective
message "Move further from the camera", rather than silently scoring with partial data.
