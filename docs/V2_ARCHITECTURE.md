# AI Push-Up Coach V2 — System Architecture

**Author**: Agent 1 — V2 Lead Architect  
**Status**: APPROVED  
**Date**: 2026-09-21  

---

## 1. System Philosophy & Product Mission

AI Push-Up Coach V2 is an intelligent, real-time exercise coach designed to work reliably when an unknown person walks in front of a laptop webcam at an IT fest booth.

### Key Tenets
1. **Zero Cloud Latency / Offline Independence**:
   - Pose estimation, rep counting, ML form grading, geometry fault detection, and voice coaching run 100% locally in the client browser.
   - All core workout functions continue without degradation when Wi-Fi is physically disconnected or Supabase is unreachable.
2. **Deterministic Mechanics + Learned Form Grading**:
   - Rep boundaries and counting are governed by deterministic biomechanical state machines with personal range-of-motion normalisation.
   - The ML classifier evaluates overall repetition form quality ($P(\text{good})$).
   - Specific biomechanical issue labels (e.g. `SHALLOW_DEPTH`, `HIP_PIKE`, `HIP_SAG`) are diagnosed by measurable deterministic geometry modules, preventing ML "hallucination" of fault causes.
3. **View-Aware Processing**:
   - The system explicitly detects and adapts to camera placement (`FRONT`, `SIDE`, `DIAGONAL`) using bilateral joint analysis in front view and unilateral occlusion-aware tracking in side view.
4. **No LLM in the Loop**:
   - Real-time coaching uses deterministic state machines and low-latency local browser SpeechSynthesis.

---

## 2. End-to-End Pipeline Data Flow

```
                  ┌────────────────────────┐
                  │    CAMERA PREVIEW      │  (getUserMedia @ 30 FPS)
                  └───────────┬────────────┘
                              │  (drop intermediate frames if busy; no queueing)
                              ▼
                  ┌────────────────────────┐
                  │  MEDIAPIPE POSE ENGINE │  (WASM/WebGL client-side)
                  │ 33 Landmarks + Quality │
                  └───────────┬────────────┘
                              │
                              ▼
                  ┌────────────────────────┐
                  │  VIEW ESTIMATOR & LOCK │  (Front / Side-L / Side-R / Diag-L / Diag-R)
                  │  Temporal Hysteresis   │  (Manual Override: AUTO/FRONT/SIDE/DIAGONAL)
                  └───────────┬────────────┘
                              │
                              ▼
                  ┌────────────────────────┐
                  │ NORMALISATION & MOTION │  (Torso-relative coordinates + Bilateral
                  │    SIGNAL EXTRACTORS   │   Front / Unilateral Side / 3D depth)
                  └───────────┬────────────┘
                              │
           ┌──────────────────┴──────────────────┐
           │                                     │
           ▼                                     ▼
 ┌───────────────────┐                 ┌───────────────────┐
 │   V2 REP ENGINE   │                 │  V2 FORM ENGINE   │
 │   Deterministic   │                 │   ML + Geometry   │
 │    View-Aware     │                 │                   │
 │   Adaptive ROM    │                 │ • ML Classifier   │
 │    FSM Counter    │                 │   (P(good), ECE)  │
 └─────────┬─────────┘                 │ • Uncertainty Pol.│
           │                           │ • Geometry Issues │
           │ Rep Boundary              │   (Depth, Pike,   │
           │ Event [Frames]            │    Sag, Lockout)  │
           └─────────────────┬─────────┴─────────┬─────────┘
                             │                   │
                             ▼                   ▼
                   ┌───────────────────────────────────────┐
                   │          FORM FUSION ENGINE           │
                   │    Combines ML + Geometry Issues      │
                   │   Emits RepAssessment (GOOD / BAD /   │
                   │     UNCERTAIN + Measured Scores)      │
                   └──────────────────┬────────────────────┘
                                      │
                                      ▼
                   ┌───────────────────────────────────────┐
                   │           AI COACHING ENGINE          │
                   │  Deterministic State Machine          │
                   │  Cooldowns, Trend & Good Streaks,     │
                   │  Correction Recognition Engine        │
                   └───────┬──────────────┬─────────┬──────┘
                           │              │         │
                           ▼              ▼         ▼
                     ┌───────────┐ ┌───────────┐ ┌───────────┐
                     │ LIVE UI   │ │   VOICE   │ │  SESSION  │
                     │ Canvas +  │ │   COACH   │ │  HISTORY  │
                     │ HUD (4Hz) │ │ SpeechSyn │ │  STORAGE  │
                     └───────────┘ └───────────┘ └─────┬─────┘
                                                       │
                                                       ▼
                                                 ┌───────────┐
                                                 │ CHALLENGE │
                                                 │LEADERBOARD│
                                                 │(Local+Sync│
                                                 └───────────┘
```

---

## 3. Package Responsibilities

| Package / Directory | Responsibility |
| :--- | :--- |
| `packages/types` | Shared contracts, view definitions, rep events, and assessment types |
| `packages/pose` | Landmark smoothing, view estimator, view locking, and manual override |
| `packages/biomechanics` | 2D/3D feature extraction, bilateral front signals, and feature schema V2 |
| `packages/rep-counter` | View-aware FSM, adaptive ROM calibration, and false-rep prevention |
| `packages/form-engine` | ML JSON model evaluator, probability calibration, and deterministic issue detectors |
| `packages/coach-engine` | Intelligent coaching state machine, speech queueing, and correction verification |
| `apps/web` | Next.js 15 app, direct canvas overlay, responsive HUD, challenge mode, and offline service |
| `ml/` | Python training pipelines, GroupKFold cross-validation, and model export |

---

## 4. Privacy & Offline Guarantees

- **No Video Upload**: Webcam streams never leave browser memory.
- **No Frame Capture Storage**: Frames are analyzed in volatile memory and discarded immediately.
- **Offline Assets**: MediaPipe WASM and the task landmarker are served locally from `apps/web/public/mediapipe/wasm/` and `apps/web/public/models/`.
- **Zero Network Inferences**: No external API requests are made during workouts.
