# Repetition Motion Signal Schema & Extractor Contracts

**Author**: Agent 4 — Rep Counter Engineer & Agent 2 — Front-View Research Engineer  
**Status**: APPROVED  
**Date**: 2026-09-21  

---

## 1. Shared Signal Interface

All view-specific signal extractors expose their instantaneous kinematic signals through a shared interface consumed by the finite-state machine:

```typescript
export interface RepMotionSignal {
  timestamp: number;              // seconds
  phaseEvidence: number;          // primary scalar signal for FSM (normalized angle or displacement)
  elbowLeft: number;              // degrees, or NaN
  elbowRight: number;             // degrees, or NaN
  elbowCombined: number;          // robust bilateral combination (degrees)
  shoulderMotion: number;         // vertical / depth displacement of shoulder centroid
  hipMotion: number;              // vertical / depth displacement of hip centroid
  worldDepthMotion: number;       // 3D displacement if world landmarks available
  poseConfidence: number;         // [0, 1] frame tracking reliability
  view: CameraView;               // view used for this extraction
}
```

---

## 2. View-Specific Extractors

### `SideRepSignalExtractor`
- Operates on the dominant visible side (`left` or `right`).
- Primary `phaseEvidence`: filtered elbow flexion angle on the visible side.
- Filters: Anatomical plausibility masking $[25^\circ, 179.5^\circ]$, causal low-pass smoothing, and median spike rejection.
- Body line alignment and shoulder height delta complement tracking.

### `FrontRepSignalExtractor`
- Operates **bilaterally**: consumes both left and right arm landmarks simultaneously.
- `elbowCombined`: Robust weighted median/combination:
  $$\text{elbowCombined} = \frac{v_L \cdot \theta_L + v_R \cdot \theta_R}{v_L + v_R}$$
  with outlier clamping if one arm collapses.
- Primary `phaseEvidence`: Combines bilateral elbow flexion with normalized vertical displacement of the shoulder-center:
  $$\text{phaseEvidence} = 0.70 \cdot \text{elbowCombined} + 0.30 \cdot (180^\circ - \Delta Y_{\text{shoulder}} \cdot K)$$
- Reversal tolerance: Supports reversal fractions up to $0.28$ when primary range of motion is sufficient ($\ge 25^\circ$).

### `DiagonalRepSignalExtractor`
- Blends near-side arm kinematics with bilateral torso orientation.
- Prioritizes the near arm while using the far shoulder/hip for 3D perspective correction.

---

## 3. Finite-State Machine Contract

```
       ┌───────────────────────────────┐
       │             READY             │
       └───────────────┬───────────────┘
                       │ (angle >= upExit / extended)
                       ▼
       ┌───────────────────────────────┐
       │              UP               │
       └───────────────┬───────────────┘
                       │ (angle < upExit / downward trend)
                       ▼
       ┌───────────────────────────────┐
       │          DESCENDING           │
       └───────────────┬───────────────┘
                       │ (angle <= downEnter / personal bottom reached)
                       ▼
       ┌───────────────────────────────┐
       │             DOWN              │
       └───────────────┬───────────────┘
                       │ (angle >= downExit / upward trend)
                       ▼
       ┌───────────────────────────────┐
       │           ASCENDING           │
       └───────────────┬───────────────┘
                       │ (angle >= upEnter / return to top band)
                       ▼
         [ EMIT REP EVENT: COMPLETE ]
```

---

## 4. Personal Range-of-Motion (ROM) Normalisation

Rather than forcing universal angles (e.g. demanding every human bend to exactly $90^\circ$ to register a repetition), the V2 engine maps personal excursion into a normalized phase:

$$\text{Phase}(t) = \text{clamp}\left(\frac{\text{observedTop} - \text{signal}(t)}{\text{observedTop} - \text{observedBottom}}, 0.0, 1.0\right)$$

- **Top Region**: $\text{Phase} \le 0.25$
- **Bottom Region**: $\text{Phase} \ge 0.75$
- **Hysteresis Bands**:
  - `upEnter`: $\text{Phase} \le 0.20$
  - `upExit`: $\text{Phase} \ge 0.32$
  - `downEnter`: $\text{Phase} \ge 0.78$
  - `downExit`: $\text{Phase} \le 0.68$

This mathematical formulation ensures that shallow, full, or modified push-ups are captured cleanly, leaving quality evaluation to the form grading engine.
