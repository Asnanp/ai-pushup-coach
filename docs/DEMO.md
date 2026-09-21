# DEMO.md — Booth Script, Choreography & Judge Defence

Everything below describes what the app **actually does**, read from the source.
Every number is one that was verified in the repository, and the file it came from
is named next to it. Where a number is not verifiable, it is not stated.

The single most important fact for the presenter: **the live demo is the
centrepiece.** The talking is scaffolding around two minutes of a real person doing
real push-ups while the app scores them. If you run out of time, cut the explanation,
never the demonstration.

---

## 0. The one-paragraph version (memorise this)

The app watches you do a push-up through the webcam. It counts reps with a
deterministic state machine over your elbow angle, and it judges form with a
gradient-boosted tree classifier that runs in the browser. The rep thresholds are
**calibrated from your own range of motion** before the set starts, not hard-coded.
No video leaves the device. The form classifier was measured at **0.688 accuracy on
unseen subjects** — and we say that number out loud rather than rounding it up.

---

## 1. Pre-demo checklist

Run this list in order. Do not skip the dry run.

| # | Item | Detail |
|---|---|---|
| 1 | **Power** | Laptop charged to 100% **and** plugged in. Pose inference is GPU/CPU heavy; battery-saver mode throttles it. Disable any "battery saver" or "low power mode". |
| 2 | **Network — you do not need it** | Nothing the demo does touches the network. The form classifier is a JSON file in `apps/web/public/models/`, and the MediaPipe WASM runtime and pose landmarker are served from `apps/web/public/mediapipe/wasm/` and `apps/web/public/models/pose_landmarker_full.task`. `POSE_ASSET_SOURCES` (`packages/pose/src/pose-engine.ts:45-57`) tries **local first** and only falls through to the CDN if the local copies are absent. Verify the assets are there: `npm run fetch:pose-assets` should print `WASM already present (4 files)` and `Pose model already present`. If it downloads instead, run it now — before the booth, not at it. |
| 3 | **Browser** | Chrome or Edge (Chromium). WebGL2 is used for the GPU delegate; the engine falls back to CPU if GPU init fails (`pose-engine.ts:132-136`), but Chrome gives the smoothest result. Do not use a browser with camera-blocking extensions. |
| 4 | **Camera permission** | Pre-grant it. Open `/workout`, press **Start Workout**, allow the camera, confirm the video appears, then reload and press Start again. A permission prompt during the demo costs you 15 seconds and a visible stall. |
| 5 | **Screen resolution** | ≥1280×720. The workout layout is a 3fr/2fr two-column grid at `lg` and stacks below that (`app/workout/page.tsx:239`). At laptop width the camera column and the metrics column both stay visible; on a narrow window they stack and the judge can no longer see the metrics next to the video. Full-screen the browser. |
| 6 | **Physical space** | You need roughly 2 m of floor depth in front of the laptop, on the **camera's side** (the person lies parallel to the screen, seen from the side). Put a mat or towel down. Clear the background so the frame is not busy. |
| 7 | **Lighting** | Light the *presenter*, not the wall behind them. Strong backlighting fails the `lighting` calibration check (`sideVisibility ≥ 0.6`, `workout-session.ts:203`). |
| 8 | **Framing** | Whole body including the **feet** must be visible. The `full-body` calibration check requires both ankles tracked and unclipped for the last 10 frames (`workout-session.ts:190-192`). Kneel down and check that your ankles are on screen before you start. |
| 9 | **Seed some history** | A fresh browser shows the empty state on `/progress` and `/leaderboard`. Complete one short workout and one 30-second challenge on the booth machine beforehand so the charts and the board have data. Sessions live under the localStorage key `aipc:sessions:v1` (`docs/UX_FLOW.md §9`). |
| 10 | **Backup recording** | Record a screen capture of one successful full run — calibration, good reps, bad reps, result screen — and keep it on the desktop. If the camera dies mid-demo, you play the recording and keep talking. This is the backup, see §5. |
| 11 | **Dry run, 10 minutes before** | Do one complete end-to-end run: Start Workout → calibration passes → 3 good reps → End Workout → progress → challenge → leaderboard. This confirms the camera, the pose assets and the localStorage history are all good. If you want to prove offline operation to a judge, turn the wifi **off** and hard-reload with DevTools → Network → *Disable cache* checked — the skeleton must still animate. A warm cache would make any CDN-hosted app look offline, so the disabled cache is what makes the claim real. |

