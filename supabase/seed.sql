-- =============================================================================
--
--   ####  #    # ####  ####     #####   ####  #    # ######
--   #   # #    # #   # #   #    #    # #    # ##   # #      *** DEV ONLY ***
--   #   # #    # #   # #   #    #    # #    # # #  # #####
--   #   # #    # #   # #   #    #    # #    # #  # # #      *** DEV ONLY ***
--   ####  ####  ####  ####     #####   ####  #   ## ######
--
--   THIS FILE CONTAINS SYNTHETIC DEMO DATA. IT IS FOR LOCAL DEVELOPMENT ONLY.
--   DO NOT RUN IT AGAINST PRODUCTION. DO NOT RUN IT AGAINST THE FEST BOOTH DB.
--
-- =============================================================================
--
-- supabase/seed.sql — local-development seed
--
-- WHAT THIS IS: a tiny, obviously fake dataset so a developer can open the
-- Progress page and the Challenge leaderboard on a fresh local database and see
-- that the schema, the RLS policies, the ranking view and the client's merge
-- logic all work together.
--
-- WHAT THIS IS NOT: production data, and never a fallback for missing data.
--   * Every display name is prefixed "DEMO SAMPLE" so a screenshot of this data
--     cannot be mistaken for real results.
--   * Every row is written with a fixed, memorable UUID in the 00000000-...
--     namespace, so it is trivially identifiable and trivially removable.
--   * The values are internally consistent with the schema's CHECK constraints
--     (valid + invalid = total, scores in range, ended_at >= started_at) but
--     they are INVENTED. They are not measurements of any person.
--   * No video, no frames, no landmarks — the schema has nowhere to put them.
--
-- The project's no-fake-data rule (spec §26) forbids inventing numbers *in the
-- product*. This file does not violate it: nothing here reaches a user unless a
-- developer explicitly runs this script on their own machine, and the app never
-- reads a seeded row as if it were measured. If you want to demo the UI with no
-- real workout, do it here, in development, and label it as such.
--
-- SAFETY GUARD: the script refuses to run unless the server it is connected to
-- is local (loopback address or unix socket) OR the operator explicitly opts in
-- with `PGOPTIONS='-c app.allow_demo_seed=on'`. A hosted Supabase database never
-- reports a loopback server address, so a copy-pasted `psql -f supabase/seed.sql`
-- against production aborts instead of polluting the scoreboard.
--
-- TO REMOVE THE DEMO DATA: the rows all share the 00000000-0000-4000-8000-
-- prefix. Deleting them is a single targeted statement (run it as the owner):
--   delete from public.leaderboard_entries where id::text like '00000000-0000-4000-8000-%';
--   delete from public.workout_sessions    where id::text like '00000000-0000-4000-8000-%';
--   delete from public.users               where id::text like '00000000-0000-4000-8000-%';
-- =============================================================================

do $$
declare
  server_addr text;
begin
  if current_setting('app.allow_demo_seed', true) = 'on' then
    raise notice 'seed.sql: demo seed explicitly allowed via app.allow_demo_seed=on';
    return;
  end if;

  server_addr := coalesce(host(inet_server_addr()), '');

  if inet_server_addr() is null or server_addr in ('127.0.0.1', '::1') then
    raise notice 'seed.sql: local server detected (%) — inserting DEMO ONLY data', coalesce(nullif(server_addr, ''), 'unix socket');
    return;
  end if;

  raise exception
    'seed.sql refused to run: connected to a non-local database server (%). This file is DEV-ONLY demo data. If you really mean it, re-run with PGOPTIONS=''-c app.allow_demo_seed=on''.',
    server_addr
    using errcode = 'P0001';
end $$;

begin;

-- -----------------------------------------------------------------------------
-- users — one synthetic device
-- -----------------------------------------------------------------------------
insert into public.users (id, device_key, display_name)
values (
  '00000000-0000-4000-8000-000000000001',
  'demo-device-key-000000000001',
  'DEMO SAMPLE ONE'
)
on conflict (id) do nothing;

-- -----------------------------------------------------------------------------
-- workout_sessions
-- -----------------------------------------------------------------------------
-- Session A: a 30-second challenge with one bad rep (INCOMPLETE_DEPTH), so the
-- Progress page has something with a fault to explain.
insert into public.workout_sessions (
  id, user_id, device_key, started_at, ended_at, duration_seconds,
  total_reps, valid_reps, invalid_reps, form_score, view_type, mode,
  best_streak, mean_rep_seconds, most_common_issue
)
values (
  '00000000-0000-4000-8000-0000000000a1',
  '00000000-0000-4000-8000-000000000001',
  'demo-device-key-000000000001',
  now() - interval '2 hours',
  now() - interval '2 hours' + interval '30 seconds',
  30, 3, 2, 1, 78.50, 'side', 'challenge',
  2, 1.90, 'INCOMPLETE_DEPTH'
)
on conflict (id) do nothing;

