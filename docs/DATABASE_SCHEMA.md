# DATABASE_SCHEMA.md — Supabase

## 1. Design Principles

- **No webcam footage is ever stored.** No video, no frames, no images. Only numbers.
- Per-rep rows are stored so the Progress page can break a session down, and so the
  form-score formula can be recomputed from raw components rather than trusting a
  single stored number.
- `display_name` on the leaderboard is the only user-supplied text. It is sanitised
  (trimmed, length-capped, control characters stripped) before insert.
- Schema is additive-only in migrations; no destructive changes after demo day.

## 2. Tables

### `users`
Lightweight identity. The app works anonymously; a row is created lazily on first save
so history can be scoped to a device/browser without requiring login.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | `gen_random_uuid()` |
| `device_key` | `text` UNIQUE | random client-generated stable key, stored in localStorage |
| `display_name` | `text` NULL | optional |
| `created_at` | `timestamptz` | `now()` |

### `workout_sessions`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `user_id` | `uuid` FK → users | nullable for anonymous |
| `started_at` | `timestamptz` | |
| `ended_at` | `timestamptz` | |
| `duration_seconds` | `int` | wall-clock, excludes paused time |
| `total_reps` | `int` | valid + invalid |
| `valid_reps` | `int` | |
| `invalid_reps` | `int` | |
| `form_score` | `numeric(5,2)` | 0–100, formula in FORM_SCORE.md |
| `view_type` | `text` | `side` \| `diagonal` \| `front` |
| `mode` | `text` | `workout` \| `challenge` |
| `best_streak` | `int` | longest run of consecutive valid reps |
| `mean_rep_seconds` | `numeric(5,2)` | |
| `most_common_issue` | `text` NULL | issue code, e.g. `INCOMPLETE_DEPTH` |
| `created_at` | `timestamptz` | `now()` |

Constraints:
```sql
CHECK (total_reps >= 0 AND valid_reps >= 0 AND invalid_reps >= 0)
CHECK (valid_reps + invalid_reps = total_reps)
CHECK (form_score >= 0 AND form_score <= 100)
CHECK (duration_seconds >= 0)
```
The `valid_reps + invalid_reps = total_reps` check is deliberate: it makes the
"we count bad reps too" requirement structurally impossible to violate in the database.

### `workout_reps`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `session_id` | `uuid` FK → workout_sessions ON DELETE CASCADE | |
| `rep_number` | `int` | 1-based |
| `valid` | `boolean` | |
| `form_probability` | `numeric(5,4)` | model P(good), 0–1 |
| `form_label` | `text` | `good` \| `bad` \| `unknown` |
| `depth_score` | `numeric(5,2)` | 0–100 |
| `alignment_score` | `numeric(5,2)` | 0–100 |
| `tempo_score` | `numeric(5,2)` | 0–100 |
| `consistency_score` | `numeric(5,2)` | 0–100 |
| `detected_issue` | `text` NULL | primary issue code |
| `rep_duration_seconds` | `numeric(5,2)` | |
| `min_elbow_angle_deg` | `numeric(6,2)` | retained for auditability |
| `body_line_deviation_max` | `numeric(6,4)` | retained for auditability |
| `created_at` | `timestamptz` | `now()` |

Storing `min_elbow_angle_deg` and `body_line_deviation_max` keeps the geometric
evidence behind each verdict. Without them a score is unauditable, and during the
IT-fest demo a judge can ask "why was that rep bad?" and we can answer with numbers.

### `leaderboard_entries`

Deliberately **denormalised** — a leaderboard row must remain readable even if the
source session is deleted, and the challenge board is queried constantly during the fest.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `display_name` | `text` | sanitised, 1–24 chars |
| `valid_reps` | `int` | **primary sort key** |
| `invalid_reps` | `int` | |
| `form_score` | `numeric(5,2)` | tie-breaker #1 |
| `duration_seconds` | `int` | tie-breaker #2 (shorter wins) |
| `best_streak` | `int` | |
| `mode` | `text` | `challenge30` \| `free` |
| `session_id` | `uuid` FK NULL | |
| `created_at` | `timestamptz` | tie-breaker #3 (earlier wins) |

## 3. Leaderboard Ordering

```sql
ORDER BY valid_reps DESC,
         form_score DESC,
         duration_seconds ASC,
         created_at ASC
```

Primary = valid reps, matching the spec. `duration_seconds ASC` is the second tie-breaker
so a faster athlete who matched the same reps and score ranks higher. `created_at ASC`
gives a stable, deterministic final ordering so the board never visually reshuffles
between polls.

## 4. Row Level Security

RLS is enabled on all tables.

- `users`, `workout_sessions`, `workout_reps`: insert/select scoped to the owning
  device key. No client may read another device's history.
- `leaderboard_entries`: `SELECT` is public (it is a scoreboard); `INSERT` is permitted
  with validation constraints; `UPDATE`/`DELETE` are denied to clients entirely.
  This prevents someone editing their own name onto the top of the board.

A leaderboard row is inserted through a `SECURITY DEFINER` function so the insert can be
rate-limited and validated server-side, rather than trusting a raw client insert.

## 5. Indexes

```sql
CREATE INDEX idx_sessions_user_started ON workout_sessions (user_id, started_at DESC);
CREATE INDEX idx_sessions_created      ON workout_sessions (created_at DESC);
CREATE INDEX idx_reps_session          ON workout_reps (session_id, rep_number);
CREATE INDEX idx_leaderboard_rank      ON leaderboard_entries (valid_reps DESC, form_score DESC, duration_seconds ASC);
CREATE INDEX idx_leaderboard_mode      ON leaderboard_entries (mode, valid_reps DESC);
```

## 6. Offline Behaviour

The app is fully functional with **no database configured**. Sessions are written to
`localStorage` under key `aipc:sessions:v1` and the Progress page reads from there.

When Supabase env vars are present:
- writes go to Supabase **and** localStorage,
- the Progress page merges both sources, de-duplicating on session `id`.

This means the IT-fest demo cannot be broken by venue wifi, and the app is still a
complete working product for a reviewer who never sets up any backend.
