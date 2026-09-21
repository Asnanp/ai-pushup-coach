# Supabase schema — AI Push-Up Coach

PostgreSQL schema for the anonymous booth client. Numbers only — **no video, no
frames, no raw pose landmarks are stored anywhere in this schema.**

Authoritative spec: [`../docs/DATABASE_SCHEMA.md`](../docs/DATABASE_SCHEMA.md).
Client shapes that must round-trip: `apps/web/lib/session-store.ts`,
`apps/web/lib/workout-session.ts`, `packages/types/src/index.ts`.

## Files

| File | Contents |
|---|---|
| `migrations/0001_init.sql` | `pgcrypto`, helper functions, enum types, `users`, `workout_sessions`, `workout_reps`, constraints, indexes, `updated_at` triggers |
| `migrations/0002_leaderboard.sql` | `leaderboard_entries` + ranking views/functions + challenge-mode indexes |
| `migrations/0003_rls.sql` | Row Level Security policies, name sanitiser, leaderboard abuse controls, `SECURITY DEFINER` RPCs, explicit grants |
| `seed.sql` | **DEV-ONLY** synthetic demo data. Loudly labelled, guarded, never production |

Apply in filename order — they are not idempotent against each other's absence
(0002 references `workout_sessions`, 0003 references everything).

## Tables

- **`users`** — one anonymous identity per browser (`device_key`, no login).
- **`workout_sessions`** — one row per completed session: counts, form score,
  duration, camera view, mode.
- **`workout_reps`** — one row per detected rep: verdict, raw `form_probability`,
  the `decision_threshold` applied, component scores, and the scalar geometry
  behind the verdict.
- **`leaderboard_entries`** — denormalised scoreboard rows. Public read, validated
  append-only write.

## Applying the migrations

### Supabase CLI (recommended)

```bash
supabase link --project-ref <your-project-ref>
supabase db push                      # applies every migration in order
```

Local development:

```bash
supabase start
supabase db reset                     # rebuilds the DB and runs migrations
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/seed.sql
```

`supabase db reset` also runs `supabase/seed.sql` automatically if it is
registered under `[db.seed]` in `config.toml`:

```toml
[db.seed]
enabled = true
sql_paths = ["./seed.sql"]
```

### Plain `psql`

```bash
psql "$DATABASE_URL" --set ON_ERROR_STOP=1 -f supabase/migrations/0001_init.sql
psql "$DATABASE_URL" --set ON_ERROR_STOP=1 -f supabase/migrations/0002_leaderboard.sql
psql "$DATABASE_URL" --set ON_ERROR_STOP=1 -f supabase/migrations/0003_rls.sql
```

`ON_ERROR_STOP=1` matters: without it `psql` keeps going after a failure and you
end up with a half-applied schema.

Each file is wrapped in a single transaction, so a failure rolls the whole file
back. Enum creation is guarded, so re-running a file against a partially-applied
database is safe.

**Roles:** `0003_rls.sql` grants to `anon` and `authenticated`, which are
Supabase-managed. On a plain PostgreSQL instance (e.g. a test container) create
them first:

```sql
create role anon noinherit;
create role authenticated noinherit;
```

**Views:** `leaderboard_ranked` and `leaderboard_best_per_device` use
`security_invoker = on`, which requires PostgreSQL 15+. Supabase runs 15/16.

## Seeding (development only)

`seed.sql` refuses to run against a non-local server. Local loopback and unix
socket connections pass automatically; anything else aborts unless you opt in:

```bash
PGOPTIONS='-c app.allow_demo_seed=on' psql "$DATABASE_URL" -f supabase/seed.sql
```

Run it as the table owner (or `service_role`). It writes fixed
`00000000-0000-4000-8000-…` UUIDs, so it is idempotent (`on conflict do nothing`)
and removable with one targeted delete — see the header of the file.

**This is synthetic data.** It exists so a developer can see the Progress page and
the Challenge board on a fresh database. It is never a production fallback, and
the app never reads a seeded row as if it were measured.