**Do not** leave the camera stream running between demos. `CameraEngine.stop()` runs
on unmount, on End Workout, and before every new start (`app/workout/page.tsx:87-96`).
A leaked stream leaves the camera LED on, which looks like spyware at a public booth.

---

## 2. Timed script (~5 minutes)

| Time | Segment | Duration | Lead |
|---|---|---|---|
| 0:00–0:30 | The problem | 30 s | Presenter, spoken |
| 0:30–1:00 | What the app does | 30 s | Presenter, spoken |
| 1:00–3:30 | **Live demo** | **2 min 30 s** | Choreography §3 |
| 3:30–4:15 | How it works | 45 s | Bullet cues |
| 4:15–4:45 | Results (the real numbers) | 30 s | Bullet cues |
| 4:45–5:00 | Limitations + close | 15 s | Presenter, spoken |

### 0:00–0:30 — The problem (say this)

> "Everyone learns push-ups wrong. In PE you get one coach for thirty students, so
> nobody corrects your depth, your hips, or your tempo. You do a hundred reps and
> groove the same mistake. A mirror shows you that you moved — it doesn't tell you
> *what* you did wrong or *when*. We built a coach that watches every rep and tells
> you the fault, in the browser, with no video ever leaving your laptop."

### 0:30–1:00 — What the app does (say this)

> "There are two systems here and they are deliberately different. Rep counting is
> plain geometry — a state machine over your elbow angle, so a rep boundary is
> explainable and repeatable. Form judging is a trained machine-learning classifier
> over 34 measured features. Neither one is an LLM. Before you start, the app
> calibrates your own range of motion so the counter works for your body, not an
> average body. Then it scores every rep, counts bad reps instead of hiding them, and
> puts your 30-second challenge on a leaderboard."

### 1:00–3:30 — Live demo

Follow the choreography in §3 exactly. Keep talking over it, but do not narrate every
click. The two things you must *say* while it runs:

- "Watch the camera check — those thresholds are being derived from **me**, right now."
- "That rep was bad and the app said *which* fault it was. It's not guessing; it measured it."

### 3:30–4:15 — How it works (bullet cues)

- Camera → MediaPipe Pose → 33 landmarks, **all in the browser**.
- Landmarks → joint angles → a rep state machine (UP/DOWN) with hysteresis.
- Thresholds come from calibration: `upEnter = 0.72` of your span, `downEnter = 0.22`
  (`packages/rep-counter/src/rep-counter.ts:21-24`).
- On each rep boundary, the frames of that rep become a 34-feature vector.
- A **gradient-boosted tree** classifier scores it. Runs as a JSON tree walk in the
  browser — no server round-trip.
- The final rep score blends geometry (0.65) and model probability (0.35)
  (`docs/FORM_SCORE.md §2`).
- Everything numeric is throttled to the UI at 4 Hz; the skeleton is drawn on a
  canvas, never through React (`apps/web/lib/workout-session.ts:86`).

### 4:15–4:45 — Results (bullet cues, real numbers)

- Model: `GradientBoostingClassifier`, 34 of a 37-feature contract
  (`ml/models/pushup_form_model.metadata.json:2,40-41`).
- Decision threshold: **0.58** (`metadata.json:51`).
- Held-out test: **accuracy 0.688**, macro-F1 0.672, ROC-AUC 0.702
  (`ml/reports/metrics.json:148-152`).
- Test set: **205 reps from 4 subjects who are not in training**
  (`metrics.json:55-56,84-86`).
- Parity: the browser model reproduces scikit-learn to machine precision, documented
  at **1.1e-16** (`apps/api/README.md:129`).

### 4:45–5:00 — Limitations + close (say this)

> "It's honest about what it can't do. It's a good/bad classifier at about 0.69
> accuracy on people it has never seen — not a doctor, not a coach. When it can't
> track you reliably it says so instead of inventing a score. And when a rep is bad,
> it records it as bad instead of deleting it, because deleting it would be lying to
> you about your own training. Thank you."

---

## 3. Live demo choreography

Do these in order. The camera is on the presenter's own body — this is the point.
Total ~2 min 30 s.

### Step 1 — Show the calibration adapting to you (0:00–0:45)

1. On `/workout`, confirm the view selector is on **Side** (best for depth, body line
   and the elbow angle — `docs/UX_FLOW.md §3.3`). Press **Start Workout**.
2. The **Camera check** panel appears with six rows: Full body in frame, Pose detected,
   Side view, Lighting, Distance, Range of motion detected (`lib/workout-session.ts`,
   `getCalibrationState`).
