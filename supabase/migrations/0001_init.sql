-- =============================================================================
-- 0001_init.sql — AI Push-Up Coach — core schema
-- =============================================================================
--
-- Source of truth: docs/DATABASE_SCHEMA.md (names, types and nullability follow
-- that document exactly). Client-side shapes that must round-trip through these
-- tables: apps/web/lib/session-store.ts (`StoredSession`, `WorkoutSessionRecord`,
-- `LeaderboardEntry`) and apps/web/lib/workout-session.ts (`WorkoutRepRecord`).
--
-- PRIVACY CONTRACT (non-negotiable, see DATABASE_SCHEMA.md §1):
--   This schema stores NUMBERS ONLY. No video, no frames, no images, no raw
--   pose landmarks. Every value in this file is either a counter, a timestamp,
--   a bounded score, or a short categorical code. Per-rep geometry columns
--   (`min_elbow_angle_deg`, `body_line_deviation_max`) are scalar aggregates
--   derived in-browser from landmarks and then discarded — they are not
--   landmark data and cannot reconstruct a body.
--
-- MIGRATION POLICY: additive-only after demo day (DATABASE_SCHEMA.md §1).
--   Never drop or retype a column; add a new one and backfill.
--
-- NULLABILITY NOTE (no-fake-data rule, spec §26): `form_score` and
--   `mean_rep_seconds` are NULLABLE. The client legitimately has no score when
--   fewer than 3 reps were completed, and the app renders "--" rather than a
--   plausible-looking invented number. Making these NOT NULL would force the
--   client to fabricate a value.
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
-- pgcrypto supplies gen_random_uuid() on PostgreSQL < 13. On 13+ it is built in,
-- but the extension is harmless and keeps this migration portable.
create extension if not exists pgcrypto;

-- =============================================================================
-- Helper functions
-- =============================================================================

-- ---------------------------------------------------------------------------
-- public.current_device_key()
-- ---------------------------------------------------------------------------
-- Resolves the caller's device key from the PostgREST request header
-- `x-device-key`. This is the whole identity model: the app runs anonymously at
-- a booth, so "who am I" == "which browser localStorage key is this".
--
-- It is deliberately defensive: PostgREST always sets `request.headers`, but
-- this function is also reachable from plain psql (where the GUC is absent) and
-- from `supabase db push`, so both the missing-setting and malformed-JSON cases
-- fall back to NULL instead of erroring.
--
-- Returns NULL when no key is presented. Callers must treat NULL as
-- "anonymous, unscoped" — see 0003_rls.sql for how that is handled.
create or replace function public.current_device_key()
returns text
language plpgsql
stable
as $$
declare
  raw_headers text;
  key_value   text;
begin
  begin
    raw_headers := current_setting('request.headers', true);
  exception when others then
    raw_headers := null;
  end;

  if raw_headers is null or raw_headers = '' then
    return null;
  end if;

  begin
    key_value := (raw_headers::jsonb) ->> 'x-device-key';
  exception when others then
    return null;
  end;

  return nullif(btrim(coalesce(key_value, '')), '');
end;
$$;

comment on function public.current_device_key() is
  'Device identity for the anonymous booth client, read from the x-device-key request header. NULL = no key presented.';

-- ---------------------------------------------------------------------------
-- public.set_updated_at()
-- ---------------------------------------------------------------------------
-- Shared BEFORE UPDATE trigger. Clients cannot UPDATE these tables (see RLS),
-- so this only fires for service-role / admin / maintenance writes, but it keeps
-- `updated_at` truthful for every writer rather than only for well-behaved ones.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function public.set_updated_at() is
  'BEFORE UPDATE trigger: stamps updated_at = now(). Attached to every mutable table.';

-- =============================================================================
-- Enumerated types
-- =============================================================================
-- Closed value sets become real enum types so an invalid view/mode/label is a
-- database error rather than a silently-stored string. Each block is guarded so
-- the migration is re-runnable against a scratch database.
--
-- Adding a value later (e.g. a new IssueCode) is additive: ALTER TYPE ... ADD VALUE.

