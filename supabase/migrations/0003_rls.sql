-- =============================================================================
-- 0003_rls.sql — AI Push-Up Coach — Row Level Security, validation, RPCs
-- =============================================================================
--
-- THREAT MODEL
-- ------------
-- This app runs unattended at a school IT-fest booth. There is no login, no
-- session cookie, no user account. Every client holds the same public anon key,
-- so "the anon role" is not a trusted principal: assume anyone can read the
-- shipped JS bundle, extract the anon key, and issue arbitrary PostgREST calls.
--
-- The only identity signal available is `x-device-key`: a random string the
-- client generates and keeps in localStorage (apps/web/lib/session-store.ts
-- `getDeviceKey()`). It is a *scope*, not a credential — it is not secret from
-- its own holder, but it is unguessable (UUIDv4) and is never disclosed to
-- other clients. Everything below is therefore built on:
--
--   1. Writes are append-only. Clients may INSERT; nobody may UPDATE or DELETE
--      another party's rows. A tampered client can add a bad row but cannot
--      rewrite history or erase evidence.
--   2. Reads are scoped by device key. A device cannot read another device's
--      identified history.
--   3. Values are validated by the DATABASE, not the client. Every score range,
--      count relationship and time ordering is a CHECK constraint (0001/0002),
--      so a hostile client cannot store an impossible session.
--   4. The public scoreboard is write-validated and rate-limited server-side,
--      because a scoreboard everyone can see is the obvious abuse target.
--
-- WHY NOT `FORCE ROW LEVEL SECURITY`: the table owner must stay able to run
-- maintenance (backfills, the Supabase dashboard, `supabase db push`) without
-- writing a policy for itself. The Supabase `service_role` bypasses RLS anyway,
-- so FORCE would only inconvenience the owner, not harden anything.
--
-- NOTE ON ROLES: `anon` and `authenticated` are Supabase-managed roles and are
-- assumed to exist. Plain-PostgreSQL test harnesses must create them first.
-- =============================================================================

begin;

-- =============================================================================
-- Display-name sanitiser
-- =============================================================================
-- DATABASE_SCHEMA.md §1: `display_name` is the only user-supplied text and is
-- "sanitised (trimmed, length-capped, control characters stripped) before
-- insert". This mirrors `sanitizeName()` in apps/web/lib/session-store.ts
-- exactly, so a name rendered from localStorage and one rendered from Postgres
-- are the same string.
--
-- Runs server-side because the client's copy is advisory: nothing stops a
-- hostile client from posting a 4KB name containing ANSI escapes that would
-- scramble the projector at the booth.
--
-- Returns NULL for NULL/blank input; callers decide the fallback ('Anonymous').
create or replace function public.sanitize_display_name(p_raw text)
returns text
language sql
immutable
as $$
  select case
    when p_raw is null then null
    else nullif(
      left(
        btrim(
          regexp_replace(               -- collapse runs of whitespace to one space
            regexp_replace(p_raw, '[[:cntrl:]]', '', 'g'),  -- strip control chars
            '\s+', ' ', 'g'
          )
        ),
        24                              -- length cap (DATABASE_SCHEMA.md §2)
      ),
      ''
    )
  end;
$$;

comment on function public.sanitize_display_name(text) is
  'Trims, collapses whitespace, strips control characters and caps at 24 chars. Mirrors sanitizeName() in the web client. NULL for blank input.';

-- =============================================================================
-- Session visibility helper
-- =============================================================================
-- A device may see a session when it owns it (matching device key), or when the
-- session is unattributable (stored with no device key) AND the caller is itself
-- unattributable.
--
-- WHY THE SECOND DISJUNCT EXISTS — and what it costs:
--   The shipped client (apps/web/lib/session-store.ts) posts sessions with
--   `Prefer: return=representation` and needs the inserted row's `id` back in
--   order to attach the per-rep batch. PostgreSQL applies SELECT policies to a
--   RETURNING row, so a strict `device_key = current_device_key()` policy would
--   make the shipped client's insert unusable whenever it omits the header.
--
--   The trade-off: rows with device_key IS NULL can be listed by any caller that
--   also presents no device key. Those rows are unattributable by construction —
--   they carry rep counts, scores, timestamps and a camera view, and no name,
--   device identifier, video or landmark data. No *identified* device's history
--   is ever exposed. This is accepted for a booth demo; the strict alternative
--   (drop the second disjunct and always send `x-device-key`) is a one-line
--   change documented in supabase/README.md.
--
-- SECURITY DEFINER: the check must not itself be filtered by the RLS policies it
-- is used inside, otherwise the reps policies would evaluate recursively. The
-- function returns a boolean and discloses nothing beyond the caller's own
-- entitlement.
create or replace function public.session_visible_to_caller(p_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.workout_sessions s
    where s.id = p_session_id
      and (
        s.device_key = public.current_device_key()
        or (s.device_key is null and public.current_device_key() is null)
      )
  );
