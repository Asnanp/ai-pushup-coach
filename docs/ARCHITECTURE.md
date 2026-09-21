# ARCHITECTURE — AI Push-Up Coach

## 1. System Overview

Hybrid architecture. The **rep counter is deterministic geometry** (reliable, explainable).
The **form classifier is a trained ML model** (learns subtle good/bad patterns from the dataset).
Neither is an LLM. No LLM is in the inference path.

```
                      ┌───────────────────────┐
                      │   Webcam (30 FPS)     │
                      └───────────┬───────────┘
                                  │ video frames (LOCAL ONLY)
                                  ▼
                      ┌───────────────────────┐
                      │  MediaPipe Pose       │
                      │  Landmarker (browser) │
                      │  → 33 landmarks       │
                      └───────────┬───────────┘
                                  │ normalized landmarks + visibility
                                  ▼
                      ┌───────────────────────┐
                      │  Landmark Smoother    │
                      │  (One-Euro / EMA)     │
                      └───────────┬───────────┘
                                  │
                  ┌───────────────┴───────────────┐
                  ▼                               ▼
      ┌───────────────────────┐       ┌───────────────────────┐
      │  Biomechanics         │       │  Biomechanics         │
      │  Feature Extractor    │       │  Feature Extractor    │
      │  (per frame)          │       │  (window aggregate)   │
      └───────────┬───────────┘       └───────────┬───────────┘
                  │                               │
                  ▼                               ▼
      ┌───────────────────────┐       ┌───────────────────────┐
      │  REP STATE MACHINE    │       │  FORM CLASSIFIER      │
      │  UP→DOWN→UP           │       │  (GBM / RF model)     │
      │  hysteresis+smoothing │       │  → P(good), P(bad)    │
      └───────────┬───────────┘       └───────────┬───────────┘
                  │ rep boundary event            │
                  ▼                               │
      ┌───────────────────────┐                   │
      │  REP FEATURE WINDOW    │◄──────────────────┘
      │  (frames from the rep) │
      └───────────┬───────────┘
                  │
                  ▼
      ┌───────────────────────┐
      │  FORM ASSESSMENT      │
      │  ENGINE               │
      │  ML prob + geometry   │
      │  → label, issue codes │
      │  → depth/align/tempo  │
      └───────────┬───────────┘
                  │
                  ▼
      ┌───────────────────────┐
      │  WORKOUT SESSION      │
      │  STATE (reducer)      │
      └───────────┬───────────┘
                  │
        ┌─────────┴─────────┐
        ▼                   ▼
  ┌───────────┐      ┌───────────┐
  │  UI       │      │ Supabase  │
  │  (React)  │      │ (persist) │
  └───────────┘      └───────────┘
```

## 2. Where Inference Runs

**Primary path (default, zero-latency, privacy-preserving): in-browser.**

The trained model is exported to a pure-JS / JSON tree format and runs in a Web Worker.
This keeps camera frames on-device, removes network latency from the rep loop, and means
the app still works if the backend is down.

**Secondary path: FastAPI service.** Used for server-side batch scoring, retraining
verification, and as a fallback when the JS model is unavailable.

Both paths must produce **bit-comparable outputs** for the same feature vector — enforced
by `ml/scripts/export_model.py`, which emits both artifacts from one fitted estimator and
writes a parity fixture that the test suite checks.

Rationale: a school IT-fest demo must not depend on venue wifi. In-browser inference
is the correct engineering call here.

## 3. Module Boundaries

| Package | Language | Responsibility | Depends on |
|---|---|---|---|
| `packages/types` | TS | Shared type contracts | — |
| `packages/pose` | TS | MediaPipe wrapper, smoothing, landmark normalization | types |
| `packages/biomechanics` | TS + PY | Joint angles, alignment, depth, tempo features | types |
| `packages/rep-counter` | TS | Finite-state machine, hysteresis, rep boundary events | types, biomechanics |
| `packages/form-engine` | TS | ML prob + geometry → label, issue codes, component scores | types, biomechanics |
| `ml/scripts` | PY | Dataset inspection, extraction, training, evaluation, export | — |

The TypeScript and Python feature extractors are **separate implementations of one
specification** (`FEATURE_SCHEMA.md`). A parity test feeds the same landmark series
through both and asserts agreement. This is the highest-risk integration seam in the
project and is tested explicitly.

## 4. Data Flow at Runtime

1. `CameraEngine` acquires the stream, exposes frames at ~30 FPS.
2. `PoseEngine` runs detection at a **throttled 20 FPS** (configurable). Frames are
   pushed into the pose pipeline; the video element renders independently at full rate
   so the preview never stutters even if pose inference lags.
3. Landmarks are smoothed and normalized (torso-relative).
4. Per frame: biomechanics → rep state machine (`feedFrame`).
5. On a rep completion event, the state machine emits `{ repIndex, frames[] }` — the
   slice of frames spanning that rep.
6. `FormAssessmentEngine` aggregates that window into the model feature vector, runs
   inference, and fuses the ML probability with geometric signals.
7. Session reducer accumulates the rep result, updates counters and the rolling form score.
8. On workout end, the session + per-rep rows are persisted to Supabase.

## 5. Performance Budget

| Stage | Budget | Notes |
|---|---|---|
| Camera → canvas paint | < 33 ms | rAF driven, zero React state |
| Pose inference | < 25 ms/frame | MediaPipe GPU delegate when available |
| Feature extraction | < 1 ms/frame | pure arithmetic |
| Form inference | < 5 ms/rep | runs once per rep, not per frame |
| React re-render | ≤ 4 Hz | metrics are throttled; canvas overlay bypasses React entirely |

**Critical rule:** the pose overlay draws to a `<canvas>`, not to React-rendered SVG.
Landmarks never enter React state. Only *derived, throttled metrics* do.

## 6. Failure Modes & Degradation

| Failure | Behaviour |
|---|---|
| Camera denied | Blocking error state with recovery steps. No fake metrics. |
| MediaPipe model fails to load | Fall back to a reduced pose model; if that fails, disable counting and say so. |
| JS model missing | Form engine runs **geometry-only** and clearly labels scores as `rule-based`, not `model`. |
| Backend unreachable | No user-visible impact (in-browser inference is primary). |
| Pose confidence low | Pause counting, show "pose confidence too low" — do not count garbage. |
| Person leaves frame | Auto-pause. Session is not lost. |

## 7. Privacy Model

- Camera frames are processed **only in the browser**. They are never uploaded.
- No video is recorded or persisted by any code path.
- Only derived numeric features would ever be sent to the backend, and only when the
  optional server path is explicitly enabled.
- The UI states: *"Camera frames are analyzed for pose estimation and are not stored."*
