# View Estimation & Orientation Schema

**Author**: Agent 3 — View-Detection Engineer  
**Status**: APPROVED  
**Date**: 2026-09-21  

---

## 1. Supported Camera Orientations

```typescript
export type CameraView =
  | 'VIEW_UNKNOWN'
  | 'VIEW_FRONT'
  | 'VIEW_SIDE_LEFT'
  | 'VIEW_SIDE_RIGHT'
  | 'VIEW_DIAGONAL_LEFT'
  | 'VIEW_DIAGONAL_RIGHT';

export type UserViewMode = 'AUTO' | 'FRONT' | 'SIDE' | 'DIAGONAL';
```

---

## 2. View Estimation Contract

The view estimator analyzes landmark spatial relationships in the camera coordinate frame and produces a structured estimate:

```typescript
export interface ViewEvidence {
  shoulderWidthRel: number;       // ||L_SHOULDER - R_SHOULDER|| / torsoHeight
  hipWidthRel: number;            // ||L_HIP - R_HIP|| / torsoHeight
  shoulderDepthDiff: number;      // |L_SHOULDER.z - R_SHOULDER.z|
  hipDepthDiff: number;           // |L_HIP.z - R_HIP.z|
  visibilitySymmetry: number;     // 1.0 - |visLeft - visRight| / max(visLeft, visRight)
  bodyAspectRatio: number;        // apparent width / height in screen space
  torsoYawDeg: number;            // estimated yaw from shoulder/hip vectors
}

export interface ViewEstimate {
  view: CameraView;
  confidence: number;             // [0, 1]
  evidence: ViewEvidence;
  isLocked: boolean;              // true once calibration completes
}
```

---

## 3. Geometric Classification Rules

Let $W_s = \text{shoulderWidthRel}$, $W_h = \text{hipWidthRel}$, and $S_{vis} = \text{visibilitySymmetry}$.

1. **Front View (`VIEW_FRONT`)**:
   - Both shoulders and hips clearly visible with high symmetry: $S_{vis} \ge 0.75$.
   - Broad apparent shoulder width relative to torso: $W_s \ge 0.55$.
   - Low depth disparity between shoulders: $\Delta z_{shoulder} \le 0.18$.
2. **Side View (`VIEW_SIDE_LEFT` / `VIEW_SIDE_RIGHT`)**:
   - Severe visibility asymmetry: $S_{vis} \le 0.50$.
   - Narrow apparent shoulder width: $W_s \le 0.32$.
   - Side determined by whichever side has dominant visibility ($vis_{left} > vis_{right} \implies \text{LEFT}$).
3. **Diagonal View (`VIEW_DIAGONAL_LEFT` / `VIEW_DIAGONAL_RIGHT`)**:
   - Intermediate shoulder width: $0.32 < W_s < 0.55$.
   - Moderate symmetry: $0.50 < S_{vis} < 0.75$.
4. **Unknown (`VIEW_UNKNOWN`)**:
   - Insufficient key landmarks detected or visibility $< 0.40$.

---

## 4. Stability & Temporal Smoothing (Hysteresis)

- **Sliding Voting Window**: Rolling buffer of 15 frames (~0.5s).
- **View Transition Margin**: To transition between view classes during AUTO mode, the challenger view must win $\ge 70\%$ of window votes with confidence $\ge 0.65$.
- **Calibration Lock**: Once Phase B (Movement Calibration) completes, the detected view is **LOCKED** for the remainder of the workout session unless pose tracking is persistently lost for $> 45$ consecutive frames.
- **Manual Mode Priority**: If the user selects `FRONT`, `SIDE`, or `DIAGONAL`, the manual selection strictly overrides automatic detection.
