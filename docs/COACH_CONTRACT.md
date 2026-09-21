# Coaching Engine Contract & State Machine

**Author**: Agent 13 — Coach Engineer & Agent 14 — Voice Engineer  
**Status**: APPROVED  
**Date**: 2026-09-21  

---

## 1. Responsibilities

The AI Coaching Engine is a deterministic state machine that receives real-time `RepAssessment` objects, monitors repetition trends, provides corrective feedback, and validates whether user corrections actually occurred.

---

## 2. State & State Tracking

The coach state machine maintains the following history:

```typescript
export interface CoachState {
  lastIssue: string | null;
  issueStreak: number;
  lastSpokenIssue: string | null;
  lastSpokenAt: number;           // timestamp in seconds
  previousAssessment: RepAssessment | null;
  correctionPending: {
    targetIssue: string;
    baselineMetric: number;       // metric value when warning was issued
    issuedAtRep: number;
  } | null;
  goodStreak: number;
  recentFormTrend: number[];      // rolling last 5 overall form scores
  recentDepthTrend: number[];     // rolling last 5 depth scores
  recentAlignmentTrend: number[]; // rolling last 5 alignment scores
}
```

---

## 3. Cooldown & Anti-Spam Policy

To prevent annoying or overlapping audio feedback:
- **Minimum Cooldown**: At least $4.0$ seconds between spoken voice instructions.
- **Repeat Suppression**: The same corrective issue is NOT repeated on consecutive repetitions unless `issueStreak >= 3` and cooldown has elapsed.
- **Positive Reinforcement**: Every 5 consecutive good repetitions triggers a streak encouragement (e.g. "Five solid reps, keep going").
- **Voice Modes**:
  - `OFF`: Visual HUD feedback only, no audio.
  - `NORMAL`: Corrective warnings and streak announcements.
  - `ACTIVE`: Full audio cues for transitions, reps, and corrections.

---

## 4. Correction Recognition Specification

A hallmark feature of V2 is acknowledging when a user corrects their form:
1. **Warning Trigger**:
   - User performs rep with a clear geometric fault (e.g. `SHALLOW_DEPTH` with `depthScore = 55` or `HIP_PIKE` with `alignmentScore = 58`).
   - Coach issues verbal guidance: `"Go a little lower"` or `"Keep your body straight"`.
   - Coach stores `correctionPending` with `{ targetIssue: 'SHALLOW_DEPTH', baselineMetric: 55, issuedAtRep: 4 }`.
2. **Evaluation on Subsequent Rep(s)**:
   - On rep 5, user descends deeper: `depthScore = 82` and issue is cleared.
   - The engine checks:
     $$\Delta \text{metric} = \text{currentMetric} - \text{baselineMetric} \ge +15$$
   - Because the measured metric improved and the fault cleared, coach triggers:
     - Voice cue: `"Better depth"` or `"Good correction"`
     - UI badge: `GOOD — CORRECTED`
   - If form did not measurably improve, the coach **never fabricates** a correction compliment.
