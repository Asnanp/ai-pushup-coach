# Front-View Push-Up Analysis & Failure Reproduction Report

**Author**: Agent 2 — Front-View Research Engineer  
**Status**: Root causes reproduced & diagnosed with empirical telemetry  
**Date**: 2026-09-21  

---

## 1. Executive Summary

In V1, front-camera push-ups were effectively broken in both offline extraction and live workout mode:
- **13 out of 48 front-view dataset clips (27.1%)** produced **0 reps** in V1 extraction (9 bad form, 4 good form).
- In live interactive mode (`tsLive`), front push-up counting had **0% accuracy on bad form** (e.g. `bad_front_subject_002` counted 0 out of 10 reps) and missed 45% of good form reps (`good_front_subject_002` counted 6 out of 11 reps).
- The root causes are not fundamental limitations of camera capture; they are four specific architectural flaws in V1's pose and rep-counter pipelines.

---

## 2. The Four Root Causes of Front-View Failure

### Root Cause 1: Brittle Reversal Fraction Gate in `tracking_quality`
- **Mechanism**: V1's `ml/src/rep_segmenter.py` contains:
  ```python
  MAX_REVERSAL_FRACTION = 0.16
  if reversal_fraction > MAX_REVERSAL_FRACTION:
      reasons.append("unstable_signal")
  ```
- **Finding**: In front view, the user's forearm and upper arm project with significant foreshortening. When descending toward the camera, small changes in depth and camera perspective produce sub-degree frame-to-frame direction reversals in the 2D angle. This gives a reversal fraction between **0.17 and 0.24**.
- **Impact**: V1 flagged clips with massive range of motion (e.g. `bad_front_subject_008` with ROM = 119.0°, `good_front_subject_001` with ROM = 80.9°, `bad_front_subject_015` with ROM = 143.3°) as `unstable_signal` and aborted segmentation immediately, outputting **0 reps**.

### Root Cause 2: Unilateral Side Selection
- **Mechanism**: V1's `packages/pose/src/side-selection.ts` forces a choice of either `left` or `right` based purely on 2D visibility:
  ```typescript
  const side = vis.left >= vis.right ? 'left' : 'right';
  ```
- **Finding**: While side view naturally occludes one arm, front view presents **both arms working concurrently**. If the selected arm suffers from wrist occlusion against the floor, tracking jitter, or angle compression, V1 has zero fallback to the opposite arm or bilateral consensus.
- **Evidence**: On clips where one arm's 2D angle compressed to a 35° range, the opposite arm had a clean 75° range of motion. V1 had no bilateral fusion mechanism.

### Root Cause 3: Preamble / Standing Calibration Lockout (`tsLive`)
- **Mechanism**: In live interactive mode, V1 calibrated thresholds on the first 60 frames while the user was standing or setting up plank position:
  - Observed range: `[135°, 170°]`
  - Derived `upEnter`: `~150°`
  - Derived `downEnter`: `~95°`
- **Finding**: In front view, push-up depth manifests strongly as downward translation in image space ($Y$) and camera depth ($Z$), while 2D elbow angle change is narrower than in side view. A user doing a shallow or chest-to-mat push-up may sweep from 135° to 105°. Because `downEnter` was locked at 95°, the state machine moved `UP -> DESCENDING`, never reached `downEnter`, and returned `DESCENDING -> UP` (wobble).
- **Impact**: In `tests/replay_runner.mjs`, `bad_front_subject_002` scored **0 reps in tsLive** (Python ground truth = 10 reps).

### Root Cause 4: Over-constrained Visibility Gate on Ankles
- **Mechanism**: In `ml/src/features.py`:
  ```python
  min_vis = min(landmarks[i].visibility for i in (L_SHOULDER, R_SHOULDER, L_HIP, R_HIP, L_ANKLE, R_ANKLE))
  if side_score < MIN_VISIBILITY:
      return FrameFeatures(valid=False, ...)
  ```
- **Finding**: In front view (head toward camera), feet and ankles are farthest from the lens and are often occluded by the torso or clipped by the frame. In `good_front_subject_013`, ankle visibility fell to 0.15, causing **every single frame (444/444)** to be marked invalid.

---

## 3. The Solution: Bilateral + Depth-Aware Front-View Pipeline

### 1. View-Aware Architecture
Instead of applying side-view assumptions everywhere, V2 introduces explicit view estimation:
- `VIEW_FRONT`
- `VIEW_SIDE_LEFT` / `VIEW_SIDE_RIGHT`
- `VIEW_DIAGONAL_LEFT` / `VIEW_DIAGONAL_RIGHT`

### 2. Bilateral Signal Extraction (`FrontRepSignalExtractor`)
In front view:
- Extract left elbow angle and right elbow angle.
- Robust bilateral combination: `median(elbowLeft, elbowRight)` or visibility-weighted mean.
- Incorporate vertical motion of the shoulder midpoint in normalized torso space (`shoulderMotion`).
- Track 3D joint angle / depth distance where available.
- Relax `reversal_fraction` ceiling for front view (allow up to 0.28 when ROM is large).

### 3. Two-Stage Motion Calibration
- **Phase A (Camera Calibration)**: Verifies user framing, orientation, visibility of shoulders/elbows/hips. Does NOT calibrate ROM.
- **Phase B (Movement Calibration)**: "Perform 2 normal push-ups". The system captures actual movement extrema from dynamic cycles, preventing the standing-lockout bug.
