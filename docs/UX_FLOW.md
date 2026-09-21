# UX_FLOW.md — User Flows & Interaction Contract

This document describes the flows the app **actually implements**. Every state name,
error code, route and rate below was read from the source, not invented. Where the code
and an older doc disagree, the code wins and the disagreement is called out in
[§11 Discrepancies](#11-discrepancies-between-docs-and-code).

Source of truth for the workout state machine:
`apps/web/lib/workout-session.ts` (`SessionPhase`, `WorkoutSession`).

---

## 1. Entry points & navigation map

### 1.1 Real routes

Routes are Next.js App Router directories under `apps/web/app/`. A route exists only if
it contains a `page.tsx`.

| Route | File | Purpose |
|---|---|---|
| `/` | `app/page.tsx` | Landing. One primary action (Start workout), the 30-second challenge, and a "What it measures" panel. States plainly that the rep counter is deterministic geometry and the form classifier is a trained model — no LLM in the scoring path. |
| `/workout` | `app/workout/page.tsx` | The main training screen. Camera stage (left) + metrics column (right) + feedback/tip row (bottom). Owns camera, pose and session lifecycle. |
| `/progress` | `app/progress/page.tsx` | Workout history. Four summary tiles, three trend charts, one history table. Empty state is a first-class case. |
| `/challenge` | `app/challenge/page.tsx` | IT-fest exhibition mode. 30 seconds, maximum **valid** reps. Name entry → ready → running → done. |
| `/tips` | `app/tips/page.tsx` | Form tips. Fault copy is imported from `ISSUE_COPY` in the form-engine, so it cannot drift from the live feedback panel. States the classifier's real test accuracy rather than implying a verdict. |
| `/leaderboard` | `app/leaderboard/page.tsx` | Challenge scoreboard, ranked by `rankEntries()`. Client component because every row lives in `localStorage`. |

### 1.2 Header nav

`components/AppHeader.tsx` renders `NAV = [/workout "Workout", /progress "Progress",
/tips "Tips", /about "About"]`. The active link is marked with `aria-current="page"`.
The logo links to `/`. `/challenge` and `/leaderboard` are **not** in the header; they are
reached from the landing page, the challenge result card, and the leaderboard links on the
challenge page.

### 1.3 Known dead links

`/about` is linked from the header nav and the footer (`/about`, `/about#privacy`,
`/about#contact`) but `apps/web/app/about/` contains **no `page.tsx`** — the route 404s.
See [§11](#11-discrepancies-between-docs-and-code).

---

## 2. Primary flow: a workout session

### 2.1 The state machine (documented as implemented)

`SessionPhase` is a 5-member union (`workout-session.ts:44`):

```
'idle' | 'calibrating' | 'active' | 'paused' | 'finished'
```

Transitions, with the guard that governs each:

| From | To | Trigger | Guard / note |
|---|---|---|---|
| `idle` | `calibrating` | `beginCalibration()` | Clears samples, sets `calibrationComplete = false`. |
| `calibrating` | `calibrating` | `onPoseFrame` → `processFrame` | Each valid frame pushes an elbow sample; `calibrationComplete` flips true at **60 samples**. |
| `calibrating` | `active` | `start()` | Derives thresholds via `calibrateThresholds(samples)` and calls `counter.setThresholds()`. Timer starts here. |
| `active` | `paused` | `pause('pose-lost')` | Auto-pause after **12 consecutive invalid frames** (`LOST_FRAMES_TO_PAUSE = 12`, ≈0.6 s at 20 fps). |
| `active` | `paused` | `pause('user')` | Reserved for explicit user pause. |
| `paused` | `active` | `resume()` | Accumulates `pausedAccumMs` so paused time is excluded from `elapsedSeconds`. Auto-resumes on pose recovery when `pausedReason === 'pose-lost'`. |
| `active`/`paused` | `finished` | `finish()` | Forces a snapshot emit. |
| any | `idle` | `reset()` | Clears reps, assessments, timer, samples, thresholds. Used by the challenge "Try again". |

`pause()` and `resume()` both no-op if the phase is wrong, so a double-pause cannot
corrupt the timer.

### 2.2 Step-by-step walkthrough

**Step 1 — Idle.** The user lands on `/workout`. `CameraStage` shows a video element with
`overlayMessage = "Press START WORKOUT to begin"`, the live indicator reads **Standby**.
A `ViewSelector` radiogroup offers **Side / Diagonal / Front** (`role="radiogroup"`,
`role="radio"`, `aria-checked`). If the model failed to load, a chip reads
"Rule-based scoring (model not loaded)".

**Step 2 — Camera permission.** `handleStart` → `startCamera` → `CameraEngine.start(video,
{width:1280, height:720, fps:30})`.

- **Grant:** the stream attaches to the `<video>`, `video.play()` runs, and the engine
  waits for non-zero `videoWidth` (up to a 4 s timeout). Real dimensions are stored in
  `videoDims` so the pose overlay maps landmarks into the correct `object-fit: cover` box.
- **Denial / other failure:** `getUserMedia` throws a `DOMException`, which
  `classifyError()` maps to a `CaptureErrorCode` and `makeCaptureError()` turns into
  `{code, title, detail, recoverable}`. The page sets `screen='error'` and renders an
  `ErrorBanner` with `role="alert"`; a **Retry** button appears only when
  `recoverable === true`. Full mapping in [§8](#8-error-states).

**Step 3 — Pose engine start.** `startPose()` constructs `PoseEngine({ targetFps: 20 })`.
If `engine.init()` fails, the page raises `MODEL_UNAVAILABLE` and stops. Frames are pushed
through a module-level bridge (`poseBridgeRef`) straight into the session — they never
enter React state.

**Step 4 — Calibration (`'calibrating'`).** The session calls `beginCalibration()` and the
`CalibrationPanel` replaces the start button. See [§3](#3-calibration--camera-setup).

**Step 5 — Active set (`'active'`).** Pressing **Start counting** calls `session.start()`,
which calibrates the rep thresholds from the collected samples and begins the timer. The
camera stage now shows chips for `elbow NN°`, `state <RepState>`, `cycle NN%`.

**Step 6 — Pause / resume.** If the pose is lost, the phase becomes `'paused'` with
`pausedReason === 'pose-lost'` and the camera overlay reads
**"Pose lost — step back into frame"**. Counting stops but the session is not lost. When a
valid frame returns, `processFrame` auto-resumes. The paused interval is subtracted from
`elapsedSeconds`, so a pause never inflates workout time.

**Step 7 — Finish.** **End Workout** (enabled while `active` or `calibrating`) calls
`session.finish()`, stops the pose engine and stops the camera, then persists via
`saveSession(...)`. **Only numbers are stored — never video.** The page then renders
`SessionResult`.

**Step 8 — Session result.** `SessionResult` is deliberately minimal: a "Session complete"
heading, the line "Your results were saved. Open Progress to see your history.", a
**Try again** button (reloads the page) and a **View progress** link to `/progress`. It
does not re-render the metric cards; the per-rep detail lives on `/progress`.

> **Note on the camera light:** `CameraEngine.stop()` is called on unmount, on End
> Workout, and before every new `start()`. A leaked stream would leave the camera LED on
> after navigation, which looks like spyware at a public demo.

---

## 3. Calibration & camera-setup

### 3.1 Why calibration exists

The rep counter's up/down thresholds are **derived from the user's own range of motion**,
not from fixed 90°/160° constants. `rep-counter.ts` records the measurement that forced
this: a fixed 155° "up" threshold silently produced **zero reps** for an entire subject
whose front-view elbow angle peaked at 136°.

`calibrateThresholds(samples)` (`rep-counter.ts:213`) finds the movement's turning points
via `localExtrema()`, takes the median maxima/minima as the operating band, and places
thresholds at fractions of that span:

| Threshold | Fraction | Clamp |
|---|---|---|
| `upEnter` | 0.72 of span | [100, 175] |
| `upExit` | 0.66 of span | `upEnter − 12` … `upEnter − 1` |
| `downEnter` | 0.22 of span | [40, 150] |
| `downExit` | 0.30 of span | `downEnter + 1` … `downEnter + 15` |

Safeguards: implausible elbow angles (<25° or >179.5°) are masked as tracking errors; if
the detected span is under `MIN_DETECTABLE_ROM_DEG = 18°` the function falls back to
percentiles; a final ordering check forces `downEnter < downExit < upExit < upEnter` or
resets the band. If fewer than `MIN_FRAMES_TO_CALIBRATE = 15` usable samples exist,
`FALLBACK_THRESHOLDS` (upEnter 150 / upExit 143 / downEnter 100 / downExit 108) are used
and `calibrated` stays `false`.

### 3.2 The Camera check panel

`CalibrationPanel` polls `session.getCalibrationState()` every **200 ms (5 Hz)** — it does
not subscribe to per-frame updates. It renders six checks, each derived from real landmark
evidence:

| Check id | Label | Passes when | Hint shown while failing |
|---|---|---|---|
| `full-body` | Full body in frame | ≥5 valid recent frames **and** the last 10 all have ankles tracked and unclipped | "Move further from the camera so your feet are visible." |
| `pose` | Pose detected | ≥10 valid frames in the recent window | "Step into the frame and hold a push-up position." |
| `view` | Side view | mean `sideDominance` ≥ **0.55** | "Turn sideways to the camera for the most accurate analysis." |
| `lighting` | Lighting | mean `sideVisibility` ≥ **0.6** | "Add light or avoid strong backlighting behind you." |
| `distance` | Distance | mean body-span ratio between **0.12 and 0.75** | "Adjust your distance — you are too close or too far." |
| `stable` | Hold still to calibrate | ≥45 collected samples | "Collecting motion samples (n/45)." |

**Start counting is disabled until every check passes** (`aria-describedby` points at the
"Waiting for all checks to pass" hint). This is a deliberate gate: counting must not begin
while the geometry is untrusted, or the first reps would be scored on bad data. Ankles are
required because push-up alignment depends on the shoulder–hip–ankle line, so a frame cut
at the ankles is useless even when the shoulders track perfectly.

### 3.3 Which view to use

The view selector offers three options. Side is the most informative because the elbow
angle, hip deviation from the body line, and depth are all directly observable when the
body is seen in profile. Diagonal is next (elbow flare becomes visible, at some cost to
depth accuracy). Front is the weakest for depth and body-line work — it is mainly useful
for elbow flare. The calibration `view` check encodes this: it passes only when
`sideDominance ≥ 0.55`, i.e. the shoulders have collapsed relative to torso length, which
is what a side-on posture looks like.

### 3.4 Visibility threshold — when geometry is untrusted

`MIN_VISIBILITY = 0.5`, defined in both `packages/pose/src/pose-engine.ts` and
`packages/biomechanics/src/extract.ts`. In `PoseEngine`, a frame is `valid` only when the
active side's mean visibility is `>= MIN_VISIBILITY`; `PoseFrame.valid` is documented as:
"`valid` is false when the active side's mean visibility fell below `MIN_VISIBILITY` —
downstream code must not use the geometry fields in that case, they will be NaN."

Three separate thresholds therefore exist, and they are not the same number:

| Threshold | Value | Where | Meaning |
|---|---|---|---|
| Landmark drawn | 0.3 | `PoseOverlay` | Below this, a joint/connection is not drawn at all. |
| Joint marked unreliable | 0.5 (`LOW_CONFIDENCE`) | `PoseOverlay` | Drawn dimmed and smaller — the viewer can see the model is unsure. |
| Frame accepted | 0.5 (`MIN_VISIBILITY`) | `PoseEngine` | Geometry is only computed above this. |
| Calibration lighting check | 0.6 | `getCalibrationState` | Stricter than `MIN_VISIBILITY` so the set starts from good conditions. |

---

## 4. Rep feedback loop

### 4.1 What the user sees per rep

On rep completion, `handleCompletedRep()` runs the assessment, pushes a
`WorkoutRepRecord`, increments `repNonce`, and sets `lastRep` — a `LiveRepFeedback`
carrying `repIndex`, `label`, `valid`, `primaryIssue`, the four component scores,
`repScore` and `nonce`. The `nonce` is bumped on every rep **so the UI can animate on
change** rather than on every frame.

The UI consumes it in three places:

- **Feedback panel** — headline + detail from `buildFeedback()`, in a card with
  `role="status"` and `aria-live="polite"` so a screen reader announces each rep.
- **Form analysis** — four `MeterRow`s: Depth, Body alignment, Tempo, Consistency.
  Before the first rep it reads "Live per-rep breakdown appears after your first rep."
- **Tip panel** — `tipForIssue(lastRep.primaryIssue)`.

### 4.2 The throttle (real numbers)

The pipeline does **not** re-render React per camera frame.

| Stage | Rate | Source |
|---|---|---|
| Camera capture | 30 fps (requested) | `camera.start(video, {fps:30})` |
| Pose inference | **20 fps** | `new PoseEngine({ targetFps: 20 })` |
| React snapshot push | **max 4 Hz** | `SNAPSHOT_INTERVAL_MS = 250` in `workout-session.ts` |
| Calibration panel poll | **5 Hz** | `setInterval(..., 200)` in `CalibrationPanel.tsx` |
| Skeleton overlay | per pose frame | imperative `canvas.draw()`, never React |

`maybeEmit()` drops a snapshot if fewer than 250 ms have elapsed. Phase changes and rep
completions call `emit(true)`, which **bypasses the throttle** — the user must not wait up
to 250 ms to see a rep register. `onPoseFrame` always calls `maybeEmit()` even when no rep
was counted, so the timer and pose-lost state still update.

The skeleton is drawn to a `<canvas>` through a ref. `PoseOverlay`'s comment states the
reason: 33 landmarks × 20 fps in React state would be ~660 state updates per second.

---

## 5. Valid vs invalid reps

A bad rep is **recorded as invalid, never discarded**. `handleCompletedRep()` appends the
assessment unconditionally and computes:

```
totalReps  = assessments.length
validReps  = assessments.filter(a => a.valid).length
invalidReps = totalReps - validReps
```

Both counts are displayed side by side on the workout screen ("Valid reps" with a good
tone, "Invalid reps" with a bad tone), on the challenge screen ("Valid reps" / "Bad reps"),
and in the progress table.

**Why record rather than discard?** Discarding hides the problem and inflates the score. If
a sloppy rep were silently dropped, the form score would be computed only over the reps the
user did well, and the user would have no way to see that half their set was shallow. The
rep counter is tuned to match this decision: `MIN_DETECTABLE_ROM_DEG = 18°` is deliberately
lower than `MIN_ROM_DEG = 25°` precisely so a shallow rep still registers as a rep and
reaches the depth scorer — "if the counter refused shallow reps, the depth score would have
nothing to judge and the 'invalid rep' path would never fire for shallow form."

Validity itself requires **both** conditions (`FORM_SCORE.md §4`):
`P(good) >= decision_threshold` **and** `geometry_score >= 55`. The geometry floor catches
reps the model likes that violate a hard biomechanical rule.

---

## 6. The honest-uncertainty rule

When the system is unsure, the UI must say so rather than assert. This appears in four
places:

1. **`buildFeedback()` in `packages/form-engine/src/feedback.ts`.** Three explicit branches:
   - `label === 'unknown'` → "Form could not be scored" / "We could not track your body
     reliably enough to judge this rep." (`tone: 'warning'`).
   - `label === 'good' && borderline` → "Good rep — just" / "This rep was close to our
     quality threshold."
   - `label === 'bad'` with **no** geometric issue fired → "Form needs attention", with
     the detail "no single fault stood out strongly". The engine refuses to invent a cause.
2. **Issue attribution is precondition-gated.** Each `IssueCode` is emitted only when its
   measured condition holds (e.g. `INCOMPLETE_DEPTH` requires `min_elbow_angle > 105`).
   This is the guard against the model appearing to know more than it does.
3. **The pose overlay dims uncertain joints.** Below `LOW_CONFIDENCE = 0.5` a joint is
   drawn smaller and greyed; below 0.3 it is not drawn at all. The user can literally see
   when tracking is weak instead of being shown false confidence.
4. **The score is labelled provisional below 3 reps** and `--` at zero reps (see §7).

The tips page reinforces this by publishing the classifier's actual test accuracy
(0.688 on unseen subjects) instead of implying a definitive verdict.

---

## 7. The no-fake-data rule

During a live workout, an unavailable metric renders as `--` and never as an invented
number. This is enforced at the data layer, not just in the view: `computeMetrics()`
returns `null` for `meanRepSeconds` when no finite positive rep durations exist, and
`sessionFormScore()` returns `null` at zero reps. Nothing is back-filled with a
plausible-looking value.

| Condition | Rendered |
|---|---|
| `metrics === null` (no snapshot yet) | `--` on every metric card |
| `formScore === null` (0 reps) | `--` / 100, plus "Complete a rep to score" |
| `scoreStatus === 'provisional'` (<3 reps) | the number, plus a warning "Provisional — under 3 reps" |
| `liveElbowAngle` null or NaN | `elbow --` |
| `lastRep === null` | "Waiting for your first rep" |
| `components.depth` unavailable | that `MeterRow` shows `--` |

`FORM_SCORE.md §3.1` states the rule directly: "The app shows `--` rather than `0`. Zero
would be a fabricated measurement." The same rule covers the progress page, where the
average form score tile reads `--` when no session has a finite score, and the history
table prints `--` per row.

Related honesty rule: if the trained model is missing, the engine runs geometry-only and
the UI labels the source as **"Rule-based scoring (model not loaded)"** rather than
silently substituting a fake model score.

---

## 8. Error states

Every code below exists in the `CaptureErrorCode` union
(`packages/types/src/index.ts:258`). Title, detail and `recoverable` come from `ERROR_COPY`
in `apps/web/lib/camera.ts:28`. The UI renders `title` and `detail` in an `ErrorBanner`
with `role="alert"`, and shows **Retry** only when `recoverable` is true.

| Code | Cause | What the user sees | Recovery action |
|---|---|---|---|
| `PERMISSION_DENIED` | `NotAllowedError` / `SecurityError` from `getUserMedia` | "Camera permission denied" — "Your browser blocked camera access. Click the camera icon in the address bar and allow access, then try again." | Recoverable — Retry button. Allow in the address bar, then Retry. |
| `NO_CAMERA` | `NotFoundError` / `DevicesNotFoundError` / `OverconstrainedError` | "No camera found" — "We could not find a camera on this device. Connect a webcam and reload the page." | Recoverable — Retry. Connect a webcam. |
| `CAMERA_IN_USE` | `NotReadableError` / `TrackStartError` | "Camera is in use" — "Another application (Zoom, Teams, or another tab) is using the camera. Close it and try again." | Recoverable — Retry. Close the other app. |
| `INSECURE_CONTEXT` | `navigator.mediaDevices.getUserMedia` is unavailable (http:// on a LAN IP) | "Camera requires a secure connection" — "Camera access only works over https:// or on localhost. Open the app at http://localhost:3000." | **Not recoverable** — no Retry button. Re-open over https or localhost. |
| `INIT_FAILED` | `video.play()` rejected, or `videoWidth === 0` after a 4 s wait | "Could not start the camera" — "The camera started but no video arrived. Try reloading, or select a different camera." | Recoverable — Retry / reload. |
| `MODEL_UNAVAILABLE` | `PoseEngine.init()` returned false | "Pose model unavailable" — "The pose detection model could not be loaded. Rep counting is disabled. Check your internet connection and reload." | Recoverable — Retry. Counting is disabled until it loads. |
| `NO_PERSON` | No person in frame | "No person detected" — "Step into the frame so we can see your full body." | Recoverable — step into frame. |
| `MULTIPLE_PEOPLE` | More than one person tracked | "Multiple people detected" — "More than one person is in view. Make sure only the person exercising is visible in the frame." | Recoverable — clear the frame. |
| `FEET_OUT_OF_FRAME` | Ankles not tracked or clipped at the frame edge | "Your feet are outside the frame" — "Move further from the camera so your whole body, including your feet, is visible." | Recoverable — move back. |
| `MOVE_FARTHER` | Torso span too large | "Move further from the camera" — "We need to see your full body to measure form accurately." | Recoverable — move back. |
| `LOW_CONFIDENCE` | Landmarks tracked but unreliable (`sideVisibility` low) | "Pose confidence is low" — "We can see you but cannot track your joints reliably. Improve the lighting, or move away from a busy background." | Recoverable — improve lighting / simplify background. |
| `TURN_SIDEWAYS` | View is not side-on | "Please turn sideways" — "Side view gives the most accurate push-up analysis. Turn so the camera sees you from the side." | Recoverable — turn sideways. |
| `BACKEND_UNAVAILABLE` | Optional analysis service unreachable | "Analysis service unavailable" — "Running with on-device form scoring. Your workout still counts." | Recoverable — no action needed; workout continues. |
| `PAUSED` | Counting stopped while pose is not tracked | "Workout paused" — "Counting has stopped until your pose is tracked again." | Recoverable — resume when the pose returns (auto-resumes). |
| `UNKNOWN` | Any unmapped error, or a non-`Error` throw | "Something went wrong" — "An unexpected camera error occurred. Reload the page to try again." | Recoverable — Retry / reload. |

Only `INSECURE_CONTEXT` is non-recoverable, and it is the only code that suppresses the
Retry button.

### 8.1 Pause is a session state, not only an error

Pose loss is handled in two layers. The session enters `'paused'` with
`pausedReason: 'pose-lost'` after 12 consecutive invalid frames, and the camera stage
overlay reads "Pose lost — step back into frame". The `PAUSED` error code carries the
same message for surfaces that report through the error channel. Auto-resume happens as
soon as a valid frame returns.

---

## 9. Progress flow

`/progress` reads from `localStorage` via `loadSessions()` in a mount effect. The header
states which store is live: "Synced to your account." when Supabase env vars are present,
otherwise "Stored locally on this device."

**Empty state.** A dedicated `EmptyState` card: "No workouts yet" plus an explanation and
two actions (Start your first workout, Read form tips). The comment in the file is
explicit that a new user should see an explanation, not an axis-less empty grid.

**Summary tiles** (4): Sessions, Total reps, Valid reps, Average form score. The average
renders `--` when no session has a finite score.

**Charts** — three single-series line charts, deliberately simple. Data is sorted oldest →
newest and indexed, so the x-axis is session date and the y-axis is the metric:

| Chart | Series | Y domain |
|---|---|---|
| Valid reps over time | `s.validReps` | auto |
| Form score over time | `s.formScore` (may be `null`) | [0, 100] |
| Consistency over time | `validReps / totalReps × 100`, one decimal, or `null` | [0, 100] |

**History table** — one row per session, newest first (the store sorts descending), with
columns: Date, Duration, Total reps, Valid, Invalid, Form score, Common issue, View. The
common issue is rendered through `issueLabel()`, and the form score prints `--` when
`null`. Rows with invalid reps colour the Invalid cell, but the number is always present,
so nothing is conveyed by colour alone.

**Challenge sessions appear here too.** `saveSession` writes both modes to the same
`aipc:sessions:v1` key; only the `mode` field differs.

---

## 10. Challenge flow

`/challenge` is the IT-fest exhibition mode. `CHALLENGE_SECONDS = 30`.

Its own stage machine is `Stage = 'entry' | 'ready' | 'running' | 'done' | 'error'` —
separate from `SessionPhase`, which governs the underlying session.

1. **Entry.** The user types a name. Input is capped at 24 characters in the field
   (`maxLength={24}` and `.slice(0, 24)`) and sanitised again on save by `sanitizeName()`,
   which strips control characters, collapses whitespace and truncates to 24. A blank name
   becomes `'Anonymous'`. Copy explains the rule: "Maximum **valid** push-ups in 30
   seconds. Only clean reps count toward your score — a rushed bad rep scores nothing."
2. **Ready.** Camera and pose start. The overlay reads "Get into position, then start".
   A note says "Side view recommended. Full body must be in frame."
3. **Running.** `session.start()` is called and a countdown begins. The countdown is
   driven from a **wall-clock deadline**, not a frame count, so a slow frame rate cannot
   extend the challenge; the interval ticks at 100 ms. The big timer shows one decimal
   place and turns to the danger colour at ≤5 s.
4. **Done.** `session.finish()` stops pose and camera, then `saveSession(...)` persists
   with `mode: 'challenge'` and the sanitised display name.

### 10.1 How a session becomes a leaderboard entry

`saveSession` calls `saveLeaderboardEntry(...)` whenever `mode === 'challenge'` and a
`displayName` is present. The entry records `displayName`, `validReps`, `invalidReps`,
`formScore`, `durationSeconds`, `bestStreak` and `mode: 'challenge30'`.

Ordering is applied by `rankEntries()` and is identical locally and remotely:

1. `validReps` **DESC** (primary)
2. `formScore` **DESC** (tie-break 1)
3. `durationSeconds` **ASC** (tie-break 2 — faster wins on equal score)
4. `createdAt` **ASC** (deterministic final ordering)

Only valid reps affect the ranking, but invalid reps are still stored and displayed, which
is what stops someone from winning by flailing quickly. When Supabase is configured,
entries are also pushed remotely and `fetchLeaderboardMerged()` merges remote and local
rows, de-duplicating on id and re-applying the same `rankEntries()` ordering.

`/leaderboard` is a client component: every row lives in `localStorage`, so the first
render is a neutral skeleton and the data is read after mount to avoid a hydration
mismatch. "Not read yet" (`null`) is kept distinct from "read and empty".

---

## 11. Discrepancies between docs and code

Documented as the code behaves; each is a real gap worth fixing.

| # | Doc claim | Code reality |
|---|---|---|
| 1 | The spec lists `/about` as a route. | `apps/web/app/about/` has **no `page.tsx`**. The header nav and footer both link to `/about` (and `/about#privacy`, `/about#contact`), so those links 404. |
| 2 | `ARCHITECTURE.md §4.8`: "the session + per-rep rows are persisted to Supabase." | `lib/session-store.ts` makes **localStorage the primary store** and Supabase an optional mirror. The file's own header explains why: a demo must not depend on venue wifi. `StoredSession.localOnly` tracks which rows never synced. |
| 3 | `ARCHITECTURE.md §6`: "Pose confidence low → Pause counting." | The code pauses on **invalid frames** (active-side visibility < `MIN_VISIBILITY = 0.5`) after 12 consecutive frames, and the calibration panel gates on a stricter mean confidence of 0.6. There is no separate low-confidence pause path. |
| 4 | `SessionPhase` includes `'paused'`. | The workout page's own `Screen` type is `'idle' \| 'calibrating' \| 'active' \| 'finished' \| 'error'` — it has **no `'paused'`** and adds `'error'`. Pause is expressed only through `snapshot.phase` and `snapshot.pausedReason`. The two unions are not the same type, which is easy to misread when tracing the UI. |
| 5 | `FORM_SCORE.md §2` lists five geometry components including `rom_score` (weight 0.10). | The workout screen's Form analysis panel renders only **four** meters (Depth, Alignment, Tempo, Consistency). ROM is computed and folded into `repScore` but has no live meter. |
| 6 | — | The workout page builds its live `buildFeedback()` input with `borderline: false` and `confidence: 0`. `label === 'unknown'` can still surface "Form could not be scored", but the **borderline** branch ("Good rep — just") cannot appear on the live screen, because borderline is forced false there. |
| 7 | — | `SessionConfig` supports `durationLimitSeconds` for challenge mode, but `challenge/page.tsx` never passes it; the 30 s limit is enforced by the page's own wall-clock interval. |

---

## 12. Accessibility notes

- **Skip link.** `layout.tsx` renders a "Skip to content" anchor as the first focusable
  element; it is `sr-only` until focused, then positioned visibly, and targets `#main`.
- **Landmarks.** `header` (with `nav aria-label="Main"`), `main#main`, and `footer` with
  `nav aria-label="Footer"`. On the workout page the two columns are
  `section aria-label="Live camera"` and `section aria-label="Workout metrics"`.
- **Keyboard reachability.** Every interactive element is a native `<button>`, `<a>` or
  `<input>`, so all are tab-reachable and Enter/Space-activatable without custom key
  handlers. The view selector uses `role="radiogroup"` / `role="radio"` with
  `aria-checked`, and the camera check exposes `aria-describedby` pointing at the
  "Waiting for all checks to pass" hint when the button is disabled.
- **Focus visibility.** Focus styling is not removed anywhere. The logo link and the
  challenge name input use `focus-visible:ring-2` / `focus-visible:border-accent`, and the
  skip link becomes visible on focus. Because focus is never suppressed, the browser's
  default focus ring remains as a fallback on elements without an explicit style.
- **Live regions.** The feedback panel is `role="status"` with `aria-live="polite"`, so
  each new rep's headline and detail are announced without interrupting. Error banners are
  `role="alert"`. The challenge countdown is deliberately `aria-live="off"` — announcing a
  timer ten times a second would be hostile to a screen-reader user.
- **No information by colour alone.** Every colour-coded value also carries text or a
  shape:
  - Valid/invalid reps are separate labelled cards with numbers; the invalid cell in the
    progress table colours *and* prints the count.
  - Score badges pair colour with the words "Good form" / "Needs work" / "Poor form", plus
    a three-bar glyph whose filled-bar count encodes the score.
  - Camera check rows pair colour with a ✓ / · glyph and a text label.
  - Feedback tone pairs colour with a check / alert / info icon and a text headline.
  - The live indicator reads "Live" or "Standby" next to the pulsing dot.
  - Decorative icons are `aria-hidden="true"` so they are not announced twice.
- **Labels and language.** The `<html>` element carries `lang="en"`. Metric tiles use a
  visible label plus a monospace/tabular value. The camera `<video>` has
  `aria-label="Live camera feed for push-up analysis"`; the overlay canvas is
  `aria-hidden="true"` because it duplicates information available in the text metrics.