-- Session B: a short free workout, all reps valid.
insert into public.workout_sessions (
  id, user_id, device_key, started_at, ended_at, duration_seconds,
  total_reps, valid_reps, invalid_reps, form_score, view_type, mode,
  best_streak, mean_rep_seconds, most_common_issue
)
values (
  '00000000-0000-4000-8000-0000000000a2',
  '00000000-0000-4000-8000-000000000001',
  'demo-device-key-000000000001',
  now() - interval '1 day',
  now() - interval '1 day' + interval '12 seconds',
  12, 2, 2, 0, 84.00, 'diagonal', 'workout',
  2, 2.10, null
)
on conflict (id) do nothing;

-- -----------------------------------------------------------------------------
-- workout_reps — per-rep rows for both sessions
-- -----------------------------------------------------------------------------
-- Invented but internally plausible numbers. form_probability is stored next to
-- decision_threshold (0.47, the documented model threshold) so the demo also
-- exercises the auditability columns.
insert into public.workout_reps (
  id, session_id, rep_number, valid, form_probability, decision_threshold,
  form_label, depth_score, alignment_score, tempo_score, consistency_score,
  detected_issue, rep_duration_seconds, min_elbow_angle_deg,
  body_line_deviation_max, model_version, feature_spec_version
)
values
  -- Session A
  ('00000000-0000-4000-8000-0000000000b1',
   '00000000-0000-4000-8000-0000000000a1', 1, true,  0.9100, 0.4700, 'good',
   92.00, 88.00, 90.00, 85.00, null, 1.80, 88.40, 0.0410, 'demo-v0', 1),
  ('00000000-0000-4000-8000-0000000000b2',
   '00000000-0000-4000-8000-0000000000a1', 2, true,  0.7800, 0.4700, 'good',
   80.00, 86.00, 88.00, 82.00, null, 1.90, 92.10, 0.0520, 'demo-v0', 1),
  ('00000000-0000-4000-8000-0000000000b3',
   '00000000-0000-4000-8000-0000000000a1', 3, false, 0.2100, 0.4700, 'bad',
   44.00, 79.00, 71.00, 66.00, 'INCOMPLETE_DEPTH', 2.00, 118.30, 0.0680, 'demo-v0', 1),
  -- Session B
  ('00000000-0000-4000-8000-0000000000b4',
   '00000000-0000-4000-8000-0000000000a2', 1, true,  0.8400, 0.4700, 'good',
   86.00, 83.00, 84.00, 81.00, null, 2.00, 90.20, 0.0470, 'demo-v0', 1),
  ('00000000-0000-4000-8000-0000000000b5',
   '00000000-0000-4000-8000-0000000000a2', 2, true,  0.8800, 0.4700, 'good',
   88.00, 85.00, 82.00, 84.00, null, 2.20, 87.60, 0.0430, 'demo-v0', 1)
on conflict (id) do nothing;

-- -----------------------------------------------------------------------------
-- leaderboard_entries
-- -----------------------------------------------------------------------------
-- Two challenge-board rows. The second deliberately has session_id = NULL, which
-- exercises the ON DELETE SET NULL / denormalised-by-design path.
insert into public.leaderboard_entries (
  id, display_name, device_key, valid_reps, invalid_reps, form_score,
  duration_seconds, best_streak, mode, session_id
)
values
  ('00000000-0000-4000-8000-0000000000c1',
   'DEMO SAMPLE ONE', 'demo-device-key-000000000001',
   2, 1, 78.50, 30, 2, 'challenge30',
   '00000000-0000-4000-8000-0000000000a1'),
  ('00000000-0000-4000-8000-0000000000c2',
   'DEMO SAMPLE TWO', 'demo-device-key-000000000002',
   5, 0, 91.25, 30, 5, 'challenge30',
   null)
on conflict (id) do nothing;

commit;

-- =============================================================================
-- Sanity read-back: prints the board exactly as the Challenge page will see it.
-- =============================================================================
select
  rank_position,
  display_name,
  valid_reps,
  form_score,
  duration_seconds
from public.leaderboard_top('challenge30', 10);

-- =============================================================================
-- END OF DEV-ONLY SEED — the data above is synthetic. Do not ship it.
-- =============================================================================