do $$
begin
  if not exists (
    select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'camera_view'
  ) then
    create type public.camera_view as enum ('side', 'diagonal', 'front');
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'session_mode'
  ) then
    create type public.session_mode as enum ('workout', 'challenge');
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'form_label'
  ) then
    create type public.form_label as enum ('good', 'bad', 'unknown');
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'issue_code'
  ) then
    create type public.issue_code as enum (
      'INCOMPLETE_DEPTH',
      'HIPS_TOO_HIGH',
      'HIPS_DROPPING',
      'BODY_NOT_STRAIGHT',
      'ELBOW_FLARE',
      'TOO_FAST',
      'KNEES_BENT',
      'PARTIAL_RANGE',
      'UNSTABLE',
      'LOW_CONFIDENCE'
    );
  end if;
end $$;

-- =============================================================================
-- Table: users
-- =============================================================================
-- Lightweight identity. The app works with no login at all; a row appears here
-- lazily on first save so a device's history can be scoped without an account.
--
-- PRIVACY: `display_name` is the ONLY user-supplied text in this schema and the
-- only field that could conceivably identify a person. It is optional, capped at
-- 24 characters, and sanitised before insert (see sanitize_display_name in
-- 0003_rls.sql). `device_key` is a random client-generated string stored in
-- localStorage — it identifies a browser, not a human, and carries no PII.
create table if not exists public.users (
  id           uuid        primary key default gen_random_uuid(),
  device_key   text        not null unique,
  display_name text        null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint users_device_key_len
    check (char_length(device_key) between 8 and 128),
  constraint users_display_name_len
    check (display_name is null or char_length(display_name) between 1 and 24)
);

comment on table public.users is
  'Anonymous per-device identity. One row per browser (device_key), created lazily on first save. No login, no email, no account.';
comment on column public.users.device_key is
  'Random client-generated key from localStorage (aipc:device:v1). Identifies a browser, not a person. The only scoping handle in the app.';
comment on column public.users.display_name is
  'Optional display name. The ONLY user-supplied text in the schema and the only potentially identifying field. 1-24 chars, sanitised on write.';

create trigger trg_users_updated_at
  before update on public.users
  for each row execute function public.set_updated_at();

-- =============================================================================
-- Table: workout_sessions
-- =============================================================================
-- One row per completed workout session. This is the Progress page's unit of
-- history and the source row behind a challenge leaderboard entry.
--
-- `user_id` is NULLABLE by design (anonymous sessions are valid), and
-- `device_key` is denormalised onto this table as well so a session can be
-- scoped to a device even when no `users` row was ever created — which is
-- exactly what the current client does (apps/web/lib/session-store.ts posts
-- directly to /rest/v1/workout_sessions and never creates a users row).
--
-- Column order and names follow docs/DATABASE_SCHEMA.md §2 exactly.
create table if not exists public.workout_sessions (
  id                uuid              primary key default gen_random_uuid(),
  user_id           uuid              null references public.users (id) on delete set null,
  device_key        text              null default public.current_device_key(),
  started_at        timestamptz       not null,
  ended_at          timestamptz       not null,
  duration_seconds  integer           not null,
  total_reps        integer           not null,
  valid_reps        integer           not null,
  invalid_reps      integer           not null,
  form_score        numeric(5, 2)     null,
  view_type         public.camera_view not null,
  mode              public.session_mode not null,
  best_streak       integer           not null default 0,
  mean_rep_seconds  numeric(5, 2)     null,
  most_common_issue public.issue_code  null,
  created_at        timestamptz       not null default now(),
  updated_at        timestamptz       not null default now(),

  -- Counts are never negative.
  constraint sessions_counts_nonneg
    check (total_reps >= 0 and valid_reps >= 0 and invalid_reps >= 0 and best_streak >= 0),

  -- The deliberate integrity rule from DATABASE_SCHEMA.md §2: bad reps are
  -- COUNTED, not discarded. This makes "we silently dropped the bad ones"
  -- structurally impossible to represent in the database.
  constraint sessions_counts_sum
    check (valid_reps + invalid_reps = total_reps),

  -- A streak of valid reps cannot exceed the number of valid reps.
  constraint sessions_best_streak_le_valid
    check (best_streak <= valid_reps),

  -- form_score is on a 0-100 scale (FORM_SCORE.md). NULL is legal and means
  -- "not enough data" — never a fabricated zero.
  constraint sessions_form_score_range
    check (form_score is null or (form_score >= 0 and form_score <= 100)),

  constraint sessions_duration_nonneg
    check (duration_seconds >= 0),

  constraint sessions_mean_rep_nonneg
    check (mean_rep_seconds is null or mean_rep_seconds >= 0),

  -- A session cannot end before it starts.
  constraint sessions_ended_after_started
    check (ended_at >= started_at)
);