3. **Say:** "Watch these rows. Every one is a real measurement from my body right now.
   The panel polls my state five times a second." (It polls every 200 ms,
   `components/CalibrationPanel.tsx`.)
4. Deliberately fail one, then fix it. E.g. turn to face the camera: the **Side view**
   row goes red and shows the hint *"Turn sideways to the camera for the most accurate
   analysis."* Turn back side-on and it passes. **Say:** "That's the app telling me my
   geometry is untrustworthy, instead of scoring me on bad data." (The view check
   follows the selected camera view — switch to Front and it expects you to face the
   camera instead; front push-ups count too.)
5. Get into push-up position and do **two or three slow practice push-ups**. The
   **Range of motion detected** row goes green only once the collected window contains
   a real movement range — holding perfectly still never completes calibration
   (`workout-session.ts`, `calibrationHasRom`).
6. **Say the key line:** "**Start counting** is disabled until all six pass. And those
   thresholds are not 90 and 160 degrees — they're derived from **my** range of motion.
   A fixed 155-degree threshold once produced zero reps for a whole subject whose
   elbows only reached 136 degrees. That's why calibration exists."
7. When every row is green, press **Start counting**.

### Step 2 — Three GOOD reps (0:45–1:30)

Do three clean push-ups: **full depth** (elbow to about 90°, chest to fist height),
**body in one straight line**, **about 2 seconds down, 2 seconds up**.

- After each rep the **Feedback** panel (bottom left) reads **"Good form!"** with
  *"Keep your body straight and maintain a steady tempo."* (`feedback.ts:83-88`).
- The **Form analysis** meters — Depth, Body alignment, Tempo, Consistency, Range of
  motion — fill in. (`docs/UX_FLOW.md §11`.)
- **Say:** "Elbow angle, state and cycle percentage are live in the chips under the
  video. That's the state machine, not the model."

### Step 3 — Two deliberately BAD reps (1:30–2:00)

Induce **specific** faults so a **specific** metric catches them. Say which one you are
about to do.

| Bad rep | How to do it | `IssueCode` that fires | Precondition (`docs/FORM_SCORE.md §5`) | Feedback you should see | Meter that drops |
|---|---|---|---|---|---|
| **Rep 1 — shallow** | Stop high; let the elbow stay above ~105°. | `INCOMPLETE_DEPTH` | `min_elbow_angle > 105` | Headline **"Go deeper"** — *"Your chest is not getting close enough to the floor at the bottom of the rep."* | **Depth** |
| **Rep 2 — sagging hips** | Let the hips drop toward the floor through the rep. | `HIPS_DROPPING` | `body_line_deviation_mean > 0.10` | Headline **"Hips are sagging"** — *"Your hips are dropping toward the floor instead of staying in line with your body."* | **Body alignment** |

Alternative if you cannot sag cleanly: do a **rushed** rep under 0.9 s →
`TOO_FAST` (`rep_duration_s < 0.9`) → **"Slow down"** → **Tempo** drops.
Or a **partial-range** rep with under 30° of elbow travel → `PARTIAL_RANGE`
(`rom_elbow_deg < 30`) → **"Use your full range"**.

**Say after each:** "That's `INCOMPLETE_DEPTH` — the app measured my minimum elbow
angle and it was above 105 degrees, so it can name the fault. It doesn't guess. If no
geometric rule fires, it says *'Form needs attention'* and refuses to invent a cause."

**Honesty note for the presenter:** if you don't actually produce the precondition,
the rep can still come back labelled bad **without** a named issue, and the headline
will be **"Form needs attention"** with *"no single fault stood out strongly"*
(`feedback.ts:131-139`). That is the app working as designed — say so, don't panic.
Also note: on the live screen `borderline` is forced to `false`, so the
**"Good rep — just"** branch cannot appear during a live set
(`app/workout/page.tsx:210-225`; `docs/UX_FLOW.md §11`).

### Step 4 — Finish the set and show the result (2:00–2:15)

1. Press **End Workout** (enabled while `active` or `calibrating`).
2. Camera and pose stop; the session persists; the screen becomes the result card:
   **"Session complete"** — *"Your results were saved. Open Progress to see your
   history."* with **Try again** and **View progress** (`page.tsx:574-591`).
3. Note that this result card is deliberately minimal — the per-rep detail is on
   `/progress`. If a judge asks "where's the score", press **View progress**.

### Step 5 — Show the form score and the leaderboard entry (2:15–2:30)