$$;

comment on function public.session_visible_to_caller(uuid) is
  'True when the calling device may see the given session: it owns it, or both the session and the caller are unattributable (no device key).';

-- =============================================================================
-- Enable RLS
-- =============================================================================
alter table public.users               enable row level security;
alter table public.workout_sessions    enable row level security;
alter table public.workout_reps        enable row level security;
alter table public.leaderboard_entries enable row level security;

-- =============================================================================
-- Policies: users
-- =============================================================================
-- A device may only see and create its own identity row. There is no legitimate
-- reason for one browser to enumerate other devices.
-- Note the insert policy does NOT allow a NULL device key: a users row without a
-- key is meaningless, so it is rejected rather than stored as a ghost.
drop policy if exists users_select_own_device on public.users;
create policy users_select_own_device
  on public.users
  for select
  to anon, authenticated
  using (device_key = public.current_device_key());

drop policy if exists users_insert_own_device on public.users;
create policy users_insert_own_device
  on public.users
  for insert
  to anon, authenticated
  with check (device_key is not null and device_key = public.current_device_key());

-- =============================================================================
-- Policies: workout_sessions
-- =============================================================================
-- INSERT: permitted for anonymous booth clients. The WITH CHECK forbids a client
-- from *claiming* another device's key — it may write its own key (the column
-- DEFAULT fills it in from the header) or no key at all. It cannot forge a row
-- that appears to belong to someone else.
drop policy if exists sessions_insert_own_device on public.workout_sessions;
create policy sessions_insert_own_device
  on public.workout_sessions
  for insert
  to anon, authenticated
  with check (
    device_key is null
    or device_key = public.current_device_key()
  );

-- SELECT: only the caller's own sessions, plus unattributable ones (see the
-- session_visible_to_caller comment above for the rationale and its cost).
drop policy if exists sessions_select_own_device on public.workout_sessions;
create policy sessions_select_own_device
  on public.workout_sessions
  for select
  to anon, authenticated
  using (
    device_key = public.current_device_key()
    or (device_key is null and public.current_device_key() is null)
  );

-- NO update policy and NO delete policy, deliberately.
-- Omitting a policy is how RLS denies an operation: history is append-only, and
-- a booth client has no legitimate reason to rewrite or erase a completed
-- session. This is the requirement "without allowing arbitrary deletion of
-- other people's data" — enforced by absence, which cannot be misconfigured.

