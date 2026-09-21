# FORM_SCORE.md — The Scoring Formula

Every number the UI displays must be traceable to a measured feature.
No random percentages. No placeholder constants dressed up as metrics.

---

## 1. Component Scores (each 0–100)

### 1.1 Depth Score

Depth = how close the chest got to the ground during the rep's lowest point.
Measured by minimum elbow flexion, which is the robust proxy in side view.

```
DEPTH_TARGET_DEG = 90    # elbow angle at proper push-up depth (upper arm ~parallel to floor)
DEPTH_TOP_DEG    = 160   # elbow angle at full lockout

depth_score = 100 * clamp( (DEPTH_TOP_DEG - min_elbow_angle) / (DEPTH_TOP_DEG - DEPTH_TARGET_DEG), 0, 1 )
```

- `min_elbow_angle = 90` → 100 (full depth)
- `min_elbow_angle = 125` → 64 (incomplete depth — the most common fault in our `bad` set)
- `min_elbow_angle = 160` → 0 (no rep at all)

**Why 90°?** Standard push-up depth criterion: the elbow reaches approximately 90° when
the upper arm is parallel to the floor and the chest is at fist height. Validated against
the dataset by comparing `min_elbow_angle` distributions of `good` vs `bad` side clips
(see `ml/reports/`). The thresholds are **derived from data**, not assumed — if the
measured separation differs, these constants change and the fact is recorded here.

### 1.2 Alignment Score

Alignment = how straight the shoulder–hip–ankle line stayed.
Based on `body_line_deviation` (signed, torso-normalized, from `FEATURE_SCHEMA.md §3`).

```
ALIGNMENT_TOLERANCE = 0.18   # torso-lengths of deviation considered "fully straight"

worst_deviation = max over the rep window of |body_line_deviation|
alignment_score = 100 * clamp( 1 - (worst_deviation - ALIGNMENT_FREE) / (ALIGNMENT_TOLERANCE - ALIGNMENT_FREE), 0, 1 )
ALIGNMENT_FREE = 0.05        # deviations below this are treated as perfect
```

A dead-straight body scores 100. Hips sagging by 0.18 torso-lengths scores 0.
`ALIGNMENT_FREE = 0.05` absorbs landmark noise so a technically-perfect rep is not
penalised for measurement jitter.

### 1.3 Tempo Score

Tempo = control. Rewards a steady, deliberate cadence and penalises jerky or rushed reps.

Two independent terms:

```
# Term A — cadence plausibility (seconds per rep)
TEMPO_IDEAL_MIN = 1.2
TEMPO_IDEAL_MAX = 4.0
cadence_score = 100 if TEMPO_IDEAL_MIN <= rep_duration_s <= TEMPO_IDEAL_MAX
              = 100 * (rep_duration_s / TEMPO_IDEAL_MIN)          if faster
              = 100 * (TEMPO_IDEAL_MAX / rep_duration_s)          if slower
                                             (clamped to [0,100])

# Term B — symmetry (a controlled rep descends and ascends similarly)
asymmetry = |descent_duration_s - ascent_duration_s| / rep_duration_s
symmetry_score = 100 * clamp(1 - asymmetry / 0.6, 0, 1)

tempo_score = 0.5 * cadence_score + 0.5 * symmetry_score
```

Term B exists because a rep that dives down and barely pushes back up is a real fault
pattern, and it is invisible to a pure duration measure.

### 1.4 Consistency Score

Consistency = stability of the movement, not speed.

```
velocity_cv  = std(elbow_angular_velocity) / max(|mean(elbow_angular_velocity)|, 1e-6)
stability    = 100 * clamp(1 - velocity_cv / 1.5, 0, 1)

jitter_penalty = 100 * clamp(jitter_score / 0.02, 0, 1)

consistency_score = 0.7 * stability + 0.3 * (100 - jitter_penalty)
```

### 1.5 Range-of-Motion Score

Guards against reps that flex the elbow barely at all but still cross the state
machine thresholds.

```
rom_score = 100 * clamp( (rom_elbow_deg - 25) / (70 - 25), 0, 1 )
```

`rom_elbow_deg` is `max - min` elbow angle within the rep. 70°+ of travel = full marks.

---

## 2. Per-Rep Score

```
MODEL_WEIGHT = 0.35
GEOMETRY_WEIGHT = 0.65
```