1. On `/progress`, point at the **Average form score** tile and the **Form score over
   time** chart. The score is `mean(rep_score over all reps)` — **invalid reps count
   equally** (`docs/FORM_SCORE.md §3`). Below 3 reps it is labelled **provisional**;
   at zero reps it shows **`--`**, never `0`.
2. Open `/challenge` in a new tab, enter a name (≤24 characters), press **Start 30
   seconds**, do as many **valid** reps as you can. Finish → **Final result: N valid
   reps** → **View leaderboard**.
3. On `/leaderboard`, point at your row (marked **Your run**) and read the ranking
   rule off the card: **valid reps (highest) → form score (highest) → duration
   (shortest) → submitted (earliest)** (`docs/UX_FLOW.md §10.1`).
4. **Say the punchline:** "Only valid reps score. A bad rep is shown but earns nothing,
   so you can't win by flailing fast."

---

## 4. What to say when it goes wrong

Find your symptom, read the row. "Audience sees" is the literal on-screen text.

| Trigger | Audience sees (real UI copy) | What to say | What to do |
|---|---|---|---|
| **Camera permission blocked** | `PERMISSION_DENIED` — **"Camera permission denied"** / *"Your browser blocked camera access. Click the camera icon in the address bar and allow access, then try again."* Retry button shown. | "The browser is blocking the camera — this is a permission prompt, not a bug. Give me one second." | Click the camera icon in the address bar → Allow → **Retry**. |
| **Camera not found** | `NO_CAMERA` — **"No camera found"** / *"We could not find a camera on this device. Connect a webcam and reload the page."* | "The webcam dropped off. Reloading." | Check the USB, then **Retry** / reload. |
| **Another app holds the camera** | `CAMERA_IN_USE` — **"Camera is in use"** / *"Another application (Zoom, Teams, or another tab) is using the camera. Close it and try again."* | "Another tab has the camera. Closing it." | Close the other tab/app, then **Retry**. Check for a second booth tab too. |
| **Opened over plain http on a LAN IP** | `INSECURE_CONTEXT` — **"Camera requires a secure connection"** / *"Camera access only works over https:// or on localhost. Open the app at http://localhost:3000."* **No Retry button** — this is the only non-recoverable code. | "Camera access needs https or localhost. Switching to localhost." | Re-open at `http://localhost:3000`. Do not waste time clicking Retry — it is not there. |
| **Camera starts but no video** | `INIT_FAILED` — **"Could not start the camera"** / *"The camera started but no video arrived. Try reloading, or select a different camera."* | "The stream didn't attach. Reloading the page." | **Retry** or reload. If it repeats, try a different camera. |
| **Pose model fails to load** | `MODEL_UNAVAILABLE` — **"Pose model unavailable"** / *"The pose detection model could not be loaded. Rep counting is disabled. Check your internet connection and reload."* | "The pose model didn't load. Everything is served from the laptop, so this means the asset step was skipped — not that the wifi died." | **Retry**. If it repeats, the served assets are missing: run `npm run fetch:pose-assets` and `npm run build`, or fall back to the pre-recorded backup (§5) and demo `/progress` and `/leaderboard`, which need no camera. |
| **Presenter leaves the frame** | `NO_PERSON` — **"No person detected"** / *"Step into the frame so we can see your full body."* | "It lost me. Stepping back in." | Step back into frame. |
| **Pose detection drops mid-set** | Overlay: **"Pose lost — step back into frame"**. After **12 consecutive invalid frames** (≈0.6 s at 20 fps) the session auto-pauses (`workout-session.ts:119,352-362`). | "It auto-paused because it lost me — it does that rather than count garbage. It'll resume by itself." | Get back in frame. Counting **auto-resumes** on the next valid frame; paused time is subtracted from the elapsed clock, so the timer never inflates. |
| **Joints tracked but unreliable** | `LOW_CONFIDENCE` — **"Pose confidence is low"** / *"We can see you but cannot track your joints reliably. Improve the lighting, or move away from a busy background."* | "The lighting is weak, so it's telling me it can't trust the geometry." | Improve lighting or simplify the background. The overlay also dims unreliable joints — point that out, it's a feature. |
| **Wrong view** | `TURN_SIDEWAYS` — **"Please turn sideways"** / *"Side view gives the most accurate push-up analysis. Turn so the camera sees you from the side."* | "It wants a side view for depth and body-line accuracy." | Turn side-on. |
| **Too close / feet cut off** | `MOVE_FARTHER` — **"Move further from the camera"**; or `FEET_OUT_OF_FRAME` — **"Your feet are outside the frame"** / *"Move further from the camera so your whole body, including your feet, is visible."* | "My feet are out of frame — push-up alignment depends on the ankles, so it refuses to score." | Move back until the ankles are visible. |
| **Model genuinely uncertain** | Feedback headline **"Form could not be scored"** / *"We could not track your body reliably enough to judge this rep."* (warning tone). | "It's telling me it couldn't score that rep. That's the honest-uncertainty rule — it won't invent a number." | Nothing to fix; this is correct behaviour. Carry on. |
| **Rep count looks wrong (too low)** | No error; counter just doesn't increment. | "The counter needs the elbow to cross its thresholds, which were set from my calibration. My rep didn't go far enough for it." | Do a fuller-range rep. If the whole set miscounts, **End Workout** and restart so calibration re-runs. |
| **Rep count looks wrong (too high)** | Extra reps register. | "It counted a partial movement as a rep — that's why we set the detectable-range floor deliberately low, so a shallow rep is scored as invalid rather than silently dropped." | Nothing to fix; it's intended. The invalid count will show it. |
| **Optional backend unreachable** | `BACKEND_UNAVAILABLE` — **"Analysis service unavailable"** / *"Running with on-device form scoring. Your workout still counts."* | "The backend is down and it doesn't matter — scoring runs in the browser." | Nothing. Workout continues. |
| **Anything unmapped** | `UNKNOWN` — **"Something went wrong"** / *"An unexpected camera error occurred. Reload the page to try again."* | "Unmapped error. Reloading." | Reload. |