## Client integration

### Device key header (recommended)

Remote reads are scoped to the device. Send the localStorage key on every request:

```ts
headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, 'x-device-key': getDeviceKey() }
```

With the header present:

- `GET /rest/v1/workout_sessions` returns only that device's sessions
  (`?select=*&order=started_at.desc`).
- A client can read back the row it just inserted, so
  `Prefer: return=representation` on session insert returns the new `id` — which
  `pushSessionRemote` needs in order to attach the per-rep batch.
- A client cannot read another device's history, and cannot claim another
  device's key on write.

**Known trade-off (deliberate, reviewed):** rows stored with `device_key IS NULL`
(a client that sent no header) are readable by other callers that also send no
header. Those rows are unattributable by construction and carry only counts,
scores, timestamps and a camera-view enum — no name, no device identifier, no
video, no landmarks. The alternative (denying that read) would break
`return=representation` for the header-less client that ships today. To close it
completely, drop the `device_key is null and public.current_device_key() is null`
disjunct in the `sessions_select_own_device` policy in `0003_rls.sql` and make the
header mandatory.

### Leaderboard

```sql
-- ranked, one call, ordering guaranteed identical to the client's rankEntries()
select * from public.leaderboard_top('challenge30', 100);
```

Or the equivalent REST call the client already makes:

```
GET /rest/v1/leaderboard_entries?select=*&mode=eq.challenge30
    &order=valid_reps.desc,form_score.desc,duration_seconds.asc&limit=100
```

Prefer the RPC for writes — it validates, rate-limits and returns the stored row:

```sql
select * from public.submit_leaderboard_entry(
  p_display_name := 'Priya', p_valid_reps := 22, p_invalid_reps := 3,
  p_form_score := 87.5, p_duration_seconds := 30, p_best_streak := 11
);
```

### Ordering (single source of truth)

```
valid_reps DESC, form_score DESC, duration_seconds ASC, created_at ASC
```

Implemented identically in `leaderboard_ranked`, `leaderboard_top()`, the
`idx_leaderboard_mode_rank_full` index, and `rankEntries()` in
`apps/web/lib/session-store.ts`. Change one, change all four.

## Security model

No login, no cookie, one public anon key shared by every client. The design
assumes a hostile client:

1. **Append-only.** Clients may `INSERT`; `UPDATE`/`DELETE` are denied by the
   absence of any policy *and* by explicit `REVOKE`. History cannot be rewritten.
2. **Reads scoped by device key** (see the trade-off above).
3. **Validation in the database.** Every score range, count relationship and
   time ordering is a `CHECK` constraint — including
   `valid_reps + invalid_reps = total_reps`, which makes "we quietly dropped the
   bad reps" structurally unrepresentable.
4. **The board is defended.** Names are sanitised server-side, submissions are
   rate-limited to 5/device/minute, and an entry that references a session cannot
   claim more valid reps than that session recorded.
5. **Scores are never clamped.** Implausible values are rejected outright —
   silently rewriting a score would be exactly the fake data this project forbids.

RLS is enabled but not `FORCE`d: the table owner must stay able to run
maintenance and `supabase db push`. `service_role` bypasses RLS by design and is
never exposed to the browser.

## Privacy

- No video, frames, images or raw landmarks — the schema has nowhere to put them.
- `workout_reps.min_elbow_angle_deg` and `body_line_deviation_max` are scalar
  aggregates computed in-browser; they exist so a judge can ask "why was that rep
  bad?" and get a number. They cannot reconstruct a body.
- `display_name` is the only user-supplied text and the only field that could
  plausibly identify a person. It is optional, sanitised, capped at 24 chars.
- `device_key` identifies a browser, not a person, and is never returned to
  another device.
- `form_probability` is stored next to `decision_threshold` and
  `model_version`, so changing the model later never retroactively rewrites a
  past verdict.
