-- =============================================================================
-- 0002_leaderboard.sql — AI Push-Up Coach — leaderboard table, ranking, indexes
-- =============================================================================
--
-- Source of truth: docs/DATABASE_SCHEMA.md §2 (`leaderboard_entries`) and §3
-- (ordering). The ordering implemented here is byte-for-byte the same one the
-- client applies locally in apps/web/lib/session-store.ts `rankEntries()`, so a
-- scoreboard built from localStorage and one built from Postgres sort
-- identically. If you change one, change the other.
--
--   1. valid_reps        DESC   primary
--   2. form_score        DESC   tie-break 1
--   3. duration_seconds  ASC    tie-break 2 (faster athlete wins)
--   4. created_at        ASC    deterministic final ordering (board never
--                               reshuffles between polls)
--
-- WHY DENORMALISED: a leaderboard row must stay readable even if the source
-- session is deleted (the foreign key is ON DELETE SET NULL, not CASCADE), and
-- the challenge board is queried constantly during the fest. A join per poll is
-- a needless cost for data that never changes after insert.
--
-- PRIVACY: the only user-supplied value is `display_name` (sanitised, 1-24
-- chars). Everything else is a count or a score. No video, no landmarks.
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- Enum: leaderboard_mode
-- ---------------------------------------------------------------------------
-- `challenge30` is the 30-second booth challenge the board displays by default;
-- `free` covers open-ended sessions that still want to be ranked.
do $$
begin
  if not exists (
    select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'leaderboard_mode'
  ) then
    create type public.leaderboard_mode as enum ('challenge30', 'free');
  end if;
end $$;

-- =============================================================================
-- Table: leaderboard_entries
-- =============================================================================
create table if not exists public.leaderboard_entries (
  id               uuid                    primary key default gen_random_uuid(),
  display_name     text                    not null,
  device_key       text                    null default public.current_device_key(),
  valid_reps       integer                 not null,
  invalid_reps     integer                 not null,
  form_score       numeric(5, 2)           not null default 0,
  duration_seconds integer                 not null,
  best_streak      integer                 not null default 0,
  mode             public.leaderboard_mode not null,
  session_id       uuid                    null references public.workout_sessions (id) on delete set null,
  created_at       timestamptz             not null default now(),
  updated_at       timestamptz             not null default now(),

  -- Sanitised display name, 1-24 chars (DATABASE_SCHEMA.md §2). The lower bound
  -- matters: an empty name would render as a blank row on the booth projector.
  constraint leaderboard_display_name_len
    check (char_length(display_name) between 1 and 24),

  -- No control characters. Rejected here as well as stripped in the trigger, so
  -- a service-role write cannot bypass the sanitiser by accident.
  constraint leaderboard_display_name_printable
    check (display_name !~ '[[:cntrl:]]'),

  constraint leaderboard_counts_nonneg
    check (valid_reps >= 0 and invalid_reps >= 0 and best_streak >= 0),

  constraint leaderboard_best_streak_le_valid
    check (best_streak <= valid_reps),

  -- Same 0-100 scale as workout_sessions.form_score.
  constraint leaderboard_form_score_range
    check (form_score >= 0 and form_score <= 100),

  constraint leaderboard_duration_nonneg
    check (duration_seconds >= 0)
);

comment on table public.leaderboard_entries is
  'Denormalised scoreboard row for challenge mode. Publicly readable; clients may insert but never update or delete. Survives deletion of its source session (FK is ON DELETE SET NULL).';
comment on column public.leaderboard_entries.display_name is
  'The ONLY user-supplied text on the board, sanitised to 1-24 printable characters. The only field that could plausibly identify a person.';
comment on column public.leaderboard_entries.valid_reps is
  'PRIMARY sort key: number of reps that passed form validation.';
comment on column public.leaderboard_entries.form_score is
  'Tie-break #1, 0-100. Higher wins. NOT NULL here because the board needs a total order — the client sends 0 when it has no score.';
comment on column public.leaderboard_entries.duration_seconds is
  'Tie-break #2. Lower wins, so a faster athlete who matched the same reps and score ranks higher.';
comment on column public.leaderboard_entries.created_at is
  'Tie-break #3. Lower wins, giving a stable deterministic ordering so the projected board never visually reshuffles between polls.';
comment on column public.leaderboard_entries.device_key is
  'Submitting device (browser), when it presented an x-device-key header. Used for rate limiting and for the best-per-device view. NULL = anonymous submission.';
comment on column public.leaderboard_entries.session_id is
  'Source session, when the entry came from one. NULL is legal: the board must stay readable after a session is deleted, and the client may submit a score with no stored session (offline-first).';

create trigger trg_leaderboard_entries_updated_at
  before update on public.leaderboard_entries
  for each row execute function public.set_updated_at();