If the trained model file itself is missing, the engine runs **geometry-only** and the
UI labels the source **"Rule-based scoring (model not loaded)"** rather than faking a
model score (`page.tsx:268-272`; `docs/UX_FLOW.md §7`).

---

## 5. Backup plan if the camera fails outright

Do not improvise this live. In order:

1. **Play the backup recording.** Full-screen the pre-recorded successful run (item 10
   in §1) and narrate over it. You lose interactivity, not the story.
2. **Demo the camera-free pages.** `/progress` and `/leaderboard` need no camera. Show
   the form-score trend, the consistency chart, the history table, and the ranking rule.
   The booth machine should already have seeded history (§1 item 9).
3. **Show the model artefacts.** `ml/reports/metrics.json` and
   `ml/models/pushup_form_model.metadata.json` open in an editor make the "real
   metrics, subject-independent split" answer concrete.
4. **Re-attempt the camera** only between visitors, never in front of a waiting judge.

The one thing you must not do is claim the app is running when it is not. The app's
own design rule — show `--` rather than a fabricated number — applies to the presenter
too.

---

## 6. Technical Q&A defence

Answer these plainly. Where the honest answer is "it's not perfect", say so first.

### "Is this just an LLM?"

No. There is no LLM anywhere in the inference path (`docs/ARCHITECTURE.md §1`). Form
assessment is a **gradient-boosted tree classifier** — `GradientBoostingClassifier`
(`ml/models/pushup_form_model.metadata.json:2`) — over **34 measured geometric
features** of a **37-feature contract** (`metadata.json:40-41`). The decision threshold
is **0.58** (`metadata.json:51`). The classifier runs as a dependency-free JSON tree
walk in the browser. Rep counting is a deterministic state machine, not learned at all.
The only language-model-like thing in the project is the copy layer that turns an
`IssueCode` into a sentence, and that is a lookup table (`feedback.ts:30-81`).

### "How accurate is it?"

**Accuracy 0.688** on the held-out test set. Not rounded up. Precisely:
accuracy 0.6878, macro-F1 0.672, ROC-AUC 0.702, precision-good 0.732, recall-good
0.756, precision-bad 0.615, recall-bad 0.585 (`ml/reports/metrics.json:148-157`).

Explain what that means: it is a **binary good/bad classifier on unseen subjects**, on
205 test reps (`metrics.json:56`). It is better at recognising good form than bad form
(recall-good 0.756 vs recall-bad 0.585). It is a useful signal, not a verdict — which
is exactly why geometry carries 0.65 of the rep score and the model only 0.35
(`docs/FORM_SCORE.md §2`).

If a judge pushes: the confusion matrix is `[[93, 30], [34, 48]]` (`metrics.json:158-167`)
— 93 true-good and 48 true-bad correct, 30 good called bad, 34 bad called good.

### "How did you stop the same person appearing in both train and test?"

**Subject-independent split.** The 24 subjects are partitioned into 16 train, 4
validation and 4 test, by a **sha256-hash-banded** assignment
(`metrics.json:87`, `metadata.json:148`). The test subjects — **010, 016, 023, 024** —
appear in no other split (`metrics.json:81-86`).

