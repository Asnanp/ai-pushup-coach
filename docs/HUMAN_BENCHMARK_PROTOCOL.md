# Human Benchmark Protocol

**Author**: Agent 17 — Real-World QA Engineer  
**Status**: NOT YET MEASURED (Protocol Established)  
**Date**: 2026-09-21  

---

## 1. Objective

To provide an unpolluted, real-world benchmark of push-up form assessment on unseen human participants, distinct from the initial 24 development/test subjects.

---

## 2. Participant Recruitment & Target

- **Target**: At least 10 diverse individuals with varied body types, arm proportions, and fitness levels.
- **Environment**: Typical school gym or IT fest exhibition booth lighting and framing (laptops on tables, webcams at chest or floor height).

---

## 3. Recording Protocol per Participant

Each participant completes 4 distinct sets of 5 repetitions:

1. **Set 1: Normal Push-ups (Target: GOOD)**
   - Full chest depth ($90^\circ$ elbow or deeper), rigid body alignment, full lockout at top.
2. **Set 2: Shallow Push-ups (Target: BAD — SHALLOW_DEPTH)**
   - Halfway depth (~$120^\circ$ elbow minimum), lockout at top.
3. **Set 3: Pike / Hips-High Push-ups (Target: BAD — HIP_PIKE)**
   - Hips raised above the shoulder-ankle midline throughout the movement.
4. **Set 4: Sag / Hips-Low Push-ups (Target: BAD — HIP_SAG)**
   - Hips drooping toward the floor (only if participant can perform safely and comfortably).

---

## 4. Current Status

```
HUMAN BENCHMARK STATUS: NOT YET MEASURED
```

No synthetic or fabricated human participant data will be added. Observations will be populated in `ml/data/human_benchmark/` only when live recordings with verified consent are captured.