comment on table public.workout_sessions is
  'One row per completed workout session: aggregate counts, form score and camera/view metadata. Contains no video, frames or landmarks — numbers only.';
comment on column public.workout_sessions.device_key is
  'Owning device (browser). Denormalised from users.device_key so sessions are scoped even for fully anonymous clients that never create a users row. NULL = client presented no device key.';
comment on column public.workout_sessions.form_score is
  'Session form score, 0-100. NULLABLE: NULL means "insufficient reps to score", which the UI renders as "--" rather than inventing a number.';
comment on column public.workout_sessions.duration_seconds is
  'Wall-clock session length excluding paused time (pose-lost auto-pause does not count against the athlete).';
comment on column public.workout_sessions.most_common_issue is
  'Issue code that occurred most often in this session, or NULL when no issue was detected.';
comment on column public.workout_sessions.view_type is
  'Camera view the analysis ran in (side | diagonal | front). Recorded because scoring confidence depends on the view.';

create trigger trg_workout_sessions_updated_at
  before update on public.workout_sessions
  for each row execute function public.set_updated_at();

-- =============================================================================
-- Table: workout_reps
-- =============================================================================
-- One row per detected rep. Stored per-rep (rather than as a JSONB blob) so the
-- Progress page can break a session down and so the form-score formula can be
-- recomputed from raw components instead of trusting one stored number.
--
-- PRIVACY: every column here is a DERIVED AGGREGATE. `min_elbow_angle_deg` and
-- `body_line_deviation_max` are the geometric evidence behind each verdict —
-- single scalars computed in-browser from landmarks that are then discarded.
-- They are not landmark data, not a pose, not a frame, and cannot be used to
-- reconstruct or identify a body. No column in this table holds video.
--
-- REPRODUCIBILITY: `form_probability` is stored alongside `decision_threshold`
-- (and `model_version` / `feature_spec_version`). A later model or threshold
-- change therefore does NOT retroactively rewrite history: an old rep still
-- explains exactly which verdict the model that saw it would have produced.
create table if not exists public.workout_reps (
  id                      uuid             primary key default gen_random_uuid(),
  session_id              uuid             not null references public.workout_sessions (id) on delete cascade,
  rep_number              integer          not null,
  valid                   boolean          not null,
  form_probability        numeric(5, 4)    null,
  decision_threshold      numeric(5, 4)    null,
  form_label              public.form_label not null,
  depth_score             numeric(5, 2)    null,
  alignment_score         numeric(5, 2)    null,
  tempo_score             numeric(5, 2)    null,
  consistency_score       numeric(5, 2)    null,
  detected_issue          public.issue_code null,
  rep_duration_seconds    numeric(5, 2)    null,
  min_elbow_angle_deg     numeric(6, 2)    null,
  body_line_deviation_max numeric(6, 4)    null,
  model_version           text             null,
  feature_spec_version    smallint         null,
  created_at              timestamptz      not null default now(),
  updated_at              timestamptz      not null default now(),

  constraint reps_rep_number_positive
    check (rep_number >= 1),

  -- Raw model output, stored verbatim. 0-1 because it is a probability.
  constraint reps_form_probability_range
    check (form_probability is null or (form_probability >= 0 and form_probability <= 1)),

  -- The threshold the probability was compared against AT THE TIME. 0-1.
  constraint reps_threshold_range
    check (decision_threshold is null or (decision_threshold >= 0 and decision_threshold <= 1)),

  -- Component scores are all on the same 0-100 scale as the session score.
  constraint reps_component_scores_range
    check (
      (depth_score       is null or (depth_score       >= 0 and depth_score       <= 100)) and
      (alignment_score   is null or (alignment_score   >= 0 and alignment_score   <= 100)) and
      (tempo_score       is null or (tempo_score       >= 0 and tempo_score       <= 100)) and
      (consistency_score is null or (consistency_score >= 0 and consistency_score <= 100))
    ),

  constraint reps_duration_nonneg
    check (rep_duration_seconds is null or rep_duration_seconds >= 0),

  -- An elbow angle in degrees is physically bounded by 0-180.
  constraint reps_elbow_angle_range
    check (min_elbow_angle_deg is null or (min_elbow_angle_deg >= 0 and min_elbow_angle_deg <= 180)),

  -- Deviation from the shoulder-hip-ankle line is a magnitude, never negative.
  constraint reps_body_line_deviation_nonneg
    check (body_line_deviation_max is null or body_line_deviation_max >= 0),

  constraint reps_feature_spec_version_nonneg
    check (feature_spec_version is null or feature_spec_version >= 0)
);