Why it matters: a random *video* or *rep* split leaks identity. The classifier can
learn "this is subject 016's body" or read capture conditions as a proxy for the
person, and the test score inflates. We measured this directly — the seven
capture-quality features (`mean_visibility`, `jitter_*`, `low_confidence_ratio`,
`tracking_gap_ratio`) were **excluded** because including them let the model read
capture conditions as identity: macro-F1 fell from **0.670 to 0.587** and bad-form
recall from **0.620 to 0.434** (`metadata.json:42-51`). The per-subject test accuracies
also spread widely — 0.861, 0.607, 0.444, 0.781 (`metrics.json:186-203`) — which is the
honest picture of generalising to a new person, not a single flattering average.

### "Does it store my video?"

No. Pose estimation runs entirely in the browser via MediaPipe (`docs/ARCHITECTURE.md
§2, §7`). Frames never leave the device; no code path records or uploads video. Only
**numeric** results are persisted. The UI states it on both the workout screen and the
calibration panel: *"Camera frames are analyzed for pose estimation and are not
stored."* Storage is **localStorage-first** (`aipc:sessions:v1`), with Supabase as an
optional mirror — a deliberate choice so a demo does not depend on venue wifi
(`docs/UX_FLOW.md §11`).

### "What happens if the venue wifi dies?"

Nothing. The whole pipeline is local, and that was an engineering decision rather
than a happy accident. Two things normally come from a CDN in a MediaPipe app —
the WASM runtime and the pose landmarker — and both are served from this repo
(`apps/web/public/mediapipe/wasm/`, `apps/web/public/models/pose_landmarker_full.task`,
~28 MB total). `POSE_ASSET_SOURCES` tries local first and the CDN only as a
fallback, so a laptop with the cable pulled out still counts reps.

Two things worth saying out loud:

- **It is a privacy property as well as a reliability one.** An app that pulls its
  model from a third-party CDN tells that CDN the fact and timing of every session.
  Serving the assets locally means no third party sees anything at all.
- **It is verified, not asserted.** `node scripts/acceptance.mjs` checksums the
  served WASM against the installed npm package and fails on a single byte of drift
  or a missing file. That check exists because the realistic failure — a partial
  copy — only shows up on the machines that need the non-SIMD fallback, i.e. at the
  venue.

If you want to demonstrate it: turn the wifi off, then hard-reload with DevTools →
Network → *Disable cache* checked. A warm browser cache would make a CDN-hosted app
look offline too, so the disabled cache is the part that makes the demo honest.

### "How do you know the browser model matches the trained model?"

Two gates.

1. **The export refuses to ship a bad model.** `ml/scripts/export_model.py` re-scores
   the same vectors through the exported JSON and through scikit-learn, and aborts if
   the max difference exceeds **1e-6** (`export_model.py:289-293`). A subtly wrong
   export cannot be written.
2. **A separate test guards the other half of the journey** — the TypeScript runtime.
   `tests/test_model_parity.py` runs the browser runtime over the parity fixture and
   asserts agreement within **1e-6** (`tests/test_model_parity.py:37,156-212`). The
   fixture's expected values come from the TypeScript runtime, and the documented
   measured max absolute difference between the browser probability and the
   scikit-learn probability is **1.1e-16** — machine precision
   (`apps/api/README.md:127-129`).

There is also a specific regression guard for the class-inversion bug: the GBM export
returns P(bad) from the raw sigmoid, so the runtime must complement it. If it didn't,
the difference would be **~0.96**, not 1.1e-16 (`apps/api/README.md:130`;
`tests/test_model_parity.py:215-259`).

### "How do you count reps?"

A **deterministic finite-state machine** over the elbow angle, with hysteresis — the up
and down thresholds differ, so noise cannot chatter the counter across a boundary
(`packages/rep-counter/src/rep-counter.ts:307`). It is not learned.

The thresholds are **calibrated from your own range of motion**: `calibrateThresholds()`
finds the turning points of your movement, takes the median maxima/minima as the
operating band, and places `upEnter` at **0.72** of the span, `upExit` at **0.66**,
`downEnter` at **0.22** and `downExit` at **0.30** (`rep-counter.ts:21-24`). If fewer
than **15** usable samples exist it falls back to fixed thresholds (up 150 / down 100)
and reports `calibrated: false` (`rep-counter.ts:31-39,216`). The reason is empirical:
a fixed 155° "up" threshold produced **zero reps** for an entire subject whose elbow
angle peaked at 136° (`rep-counter.ts:12-15`).