-- =============================================================================
-- Policies: workout_reps
-- =============================================================================
-- Reps inherit their session's scope. The INSERT check walks to the parent
-- session, so a client cannot graft reps onto a session it cannot see (it would
-- have to guess the parent's UUID *and* match its device key).
drop policy if exists reps_select_own_session on public.workout_reps;
create policy reps_select_own_session
  on public.workout_reps
  for select
  to anon, authenticated
  using (public.session_visible_to_caller(session_id));

drop policy if exists reps_insert_own_session on public.workout_reps;
create policy reps_insert_own_session
  on public.workout_reps
  for insert
  to anon, authenticated
  with check (public.session_visible_to_caller(session_id));

-- NO update policy and NO delete policy: a rep verdict is evidence. Being able
-- to edit a rep after the fact would make the whole form score unauditable.

-- =============================================================================
-- Policies: leaderboard_entries
-- =============================================================================
-- SELECT is public: it is a scoreboard, and the whole point is that everyone at
-- the fest can see it. No device key required.
drop policy if exists leaderboard_public_read on public.leaderboard_entries;
create policy leaderboard_public_read
  on public.leaderboard_entries
  for select
  to anon, authenticated
  using (true);

-- INSERT is permitted to clients, but only under the server-side validation in
-- the BEFORE INSERT trigger below (sanitised name, rate limit, and — when a
-- session is referenced — the claim must not exceed what the session recorded).
--
-- DIVERGENCE FROM DATABASE_SCHEMA.md §4, stated openly:
--   §4 says a leaderboard row is inserted "through a SECURITY DEFINER function
--   ... rather than trusting a raw client insert". The function exists
--   (`submit_leaderboard_entry` below) and is the recommended path. But the
--   client that ships today posts straight to /rest/v1/leaderboard_entries
--   (apps/web/lib/session-store.ts, pushLeaderboardRemote). Denying raw inserts
--   would therefore silently break the Challenge page's remote mirror, so raw
--   inserts are allowed *with* the same validation the function applies, and the
--   function remains available as the hardened, single-round-trip path.
--   Either way UPDATE and DELETE are denied, which is what actually protects the
--   board from being edited.
drop policy if exists leaderboard_insert_validated on public.leaderboard_entries;
create policy leaderboard_insert_validated
  on public.leaderboard_entries
  for insert
  to anon, authenticated
  with check (
    -- Range and count sanity, mirrored from the table CHECKs so the failure
    -- message points at the policy rather than at a constraint name.
    char_length(coalesce(display_name, '')) between 1 and 24
    and valid_reps >= 0
    and invalid_reps >= 0
    and best_streak >= 0
    and best_streak <= valid_reps
    and form_score >= 0
    and form_score <= 100
    and duration_seconds >= 0
    -- A client may only stamp its own device key, never someone else's.
    and (device_key is null or device_key = public.current_device_key())
  );

-- NO update policy and NO delete policy: this is the rule that stops someone
-- renaming themselves to the top of the board, or deleting the entry above them.

-- =============================================================================
-- Leaderboard abuse controls (BEFORE INSERT trigger)
-- =============================================================================
-- Runs for BOTH insert paths (raw PostgREST insert and the RPC), so validation
-- cannot be bypassed by choosing the other door.
--
--   1. Sanitise the display name, falling back to 'Anonymous' so the projector
--      never renders an empty row.
--   2. Rate limit: at most 5 submissions per device per minute. A booth device
--      is used repeatedly and legitimately, so the limit is permissive; it
--      exists to stop a scripted flood, not to police retries.
--   3. Session consistency: if the entry points at a stored session, the claimed
--      valid reps may not exceed what that session recorded. This is the
--      no-fake-data rule applied to the one table everyone can see — you cannot
--      submit a score your own session does not support.
--
-- SECURITY DEFINER so the rate-limit count is not affected by the caller's RLS
-- visibility (it must count ALL of that device's rows, not just the visible ones).
create or replace function public.leaderboard_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_device_key        text;
  v_recent_count      integer;
  v_session_valid     integer;
  v_session_found     boolean;
begin
  -- 1. Identity: trust the header, keep an explicit key only if the policy
  --    already allowed it (the policy checks the same condition).
  v_device_key := coalesce(
    nullif(btrim(coalesce(new.device_key, '')), ''),
    public.current_device_key()
  );
  new.device_key := v_device_key;

  -- 2. Name.
  new.display_name := coalesce(
    public.sanitize_display_name(new.display_name),
    'Anonymous'
  );

  -- 3. Rate limit (only enforceable when the submission is attributable).
  if v_device_key is not null then
    select count(*)
      into v_recent_count
      from public.leaderboard_entries e
     where e.device_key = v_device_key
       and e.created_at > now() - interval '60 seconds';

    if v_recent_count >= 5 then
      raise exception
        'leaderboard rate limit: at most 5 submissions per device per minute'
        using errcode = 'P0001',
              hint    = 'Wait a moment before submitting another score.';
    end if;
  end if;

  -- 4. Session consistency.
  if new.session_id is not null then
    select s.valid_reps
      into v_session_valid
      from public.workout_sessions s
     where s.id = new.session_id;

    v_session_found := found;

    if not v_session_found then
      raise exception
        'leaderboard entry references unknown session %', new.session_id
        using errcode = 'P0001';
    end if;

    if new.valid_reps > v_session_valid then
      raise exception
        'leaderboard entry claims % valid reps but session % recorded %',
        new.valid_reps, new.session_id, v_session_valid
        using errcode = 'P0001',
              hint    = 'A score must be supported by the session that produced it.';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.leaderboard_before_insert() is
  'BEFORE INSERT on leaderboard_entries: sanitises display_name, enforces a per-device rate limit, and rejects a score that exceeds its referenced session.';

drop trigger if exists trg_leaderboard_before_insert on public.leaderboard_entries;
create trigger trg_leaderboard_before_insert
  before insert on public.leaderboard_entries
  for each row execute function public.leaderboard_before_insert();

-- =============================================================================
-- RPC: submit_leaderboard_entry(...)
-- =============================================================================
-- The hardened, single-round-trip submission path recommended by
-- DATABASE_SCHEMA.md §4. Use it instead of a raw insert when you want the
-- server to own validation, clamping and the response shape:
--
--   select * from public.submit_leaderboard_entry(
--     p_display_name     := 'Priya',
--     p_valid_reps       := 22,
--     p_invalid_reps     := 3,
--     p_form_score       := 87.5,
--     p_duration_seconds := 30,
--     p_best_streak      := 11
--   );
--
-- SECURITY DEFINER: the function performs its own validation and then inserts,
-- so it deliberately bypasses the RLS insert policies. It re-applies every rule
-- they enforce (plus an anti-abuse ceiling that a CHECK constraint should not
-- carry, because a legitimate marathon session could exceed it).
create or replace function public.submit_leaderboard_entry(
  p_display_name     text,
  p_valid_reps       integer,
  p_invalid_reps     integer,
  p_form_score       numeric,
  p_duration_seconds integer,
  p_best_streak      integer                 default 0,
  p_mode             public.leaderboard_mode default 'challenge30',
  p_session_id       uuid                    default null,
  p_device_key       text                    default null
)
returns public.leaderboard_entries
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row        public.leaderboard_entries;
  v_device_key text;
  v_name       text;
begin
  v_device_key := coalesce(
    nullif(btrim(coalesce(p_device_key, '')), ''),
    public.current_device_key()
  );

  v_name := coalesce(public.sanitize_display_name(p_display_name), 'Anonymous');

  -- --- validation -----------------------------------------------------------
  if p_valid_reps is null or p_valid_reps < 0 then
    raise exception 'p_valid_reps must be >= 0' using errcode = 'P0001';
  end if;

  if p_invalid_reps is null or p_invalid_reps < 0 then
    raise exception 'p_invalid_reps must be >= 0' using errcode = 'P0001';
  end if;

  if coalesce(p_best_streak, 0) < 0 or coalesce(p_best_streak, 0) > p_valid_reps then
    raise exception 'p_best_streak must be between 0 and p_valid_reps' using errcode = 'P0001';
  end if;

  if p_duration_seconds is null or p_duration_seconds < 0 then
    raise exception 'p_duration_seconds must be >= 0' using errcode = 'P0001';
  end if;

  if p_form_score is null or p_form_score < 0 or p_form_score > 100 then
    raise exception 'p_form_score must be between 0 and 100' using errcode = 'P0001';
  end if;

  -- Anti-abuse ceiling. Not a CHECK constraint on purpose: a genuine long
  -- session must remain storable, but nobody submits 500 valid reps in a
  -- 30-second challenge. Values above the ceiling are rejected, never clamped —
  -- silently rewriting a score would be exactly the kind of fake data this
  -- project forbids.
  if p_valid_reps > 500 then
    raise exception 'p_valid_reps of % is implausible and was rejected', p_valid_reps
      using errcode = 'P0001';
  end if;

  if p_duration_seconds > 7200 then
    raise exception 'p_duration_seconds of % is implausible and was rejected', p_duration_seconds
      using errcode = 'P0001';
  end if;

  -- --- insert ---------------------------------------------------------------
  -- The BEFORE INSERT trigger re-checks the rate limit, re-sanitises the name and
  -- validates the session claim, so those rules hold here too.
  insert into public.leaderboard_entries (
    display_name,
    device_key,
    valid_reps,
    invalid_reps,
    form_score,
    duration_seconds,
    best_streak,
    mode,
    session_id
  )
  values (
    v_name,
    v_device_key,
    p_valid_reps,
    p_invalid_reps,
    p_form_score,
    p_duration_seconds,
    coalesce(p_best_streak, 0),
    coalesce(p_mode, 'challenge30'),
    p_session_id
  )
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.submit_leaderboard_entry(text, integer, integer, numeric, integer, integer, public.leaderboard_mode, uuid, text) is
  'Validated leaderboard submission (SECURITY DEFINER). Rejects impossible or implausible scores instead of clamping them, and returns the stored row.';

-- =============================================================================
-- RPC: ensure_device_user(device_key, display_name)
-- =============================================================================
-- DATABASE_SCHEMA.md §2: "a row is created lazily on first save so history can
-- be scoped to a device/browser without requiring login." This is that lazy
-- creation, idempotent on device_key.
--
-- SECURITY DEFINER so the upsert works even when the caller has no SELECT
-- visibility into users yet (first-ever save), while still refusing to let a
-- caller create an identity for a key it does not hold.
create or replace function public.ensure_device_user(
  p_device_key   text,
  p_display_name text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_key  text;
  v_id   uuid;
  v_name text;
begin
  v_key := nullif(btrim(coalesce(p_device_key, public.current_device_key(), '')), '');

  if v_key is null then
    raise exception 'ensure_device_user: no device key supplied and no x-device-key header present'
      using errcode = 'P0001';
  end if;

  if char_length(v_key) < 8 then
    raise exception 'ensure_device_user: device key must be at least 8 characters'
      using errcode = 'P0001';
  end if;

  -- A caller may only ever claim a key it actually holds.
  if public.current_device_key() is not null
     and v_key <> public.current_device_key() then
    raise exception 'ensure_device_user: refusing to create an identity for another device'
      using errcode = 'P0001';
  end if;

  v_name := public.sanitize_display_name(p_display_name);

  insert into public.users (device_key, display_name)
  values (v_key, v_name)
  on conflict (device_key) do update
    set display_name = coalesce(excluded.display_name, public.users.display_name),
        updated_at   = now()
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.ensure_device_user(text, text) is
  'Idempotently creates/updates the anonymous users row for a device key. Refuses to create an identity for a key the caller does not hold.';

-- =============================================================================
-- Privileges
-- =============================================================================
-- Supabase grants table privileges to anon/authenticated by default, but relying
-- on defaults means the security posture is invisible in the migration. These
-- grants are explicit and minimal:
--   * no UPDATE and no DELETE anywhere  -> append-only history, uneditable board
--   * users: own row only (still RLS-filtered above)
--   * leaderboard: read everything, insert validated rows
-- service_role and postgres keep their own (broader) privileges; nothing here
-- affects them.
grant usage on schema public to anon, authenticated;

grant select, insert on public.users               to anon, authenticated;
grant select, insert on public.workout_sessions    to anon, authenticated;
grant select, insert on public.workout_reps        to anon, authenticated;
grant select, insert on public.leaderboard_entries to anon, authenticated;

-- Belt and braces: even if a future migration grants ALL by accident, these
-- revokes keep the append-only guarantee in place.
revoke update, delete, truncate on public.users               from anon, authenticated;
revoke update, delete, truncate on public.workout_sessions    from anon, authenticated;
revoke update, delete, truncate on public.workout_reps        from anon, authenticated;
revoke update, delete, truncate on public.leaderboard_entries from anon, authenticated;

grant select on public.leaderboard_ranked          to anon, authenticated;
grant select on public.leaderboard_best_per_device to anon, authenticated;

grant execute on function public.current_device_key()                    to anon, authenticated;
grant execute on function public.sanitize_display_name(text)             to anon, authenticated;
grant execute on function public.session_visible_to_caller(uuid)         to anon, authenticated;
grant execute on function public.leaderboard_top(public.leaderboard_mode, integer) to anon, authenticated;
grant execute on function public.submit_leaderboard_entry(text, integer, integer, numeric, integer, integer, public.leaderboard_mode, uuid, text) to anon, authenticated;
grant execute on function public.ensure_device_user(text, text)          to anon, authenticated;

-- Internal helpers must not be reachable from the API surface.
-- REVOKE ... FROM PUBLIC, not from anon/authenticated: PostgreSQL grants EXECUTE
-- to PUBLIC by default, so revoking only from the named roles would leave the
-- grant in place and the helper callable through PostgREST.
revoke execute on function public.leaderboard_before_insert() from public;
revoke execute on function public.set_updated_at()            from public;

commit;