comment on table public.workout_reps is
  'One row per detected rep. Holds DERIVED AGGREGATE FEATURES ONLY (scores, probabilities, scalar geometry) — never video, frames or raw pose landmarks.';
comment on column public.workout_reps.form_probability is
  'Raw model P(good) for this rep, stored verbatim (0-1). Kept next to decision_threshold so a later model change cannot retroactively rewrite this verdict.';
comment on column public.workout_reps.decision_threshold is
  'The decision threshold that was applied to form_probability when this rep was judged. Stored per-rep for auditability; NULL means the client did not report it.';
comment on column public.workout_reps.model_version is
  'Identifier/version of the form model that produced form_probability. NULL when unknown (e.g. in-browser heuristic path).';
comment on column public.workout_reps.feature_spec_version is
  'Feature-spec version used for this rep, mirroring the API contract. NULL when the client did not report it.';
comment on column public.workout_reps.min_elbow_angle_deg is
  'Derived aggregate only: the smallest elbow angle observed during this rep, in degrees. NOT landmark data, NOT a pose, NOT video. Retained so a judge can ask "why was that rep bad?" and get a number back.';
comment on column public.workout_reps.body_line_deviation_max is
  'Derived aggregate only: the largest absolute shoulder-hip-ankle deviation during this rep. NOT landmark data, NOT a pose, NOT video. Retained purely for auditability of the verdict.';
comment on column public.workout_reps.valid is
  'Whether this rep counted as valid (good form). Invalid reps are still stored and still counted — see sessions_counts_sum.';

create trigger trg_workout_reps_updated_at
  before update on public.workout_reps
  for each row execute function public.set_updated_at();

-- =============================================================================
-- Indexes (DATABASE_SCHEMA.md §5, plus the device-scoped and date-scoped
-- lookups the Progress and Challenge pages need)
-- =============================================================================

-- Progress page: one device's history, newest first.
create index if not exists idx_sessions_user_started
  on public.workout_sessions (user_id, started_at desc);

-- Device-scoped history for fully anonymous clients (no users row).
create index if not exists idx_sessions_device_started
  on public.workout_sessions (device_key, started_at desc);

-- Sessions by date, across all devices (daily activity / recap queries).
create index if not exists idx_sessions_started
  on public.workout_sessions (started_at desc);

-- Recently written sessions.
create index if not exists idx_sessions_created
  on public.workout_sessions (created_at desc);

-- Progress page: fetch all reps of a session in rep order.
create index if not exists idx_reps_session
  on public.workout_reps (session_id, rep_number);

-- A rep number is unique within its session. Without this, a retried batch
-- insert would silently duplicate reps and inflate the Progress breakdown.
create unique index if not exists uq_reps_session_rep_number
  on public.workout_reps (session_id, rep_number);

commit;
