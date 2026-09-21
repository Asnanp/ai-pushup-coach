# Live Human Benchmark Protocol (V3)

Dataset replay is **secondary**. V3 may not ship on prerecorded clips alone.

This protocol records **numerical pose traces only**. No RGB video, no camera
frames, no canvas pixels.

Lab route: `/lab/live-counter`  
Workout debug: `/workout?debug=1` → Export debug JSON

---

## Session recipe (ordinary, not exhausting)

Each unseen person, once they understand the camera:

1. 5 normal reps
2. 3 intentionally shallow reps
3. pause
4. 3 normal reps

Separately (short):

- slow push-up
- fast push-up
- bottom pause
- top pause
- partial descent
- person leaves frame, then returns

Do this in **FRONT** and **SIDE**. Diagonal if time allows.

Target: 10+ unseen users. The person who reported “I am doing push-ups but it
is not catching my reps” is a **mandatory** regression case — export that
exact live numerical trace and keep it as a fixture.

---

## What to export

From `/lab/live-counter` → **Export debug JSON**.

The file contains per-frame:

- timestamp, view, view confidence
- left/right shoulder, elbow, wrist x/y/z/visibility
- hip/shoulder centers
- 2D and 3D elbow angles, fused angle
- shoulder image motion, world-Z, torso world-Z
- pose confidence, raw/filtered phase, FSM state
- candidate cycle id, rep emitted?, rejection reason
- personal / adaptive ROM

Replay that JSON through `V3RepEngine` — do not require the camera tape.

---

## Pass / fail (physical product)

For 10 clear ordinary push-ups:

| Detected cycles | Verdict |
| :--- | :--- |
| ~10 | pass |
| 2 | **FAIL** |
| 16 | **FAIL** |

Engineering targets (do not fabricate):

- precision ≥ 95%
- recall ≥ 95%
- F1 ≥ 95%
- MAE ≤ 0.5 reps / set
- exact-count rate ≥ 80%
- within ±1 ≥ 95%

Event matching uses temporal overlap (`matchRepEvents`), not raw totals.

---

## Privacy

Video stays on device. Traces are numbers. UI copy:

> Video is processed on this device and is not stored.