### "Why count bad reps instead of ignoring them?"

Because discarding hides the problem and inflates the score. `handleCompletedRep()`
appends **every** assessment unconditionally and derives `totalReps`, `validReps` and
`invalidReps` from that list (`apps/web/lib/workout-session.ts:381-398,439-443`). The
session form score is `mean(rep_score over all reps)` — invalid reps are weighted
equally (`docs/FORM_SCORE.md §3`). The counter is even tuned to support this: the
detectable-range floor is **18°**, deliberately lower than the **25°** minimum-ROM
fault threshold, so a shallow rep still registers and reaches the depth scorer rather
than vanishing (`rep-counter.ts:41-51`). If we dropped bad reps, the depth score would
have nothing to judge and the user would never learn that half their set was shallow.
On the leaderboard, only valid reps affect rank — but bad reps are still stored and
displayed, which is what stops someone winning by flailing fast (`docs/UX_FLOW.md §10.1`).

### "Why is the rep score 0.65 geometry and only 0.35 model?"

Two reasons stated in the source (`docs/FORM_SCORE.md §2`): the geometric components
are directly interpretable and can explain *why* a rep scored low, whereas the model
outputs a number with no explanation; and the model is trained on **16 subjects**
(`metadata.json:118-135`), which is not enough to trust over first-principles
biomechanics for the majority of the weight. The model's 0.35 is what catches fault
patterns the hand-written rules don't encode.

### "What decides whether a rep is valid?"

Two conditions, both required (`docs/FORM_SCORE.md §4`):
`P(good) >= decision_threshold` **and** `geometry_score >= 55`. The geometry floor is
deliberately stricter than the model alone — it catches reps the model likes that
violate a hard biomechanical rule, such as badly sagging hips.

### "Which view is most accurate?"

On the held-out test set: **diagonal 0.766** (77 reps), **side 0.659** (44 reps),
**front 0.631** (84 reps) (`metrics.json:169-185`). Side is the most *interpretable*
(depth, body line and elbow angle are all directly observable), but the model scores
best on diagonal. Say both facts; they are not contradictory.

---

## 7. What NOT to claim

Every item here is a real limitation from the source. Do not overclaim past it.

- **Do not claim it reliably names a specific fault on every bad rep.** Issue
  attribution is precondition-gated: `INCOMPLETE_DEPTH` fires only if
  `min_elbow_angle > 105`, `HIPS_DROPPING` only if `body_line_deviation_mean > 0.10`,
  and so on (`docs/FORM_SCORE.md §5`). When the model says "bad" but no geometric rule
  fires, the app says **"Form needs attention"** with *"no single fault stood out
  strongly"* and refuses to invent a cause (`feedback.ts:131-139`).
- **Do not claim it is a medical device or a coaching substitute.** It is a
  good/bad form classifier at ~0.688 accuracy on unseen subjects. It does not diagnose
  injury risk, muscle weakness, or mobility limits.
- **Do not claim probabilities near the threshold are confident.** Below the model,
  reps within **0.08** of the threshold are treated as borderline
  (`packages/form-engine/src/assessment.ts:263`); the score below 3 reps is labelled
  **provisional**; and a single rep is a poor estimate of form by design
  (`docs/FORM_SCORE.md §3.1`).
- **Do not claim it detects hand placement, head/neck position, muscle weakness,
  calories, "strength", or any physiological estimate.** These are explicitly listed
  as things the project does not claim (`docs/FORM_SCORE.md §6`).
- **Do not claim the accuracy number is higher than 0.688.** Do not say "about 70%"
  and let the judge hear "70%+". The number is 0.688, macro-F1 0.672.
- **You may claim it runs with the network unplugged — but only after checking the
  assets are actually present.** The WASM runtime and the pose landmarker are served
  from `apps/web/public/` (`packages/pose/src/pose-engine.ts:45-57`), so the whole
  pipeline is local. If `npm run fetch:pose-assets` reports it had to download, the
  local copies were missing and the CDN fallback would have been in play — fix that
  before making the claim. `node scripts/acceptance.mjs` verifies the assets
  checksum-for-checksum and will not pass if they are missing or drifted.
- **Do not claim the leaderboard is global.** It is per-device by default
  (`docs/UX_FLOW.md §10.1`); cloud sync is an optional mirror when Supabase is
  configured.
- **Do not claim bad reps are discarded.** They are counted, stored and shown.
- **Do not claim the score is a percentage of "correctness".** It is a weighted blend
  of geometry and model probability, out of 100.