-- =============================================================================
-- Indexes
-- =============================================================================

-- DATABASE_SCHEMA.md §5, verbatim.
create index if not exists idx_leaderboard_rank
  on public.leaderboard_entries (valid_reps desc, form_score desc, duration_seconds asc);

-- DATABASE_SCHEMA.md §5, verbatim. Serves the challenge board, which always
-- filters to one mode.
create index if not exists idx_leaderboard_mode
  on public.leaderboard_entries (mode, valid_reps desc);

-- The full four-key ordering including the deterministic created_at tail, so the
-- board query can be answered entirely from the index with no sort step.
create index if not exists idx_leaderboard_mode_rank_full
  on public.leaderboard_entries (mode, valid_reps desc, form_score desc, duration_seconds asc, created_at asc);

-- Best-per-device lookups and rate-limit counting.
create index if not exists idx_leaderboard_device_created
  on public.leaderboard_entries (device_key, created_at desc);

-- =============================================================================
-- View: leaderboard_ranked
-- =============================================================================
-- Adds competition ranking to every entry. `rank()` (not row_number) is used on
-- purpose: two athletes on identical reps/score/duration/created_at are genuinely
-- tied and should share a rank, and the next athlete should skip the gap — a
-- scoreboard that invents a distinction between identical rows is lying.
--
-- Ranks are computed per mode (partition by mode) because a 30-second challenge
-- score and a free session are not comparable.
--
-- security_invoker = on: the view runs with the CALLER's permissions, so the RLS
-- policies on leaderboard_entries still apply. Without it a view would be a
-- convenient way to read rows a policy is supposed to hide.
create or replace view public.leaderboard_ranked
with (security_invoker = on)
as
select
  e.id,
  e.display_name,
  e.device_key,
  e.valid_reps,
  e.invalid_reps,
  e.form_score,
  e.duration_seconds,
  e.best_streak,
  e.mode,
  e.session_id,
  e.created_at,
  rank() over (
    partition by e.mode
    order by e.valid_reps desc,
             e.form_score desc,
             e.duration_seconds asc,
             e.created_at asc
  ) as rank_position,
  count(*) over (partition by e.mode) as entries_in_mode
from public.leaderboard_entries e;

comment on view public.leaderboard_ranked is
  'Leaderboard entries with a competition rank per mode. Implements DATABASE_SCHEMA.md §3 ordering exactly; ties share a rank.';

-- =============================================================================
-- View: leaderboard_best_per_device
-- =============================================================================
-- One row per device: its single best attempt. A booth device is used by the
-- same person repeatedly, so without this the top of the board fills with
-- retries from one browser. Entries with no device_key are keyed by their own id
-- (each anonymous submission stands alone).
create or replace view public.leaderboard_best_per_device
with (security_invoker = on)
as
select distinct on (coalesce(e.device_key, e.id::text))
  e.id,
  e.display_name,
  e.device_key,
  e.valid_reps,
  e.invalid_reps,
  e.form_score,
  e.duration_seconds,
  e.best_streak,
  e.mode,
  e.created_at
from public.leaderboard_entries e
order by coalesce(e.device_key, e.id::text),
         e.valid_reps desc,
         e.form_score desc,
         e.duration_seconds asc,
         e.created_at asc;

comment on view public.leaderboard_best_per_device is
  'Each device''s single best attempt, so repeated retries from one booth browser do not flood the board.';

-- =============================================================================
-- Function: leaderboard_top(mode, limit)
-- =============================================================================
-- The single call the Challenge page needs. Keeping the ordering in one
-- function means the client cannot drift from the documented sort order, and the
-- limit is clamped so a stray `limit=100000` cannot ask Postgres to rank the
-- whole table during the demo.
create or replace function public.leaderboard_top(
  p_mode  public.leaderboard_mode default 'challenge30',
  p_limit integer                 default 100
)
returns table (
  rank_position    bigint,
  id               uuid,
  display_name     text,
  valid_reps       integer,
  invalid_reps     integer,
  form_score       numeric(5, 2),
  duration_seconds integer,
  best_streak      integer,
  mode             public.leaderboard_mode,
  created_at       timestamptz
)
language sql
stable
set search_path = public, pg_temp
as $$
  select
    r.rank_position,
    r.id,
    r.display_name,
    r.valid_reps,
    r.invalid_reps,
    r.form_score,
    r.duration_seconds,
    r.best_streak,
    r.mode,
    r.created_at
  from public.leaderboard_ranked r
  where r.mode = coalesce(p_mode, 'challenge30')
  order by r.rank_position asc, r.created_at asc
  limit greatest(1, least(coalesce(p_limit, 100), 500));
$$;

comment on function public.leaderboard_top(public.leaderboard_mode, integer) is
  'Top N leaderboard rows for one mode, in documented rank order. Limit clamped to 1..500.';

commit;