```
geometry_score = 0.30 * depth_score
               + 0.30 * alignment_score
               + 0.20 * tempo_score
               + 0.10 * consistency_score
               + 0.10 * rom_score

model_score    = 100 * P(good)          # from the trained classifier

rep_score      = GEOMETRY_WEIGHT * geometry_score + MODEL_WEIGHT * model_score
```

**Why geometry dominates (0.65)?** Two reasons:
1. The geometric components are directly interpretable and can explain *why* a rep
   scored low. The ML model outputs a number with no explanation.
2. The model is trained on 16 subjects. It is good, but 16 people is not enough to
   trust over first-principles biomechanics for the majority of the weight.

The model's contribution (0.35) is what catches fault patterns the hand-written rules
do not encode — which is the actual point of training it.

If the model is unavailable, `rep_score = geometry_score` and the UI labels the score
source as `rule-based`. It never silently substitutes a fake model score.

---

## 3. Session Form Score

Reps are **weighted equally regardless of validity** — an invalid rep still carries
information about the session.

```
form_score = mean(rep_score over all reps)
```

Rounded to one decimal. Displayed as `91 / 100`.

### 3.1 Insufficient-Data Guard

A single rep is a poor estimate of form.

```
if total_reps == 0:  form_score = None   → UI shows "--"
if total_reps <  3:  status = "provisional"  → UI shows the number plus "provisional"
```

The app shows `--` rather than `0`. Zero would be a fabricated measurement.

---

## 4. Valid vs Invalid Decision

```
VALID  if P(good)         >= decision_threshold   AND   geometry_score >= 55
INVALID otherwise
```

Both conditions must hold. This is deliberately stricter than the model alone:
- the threshold comes from validation-tuned `metadata.json`,
- the `geometry_score >= 55` floor catches reps the model likes but that violate a
  hard biomechanical rule (e.g. hips sagging badly).

Invalid reps are **counted, stored, and shown** — never discarded. The product
requirement is that the user sees their bad reps and gets told why.

---

## 5. Issue Attribution

Each issue is emitted only when its geometric precondition is actually satisfied.
This is the guard against the model appearing to know more than it does.

| Issue code | Emitted when | Message |
|---|---|---|
| `INCOMPLETE_DEPTH` | `min_elbow_angle > 105` | "Go deeper — aim to bring your chest closer to the floor." |
| `HIPS_TOO_HIGH` | `body_line_deviation_mean < -0.10` | "Your hips are piked up. Lower them so your body forms a straight line." |
| `HIPS_DROPPING` | `body_line_deviation_mean > 0.10` | "Your hips are sagging. Squeeze your core to hold a straight line." |
| `BODY_NOT_STRAIGHT` | `body_line_deviation_range > 0.15` | "Keep your body locked in one line through the whole rep." |
| `ELBOW_FLARE` | `shoulder_angle_deg_mean > 75` in front/diagonal view | "Tuck your elbows closer to your body." |
| `TOO_FAST` | `rep_duration_s < 0.9` | "Slow down — control the descent." |
| `KNEES_BENT` | `knee_angle_deg_mean < 150` | "Keep your legs straight." |
| `PARTIAL_RANGE` | `rom_elbow_deg < 30` | "Use your full range of motion." |
| `UNSTABLE` | `jitter_score > 0.02` | "Try to keep the movement smooth and controlled." |

**Priority order** when several apply — most actionable first:
`INCOMPLETE_DEPTH` → `HIPS_DROPPING` → `HIPS_TOO_HIGH` → `BODY_NOT_STRAIGHT` →
`KNEES_BENT` → `ELBOW_FLARE` → `PARTIAL_RANGE` → `TOO_FAST` → `UNSTABLE`

The primary issue drives the feedback panel. Secondary issues are shown in the
Form Analysis detail, capped at 3 so the user is never buried in corrections.

`most_common_issue` for a session = the most frequent primary issue across invalid reps.

---

## 6. What We Deliberately Do Not Claim

- We do not claim to detect which specific muscle is weak.
- We do not claim to detect hand placement width (not reliably recoverable from
  MediaPipe's wrist landmarks in side view).
- We do not claim to detect head/neck position faults.
- We do not report calories, "strength", or any physiological estimate.

When `P(good)` is between `threshold ± 0.08`, the feedback reads
"Borderline — form is close to the threshold" rather than asserting a verdict.