---

## 8. Booth logistics

### Timing

| Activity | Duration |
|---|---|
| Full 5-minute script (§2) | 5 min |
| **Short version** — skip the problem/architecture, go straight to calibration + 3 good + 1 bad + result | **~90 s** |
| 30-second challenge alone (entry → run → board) | ~60 s including name entry and camera start |
| Reset between users | ~10 s |

Default to the **90-second short version** for walk-ups. Run the full script only for
judges who are scoring you.

### Reset between users

1. **Free workout:** after the result card, press **Try again** — this reloads the page
   and clears the session. Alternatively press **End Workout** and navigate back to
   `/workout`.
2. **Challenge:** press **Try again** on the result card. It calls `session.reset()` and
   returns to the **ready** stage, keeping the camera and pose engine warm — faster than
   a reload (`app/challenge/page.tsx:314-323`).
3. **Name field:** the challenge keeps the last name. Clear it before the next person
   or the board will attribute their run to the previous visitor.
4. **Camera:** confirm the LED turns off when you leave the workout/challenge screen. If
   it stays on, a stream leaked — reload before the next demo.
5. **Leaderboard:** do **not** clear it between users. The board is the draw. Use
   **Clear board…** only once, at the start of the day, if it has stale test entries.
   Clearing deletes only the leaderboard, not `/progress` history
   (`app/leaderboard/page.tsx:276-280`).

### Two people want to go at once

The app is single-camera, single-user: one person on the mat, one camera. There is no
multi-user mode. Handle it as a queue:

1. **Put the second person on the challenge.** It is 30 seconds and needs no
   explanation, so it slots in cleanly after the first person's free workout.
2. **Use the leaderboard as the queue.** "Do the 30-second challenge, then your name is
   on the board and the next person goes." It gives the second person something to do
   and something to watch.
3. **Never run two camera tabs at once.** The second tab will fail with
   `CAMERA_IN_USE` — *"Another application (Zoom, Teams, or another tab) is using the
   camera."*
4. If a crowd forms, switch to the **90-second short version** and run it back to back.
   Do not run the 5-minute script for a queue.

### A one-page mental model

- **Two systems:** geometry counts reps, the model judges form. Neither is an LLM.
- **Calibration is the hook.** It adapts to the person. Show it before anything else.
- **The bad rep is the proof.** Induce a named fault and let the app name it.
- **The honest number is the credibility.** 0.688, said out loud.
- **When in doubt, demo `/progress` and `/leaderboard`** — they never need a camera.

---

## 9. Source index (for the presenter who gets a follow-up question)

| Claim | File |
|---|---|
| Model type, 34/37 features, threshold 0.58 | `ml/models/pushup_form_model.metadata.json` |
| Test accuracy / macro-F1 / ROC-AUC / confusion matrix | `ml/reports/metrics.json` |
| Subject-independent split, test subjects | `ml/reports/metrics.json:52-88` |
| Score formula, weights, issue preconditions, non-claims | `docs/FORM_SCORE.md` |
| Session phases, 250 ms throttle, 12-frame auto-pause | `apps/web/lib/workout-session.ts` |
| Calibration checks and thresholds | `apps/web/components/CalibrationPanel.tsx`, `apps/web/lib/workout-session.ts:176-258` |
| Rep thresholds, calibration fractions, ROM floors | `packages/rep-counter/src/rep-counter.ts` |
| `IssueCode` union | `packages/types/src/index.ts:104-114` |
| `CaptureErrorCode` union | `packages/types/src/index.ts:258-273` |
| Error titles, details, recoverable flags | `docs/UX_FLOW.md §8` |
| Feedback copy and the honesty branches | `packages/form-engine/src/feedback.ts` |
| Export parity gate (1e-6) | `ml/scripts/export_model.py:262-293` |
| TS runtime parity test (1e-6) | `tests/test_model_parity.py` |
| Measured parity 1.1e-16 | `apps/api/README.md:127-132` |
| Pose asset sources (local first, CDN fallback) | `packages/pose/src/pose-engine.ts:45-57` |
| Offline asset fetch and its verification | `scripts/fetch-pose-assets.mjs`, `scripts/acceptance.mjs` (`Offline pose assets` check) |
| Challenge rules and ranking order | `apps/web/app/challenge/page.tsx`, `docs/UX_FLOW.md §10` |
| Progress charts and empty state | `apps/web/app/progress/page.tsx` |
| System architecture and privacy model | `docs/ARCHITECTURE.md` |
