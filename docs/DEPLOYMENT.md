# Deployment — AI Push-Up Coach

How to run, build, and ship this project. Every command below was executed
against the current checkout unless marked otherwise.

Verified environment facts at the time of writing:

| Fact | Status |
|---|---|
| `npm run test:py` | **34 passed, 0 failed, 0 skipped** |
| `npm run typecheck` | **0 errors** (5 packages + web app) |
| `npm --prefix apps/web run test` | **162 passed** across 9 files |
| `node scripts/acceptance.mjs` | **16 PASS / 0 FAIL / 0 SKIP** |
| `npm run build` (Next production build) | **succeeds** — 14/14 static pages |
| Python interpreter with the ML stack | `C:\Users\USER\anaconda3\envs\pushup\Scripts\python.exe` (Python 3.12.4) |
| `fastapi` / `uvicorn` / `pydantic` in that interpreter | **installed** — 44 API tests pass (see [API service](#6-api-service)) |
| MediaPipe WASM + pose landmarker | **present locally** — 19.3 MB + 9.4 MB under `apps/web/public/`; the app runs with the network unplugged |

---

## 1. Prerequisites

| Requirement | Version / detail |
|---|---|
| Node.js | `>=20.9.0` (from `engines` in the root `package.json`) |
| Python | 3.10+ with `numpy`, `scikit-learn`, `pytest` (the ML pipeline and tests need them) |
| Webcam | Required for live rep counting. A browser-only smoke test works without one. |
| Browser | Chrome or Edge recommended (MediaPipe WASM + `getUserMedia`) |
| Supabase | **Optional.** The app is fully functional without it. |
| FastAPI stack | **Optional.** Installed here, but in-browser inference is the primary path. See [API service](#6-api-service). |
| Network | **Not required after `npm run fetch:pose-assets`.** Everything the demo needs is served from the repo. See [Offline operation](#the-app-runs-with-no-network-at-all). |

### Camera access needs a secure context — the demo-booth trap

`getUserMedia` only works in a **secure context**. That means:

- `http://localhost` — **works** (localhost is always treated as secure).
- `http://127.0.0.1` — **works**.
- `https://<any-host>` — **works**.
- `http://192.168.x.x:3000` (a bare LAN IP) — **BLOCKED by the browser.**

This is the single most common way a booth demo dies. If you open the dev server
from a second machine or a phone by typing the laptop's LAN IP, the camera will
silently refuse to start and no amount of clicking "allow" will help.

What the app does when this happens: `apps/web/lib/camera.ts` classifies the
failure and the UI shows the `INSECURE_CONTEXT` error —

> **Camera requires a secure connection**
> Camera access only works over https:// or on localhost. Open the app at
> http://localhost:3000.

It is marked `recoverable: false`, because there is no in-page fix; the URL has
to change. Note the check is `navigator.mediaDevices` being absent, which is
exactly what an insecure context produces.

**Fixes for a booth setup:**

1. Run the demo **on the machine that serves it** and use `http://localhost:3000`.
2. Or put a TLS terminator in front (Vercel, ngrok, Caddy with a local cert) and
   use `https://`.
3. Or, for a temporary LAN test only, treat an origin as secure via
   `chrome://flags/#unsafely-treat-insecure-origin-as-secure` and add
   `http://192.168.x.x:3000`. Dev-only; never ship this.

The web app already sets `Permissions-Policy: camera=(self)` in
`apps/web/next.config.mjs`, so the camera is allowed for the same origin and
denied for embedded third parties.

---

## 2. Local development

From the repo root. Copy-pasteable as written.

```bash
# 1. Install web dependencies (this is where TypeScript lives too).
npm --prefix apps/web install

# 2. Start the Next dev server.
npm run dev
```

Open <http://localhost:3000>.

`npm run dev` is a thin wrapper for `next dev` run inside `apps/web`. There is
no root-level `npm install` step for the app itself; the web app is a
self-contained package under `apps/web`.

### Running the tests

```bash
# Python suite (drives the TypeScript parity runners too).
npm run test:py          # expected: 34 passed, 0 skipped

# Type-check the packages and the web app.
npm run typecheck

# Web unit tests (vitest).
npm --prefix apps/web run test

# Full acceptance suite (builds, typechecks, runs pytest, next build).
node scripts/acceptance.mjs
```

`npm run test:py` resolves a suitable interpreter via `scripts/python-env.mjs`,
builds the packages if their `dist/` output is missing, and then runs
`pytest tests -q` from the repo root. Current result: **34 passed, 0 skipped**.

The two `test_acceptance.py` tests inside that 34 shell out to
`scripts/acceptance.mjs`, so `npm run test:py` transitively verifies the whole
repo. The runner itself excludes `tests/test_acceptance.py` when it runs
pytest, which is what stops the two from recursing.

### Why `next dev` works without building the packages

`apps/web/tsconfig.json` maps the workspace package names straight at their
**source** via `paths`:

```jsonc
"@ai-pushup-coach/form-engine": ["../../packages/form-engine/src/index.ts"]
```

So the dev server compiles the package sources on the fly. `next dev` needs no
`dist/` output.

This is **not** true of the production build — see the next section.

---

## 3. Production build

```bash
# Builds the packages, then the Next app.
npm run build

# Serve the built app.
npm start
```

`npm run build` is defined as:

```
npm run build:packages && npm --prefix apps/web run build
```

It **does** pre-build the packages (`scripts/build-packages.mjs` runs
`tsc -b` over `packages/types`, `pose`, `biomechanics`, `rep-counter`,
`form-engine` in dependency order) before invoking `next build`.

### The dev-vs-build distinction that confuses people

| | Package `dist/` needed? | Why |
|---|---|---|
| `npm run dev` | **No** | tsconfig `paths` point at `src/*.ts`; the dev compiler reads sources directly. |
| `npm run build` | **Yes** | The build script builds them first. Running `next build` in `apps/web` on its own, without `build:packages`, can fail or resolve stale output. |

Practical rule: **always use `npm run build` from the repo root**, not
`next build` from inside `apps/web`. If you only touched the web app and want a
faster loop, run `npm run build:packages` once and then build the app — but the
root script does that for you.

`npm start` runs `next start` in `apps/web` and serves the production bundle
(default <http://localhost:3000>). It requires a completed `npm run build`.

Build output lands in `apps/web/.next/`. The model JSON in
`apps/web/public/models/` is copied into the static output as-is, so it ships
with the build.

---

## 4. Environment variables

The **only** environment variables the application reads are the two below.
This matches `.env.example` exactly — that file is the source of truth.

| Name | Required? | Purpose | Example |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Optional | Supabase project URL for the session mirror. Without a trailing slash. | `https://abcdefghijklmnop.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Optional (required only if the URL is set) | Supabase anon/public API key used as `apikey`/`Bearer` for REST calls. | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...` |

Both are read in `apps/web/lib/session-store.ts` (lines 266–267). Nothing else
in the codebase reads `process.env`.

Notes:

- **There is no API base-URL variable.** `apps/api` is not wired into the web
  app, and no code reads a base-URL env var.
- When **both** are set, finished sessions are additionally mirrored to
  Supabase. When **either** is missing, the mirror is disabled and the app falls
  back to `localStorage` only. The UI reports this as "local only" — it is not
  an error state.
- `NEXT_PUBLIC_*` values are embedded in the client bundle and are visible in
  devtools. That is fine for the anon key (see [Security & privacy](#9-security--privacy-notes)).
  **Never** put the `service_role` key here.

Where to put them:

```bash
# Next.js loads .env.local from the app directory, which is where the scripts run.
cp .env.example apps/web/.env.local      # POSIX
copy .env.example apps\web\.env.local    # Windows cmd
```

Do not commit `.env.local`.

`apps/api` uses its own, separate variables (`AIPC_*`, `SUPABASE_*`). Those are
not part of `.env.example`; see [API service](#api-service).

---

## 5. Database setup

Schema files, applied **in filename order**:

| File | Contents |
|---|---|
| `supabase/migrations/0001_init.sql` | `pgcrypto`, helper functions, enums, `users`, `workout_sessions`, `workout_reps`, constraints, indexes, `updated_at` triggers |
| `supabase/migrations/0002_leaderboard.sql` | `leaderboard_entries`, ranking views/functions, challenge indexes |
| `supabase/migrations/0003_rls.sql` | Row Level Security policies, name sanitiser, abuse controls, `SECURITY DEFINER` RPCs, grants |
| `supabase/seed.sql` | **DEV-ONLY** synthetic demo data. Guarded; refuses non-local servers. |

Order matters: `0002` references `workout_sessions` from `0001`, and `0003`
references both.

### Option A — Supabase CLI (recommended)

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

Local development:

```bash
supabase start
supabase db reset     # rebuilds the DB and applies every migration
```

### Option B — plain `psql`

```bash
psql "$DATABASE_URL" --set ON_ERROR_STOP=1 -f supabase/migrations/0001_init.sql
psql "$DATABASE_URL" --set ON_ERROR_STOP=1 -f supabase/migrations/0002_leaderboard.sql
psql "$DATABASE_URL" --set ON_ERROR_STOP=1 -f supabase/migrations/0003_rls.sql
```

`ON_ERROR_STOP=1` is not optional in practice — without it `psql` continues past
a failure and leaves you with a half-applied schema. Each file is wrapped in a
single transaction, so a failure rolls that file back.

On a plain PostgreSQL instance (not Supabase) create the managed roles first:

```sql
create role anon noinherit;
create role authenticated noinherit;
```

The ranking views use `security_invoker = on`, which needs PostgreSQL 15+.

### The schema is optional — this is architectural, not a fallback

**The app works fully offline.** Pose estimation, rep counting, form scoring and
session history all run in the browser. Session history is stored in
`localStorage`. Supabase is a **mirror** for cross-device aggregation
(leaderboard, progress), not a dependency.

The demo must not depend on the network. If the venue wifi dies, the workout
still works; only the leaderboard goes quiet. Verify this before the fest by
running with no `.env.local` at all — the app should report "local only" and
keep working.

### The app runs with no network at all

"Offline" here means the whole pipeline, not just the scoring step. The two
pieces that used to be CDN-hosted — the MediaPipe WASM runtime and the pose
landmarker — are now served from the app itself:

| Asset | Bytes | Served at | Role |
|---|---|---|---|
| `vision_wasm_internal.wasm` | 9,502,124 | `/mediapipe/wasm/` | SIMD build, used by default |
| `vision_wasm_nosimd_internal.wasm` | 9,376,240 | `/mediapipe/wasm/` | Fallback for CPUs without SIMD |
| `vision_wasm_internal.js` | 203,819 | `/mediapipe/wasm/` | JS glue for the SIMD build |
| `vision_wasm_nosimd_internal.js` | 203,672 | `/mediapipe/wasm/` | JS glue for the non-SIMD build |
| `pose_landmarker_full.task` | 9,398,198 | `/models/` | The pose model itself |

Populate them once per checkout:

```bash
npm run fetch:pose-assets
```

It copies the WASM out of `node_modules/@mediapipe/tasks-vision/wasm/` and
downloads the landmarker. It is idempotent — re-running prints
`WASM already present (4 files)` / `Pose model already present (9.4 MB)` and
exits without touching anything. `--force` re-fetches.

`POSE_ASSET_SOURCES` in `packages/pose/src/pose-engine.ts` is tried in order —
**local first**, CDN second — with GPU then CPU within each source. The engine
records which one won and exposes it via `getAssetSource()`. If the fetch step
was skipped on a fresh clone, the CDN entry keeps the app working; it just
needs network again.

To verify offline operation for real, before the fest:

1. Run `npm run fetch:pose-assets`, then `npm run build && npm start`.
2. Open `/workout` with the network on, confirm the skeleton overlay animates.
3. **Disconnect the network**, hard-reload with the cache disabled (DevTools →
   Network → *Disable cache*, then reload).
4. Confirm the skeleton still animates and reps still count.

Step 3 is the one that matters. A warm browser cache makes any CDN-hosted app
look offline-capable; disabling the cache is what proves the assets are local.

When the database is unconfigured, the API's session/leaderboard endpoints
answer `503 {"detail": "database not configured"}`. They never return an empty
`200`, so a client can always distinguish "no data" from "no database".

---

## 6. API service

`apps/api` is a FastAPI service. It scores one **completed** rep from an
aggregated feature vector, and optionally persists sessions and leaderboard
rows.

### Dependency status

`fastapi`, `uvicorn`, `pydantic` and `pydantic-settings` are installed in the
existing interpreter. Verified:

```
$ "C:/Users/USER/anaconda3/envs/pushup/Scripts/python.exe" -c \
    "import fastapi, uvicorn, pydantic; print(fastapi.__version__, uvicorn.__version__, pydantic.VERSION)"
0.141.1 0.53.0 2.13.5

$ "C:/Users/USER/anaconda3/envs/pushup/Scripts/python.exe" -m pytest apps/api/tests -q
44 passed, 2 warnings in 6.71s
```

They were installed **into the existing environment** — no virtualenv was
created and nothing was installed system-wide, per the project constraint. The
scoring core is still stdlib-only by design, so the API's model-parity test in
`apps/api/tests/test_model_service.py` runs with no third-party dependencies at
all; FastAPI is needed only to exercise the HTTP layer.

Note the pinning consequence: `fastapi 0.141.1` is a recent major line, and its
router internals differ from older releases. `apps/api/tests/test_routes.py`
therefore enumerates routes through `app.openapi()["paths"]` rather than
reaching for `app.routes[i].path`, which is not a stable public attribute.

### Installing the API dependencies (optional)

The user has explicitly forbidden creating new Python environments, so **install
into the existing interpreter**, do not make a venv:

```bash
"C:/Users/USER/anaconda3/envs/pushup/Scripts/python.exe" -m pip install -r apps/api/requirements.txt
```

### Running it (once dependencies are present)

```bash
cd apps/api
"C:/Users/USER/anaconda3/envs/pushup/Scripts/python.exe" -m uvicorn app.main:app --reload --port 8000
```

- Base URL: <http://localhost:8000>
- Docs UI: <http://localhost:8000/docs>
- Health: <http://localhost:8000/health>

```bash
# API tests
cd "C:/Users/USER/Downloads/Dataset Exercise Quality-wise/Dataset Exercise Quality-wise/ai-pushup-coach"
"C:/Users/USER/anaconda3/envs/pushup/Scripts/python.exe" -m pytest apps/api/tests -q
```

### Role: fallback and batch tool, not the primary path

**In-browser inference is the PRIMARY path.** `packages/form-engine` scores the
rep in the page. The API is a fallback plus a batch-evaluation tool.

Why:

- **Privacy.** Camera frames never leave the device. There is no frame path to
  the server to leak.
- **No network latency in the rep loop.** The live loop cannot wait on a
  round-trip; the verdict has to land within the rep.
- **The demo cannot break on bad venue wifi.** A backend outage cannot interrupt
  a workout — the API is only reached if the JS model could not load or for
  batch scoring.

`/health` is polled once on load. A failed or degraded API does not disable the
app; the client falls back to in-browser scoring. The model is loaded once in
the FastAPI lifespan; a load failure yields `status: "degraded"` and
`model_loaded: false` rather than a crash.

API configuration (all optional, `apps/api/.env`, `AIPC_`-prefixed):
`AIPC_CORS_ORIGINS` (default `["http://localhost:3000"]`),
`AIPC_MODEL_JSON_PATH`, `AIPC_MODEL_METADATA_PATH`, `AIPC_PARITY_FIXTURE_PATH`,
`AIPC_MAX_MISSING_FEATURES` (default `3`), and `SUPABASE_URL` / `SUPABASE_KEY`.

---

## 7. Model artifacts

The browser loads the model at runtime, so the artifacts must ship with the app.

| Source (repo) | Deployed to (served) | Role |
|---|---|---|
| `ml/models/pushup_form_model.json` | `apps/web/public/models/pushup_form_model.json` | Dependency-free GBM runtime — trees, thresholds, sigmoid settings. Scored in the browser. |
| `ml/models/pushup_form_model.metadata.json` | `apps/web/public/models/pushup_form_model.metadata.json` | Model facts (type, feature names, `n_features: 34`, `decision_threshold: 0.58`, test metrics). Rendered on the About page. |
| `ml/models/parity_fixture.json` | `apps/web/public/models/parity_fixture.json` | 200 vectors with expected scores. Used by parity tests and the API startup self-check. |

All three currently exist in both locations. Anything served from
`apps/web/public/` is copied verbatim into the Next build output — no bundler
transformation, no import needed.

### The export script enforces a parity gate

`ml/scripts/export_model.py` re-scores the parity fixture through the exported
JSON runtime and compares it against sklearn. If `max_diff > 1e-6` it **refuses
to write the artifacts**. A model the browser would mis-score never ships.

The script writes both to `ml/models/` and copies to
`apps/web/public/models/` (`WEB_PUBLIC_MODELS`), so the two locations stay in
sync. Regenerate with:

```bash
npm run ml:pipeline        # fast stages only
npm run ml:pipeline -- --full   # includes the heavy feature-extraction stage
```

**The ML pipeline is an OFFLINE step.** It must never run at request time or as
part of a deploy that serves traffic — `extract_pose_features.py` decodes
videos through MediaPipe and is far too heavy for a request path. Run it on a
build machine, commit or upload the resulting JSON, then deploy the app.

---

## 8. Deployment targets

### Target A — static / Node host (Vercel) for the Next app

Vercel is the natural fit: `next build` + `next start` is exactly what it runs,
and the app is a single deployable Next project rooted at `apps/web`.

Guidance:

- **Root directory:** `apps/web`. Vercel must treat that as the project root;
  the repo root is a workspace shell, not a Next app.
- **Install command:** `npm --prefix apps/web install` (or let Vercel install
  from `apps/web`).
- **Build command:** `npm run build` — but note the root `build` also runs
  `build:packages`. On Vercel, either set the root directory to the repo root
  and use `npm run build`, or ensure the package `dist/` output is produced
  before `next build`. The safe choice is the repo root with `npm run build`.
- **Output:** `.next` (standard Next.js; Vercel detects it).
- **Env vars:** set `NEXT_PUBLIC_SUPABASE_URL` and
  `NEXT_PUBLIC_SUPABASE_ANON_KEY` in the project settings if you want the
  mirror; leave them unset for a fully local-only deployment.
- **Camera:** Vercel serves over HTTPS, so the secure-context requirement is
  satisfied. The `Permissions-Policy` header from `next.config.mjs` applies.

Any Node host that can run `next build` and `next start` (or a container running
`npm run build && npm start`) works the same way. For a purely static export
you would need to confirm the app has no server-only routes — as shipped it is
built as a standard Next app, so `next start` is the supported serve mode.

### Target B — container / VM for the API (optional)

The API is a normal ASGI app and can run anywhere Python runs.

```dockerfile
# Illustrative only — no Dockerfile is shipped in this repo.
FROM python:3.12-slim
WORKDIR /srv
COPY apps/api/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY ml/ ./ml/
COPY apps/api/ ./apps/api/
WORKDIR /srv/apps/api
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

Notes:

- The API resolves model paths relative to the repo layout
  (`apps/api/app/paths.py` walks up to the repo root and into `ml/models/`), so
  the `ml/models/*.json` files must be present at that relative location inside
  the image or VM.
- Bind `0.0.0.0` inside a container, not `127.0.0.1`.
- Set `AIPC_CORS_ORIGINS` to the deployed web origin, as a JSON array:
  `AIPC_CORS_ORIGINS='["https://your-app.vercel.app"]'`.
- A small VM (`systemd` unit or `supervisor`) is equally valid:
  `uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 2`.
- **Do not** run `npm run ml:pipeline` in the container's startup path. Ship the
  artifacts; run the pipeline offline.

Reminder: the API is optional. A deployment with only Target A is complete and
functional.

---

## 9. Health checks & verification

Run these to confirm a deployment (or a fresh checkout) is healthy:

| Check | Command | Expected |
|---|---|---|
| Acceptance suite | `node scripts/acceptance.mjs` | `16 PASS / 0 FAIL / 0 SKIP`, exit 0 |
| Python + parity suite | `npm run test:py` | `34 passed, 0 skipped` |
| Types (packages + web) | `npm run typecheck` | `Typecheck passed with no errors.` |
| Next production build | `npm run build` | build completes, `.next/` produced |
| Web unit tests | `npm --prefix apps/web run test` | 162 passed across 9 files |
| Offline assets | `npm run fetch:pose-assets` | 4 WASM files + the 9.4 MB landmarker present |
| API tests | `python -m pytest apps/api/tests -q` | `44 passed` |
| API health (if deployed) | `curl http://localhost:8000/health` | `status: "ok"` (or `"degraded"`), `model_loaded`, `parity_ok` |
| App smoke test | open <http://localhost:3000>, allow camera | pose overlay appears, reps count |

`/health` reports `parity_ok` and `parity_max_abs_diff`. A parity failure
downgrades `status` to `"degraded"` — the Python scorer disagreeing with the
TypeScript runtime is a real incident, not a warning to ignore.

`npm run typecheck` runs two steps: `tsc -b` over the five packages, then
`tsc --noEmit -p tsconfig.json` inside `apps/web`. Both must be clean.

---

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `'tsc' is not recognized` / `tsc: command not found` | TypeScript is installed under `apps/web/node_modules`, not at the repo root, so a bare `tsc` is not on `PATH`. | Use `npm run typecheck`. To invoke it directly: `node apps/web/node_modules/typescript/bin/tsc --noEmit -p apps/web/tsconfig.json`. Installing TypeScript at the root is not supported here. |
| Parity tests report **skipped** instead of failing | `tests/test_feature_parity.py` and `tests/test_model_parity.py` self-skip when the compiled packages (`packages/*/dist/index.js`) are absent. **A skip looks like a pass and hides regressions.** | Run `npm run build:packages`, then re-run. `npm run test:py` does this automatically and fails loudly if the build fails. If you see "skipped" in CI output, your build step is missing. |
| Camera error: **Camera permission denied** | The user or browser blocked `getUserMedia`. | Click the camera icon in the address bar, allow access, reload. The app marks this `recoverable: true`. |
| Camera error: **Camera requires a secure connection** (`INSECURE_CONTEXT`) | The page is not in a secure context — typically opened via a bare LAN IP over `http://`. `navigator.mediaDevices` is undefined. | Use `http://localhost` on the serving machine, or serve over HTTPS. See [Prerequisites](#camera-access-needs-a-secure-context--the-demo-booth-trap). Not fixable in-page. |
| Camera error: **Camera is in use** | Another app (Zoom, Teams, another tab) holds the camera. | Close the other app/tab and retry. |
| Pose model fails to load; rep counting disabled (`MODEL_UNAVAILABLE`) | The form classifier JSON, the MediaPipe WASM, or the pose landmarker is missing or unreachable. All three are served locally, so this normally means the asset fetch step was skipped or the build dropped `public/`. | Confirm the files exist: `apps/web/public/models/pushup_form_model.json`, `apps/web/public/models/pose_landmarker_full.task`, `apps/web/public/mediapipe/wasm/*`. Run `npm run fetch:pose-assets` for the two MediaPipe assets and `npm run ml:pipeline` for the classifier. `node scripts/acceptance.mjs` checks all of them and names the missing one. |
| The skeleton overlay animates but reps never count and metrics stay `--` | The `onPoseFrame` prop is not wired to the session. This was a real shipped bug (see `docs/BUILD_STATUS.md` §2.1) and it has **no visible symptom** other than the counter not moving. | Guarded by `apps/web/lib/__tests__/pose-wiring.test.ts`, which asserts the wiring structurally because rendering the page needs a real webcam. Run `npm --prefix apps/web run test`. |
| Python deps missing: `ModuleNotFoundError: No module named 'numpy'/'sklearn'/'pytest'` | The interpreter on `PATH` is not the one with the ML stack. | Use the known-good interpreter, or let the scripts find it: `npm run test:py` probes candidates via `scripts/python-env.mjs`. If nothing matches, `pip install numpy scikit-learn pytest` into your active environment. |
| `ModuleNotFoundError: No module named 'fastapi'` when starting the API | FastAPI is not installed in the interpreter you invoked. It **is** installed in `C:\Users\USER\anaconda3\envs\pushup`, so this usually means a different Python is first on `PATH`. | Use the absolute interpreter path from [Quick reference](#12-quick-reference), or install with `python -m pip install -r apps/api/requirements.txt` into the **existing** environment. Do not create a new venv. The app does not need the API at all — in-browser inference is the primary path. |
| `EADDRINUSE` / port already in use | Another process holds `:3000` (web) or `:8000` (API). | Next: `npm run dev -- --port 3001` (or `npm --prefix apps/web run dev -- --port 3001`). API: `uvicorn app.main:app --port 8001`. Find the holder: `netstat -ano | findstr :3000` (Windows) or `lsof -i :3000` (POSIX). |
| `npm run build` fails after editing only the web app | `next build` was run directly in `apps/web` without the package `dist/` output. | Run `npm run build` from the repo root — it runs `build:packages` first. |
| Acceptance reports **`Next.js production build` → SKIP** with "the host's safe-delete shim (injected via `NODE_OPTIONS`) blocked Next's `.next` file operations" | A sandboxed or shimmed shell blocks the `rm`-style cleanup Next performs on `.next/` before compiling. It is **not** a compile error, and it is **not** a code problem. | Re-run `node scripts/acceptance.mjs` in a normal shell. The check self-reports the reason rather than silently passing, which is why it is worth reading the skip detail instead of just the total. A full run is `16 PASS / 0 FAIL / 0 SKIP`. |
| `npm run dev` fails to resolve `@ai-pushup-coach/*` | tsconfig `paths` point at package `src/`; the packages must exist and be type-correct. | Run `npm --prefix apps/web install`, then `npm run typecheck` to surface the real error. |

---

## 11. Security & privacy notes

- **No video is uploaded.** Camera frames never leave the device. There is no
  code path that sends a frame, an image, or raw pose landmarks anywhere.
- **No video or landmarks are stored.** The Supabase schema has nowhere to put
  them — only counts, scores, timestamps and scalar geometry aggregates. See
  `supabase/README.md`.
- **Pose estimation runs client-side.** MediaPipe runs in the browser via
  `@mediapipe/tasks-vision`, with the WASM runtime and the pose landmarker
  served from the app's own `/public` directory (CDN only as a fallback). The
  frames are processed locally, and the assets being local is also a privacy
  property: a page that pulls its model from a third-party CDN leaks the fact
  and timing of every session to that CDN.
- **The Supabase anon key is public by design.** It is embedded in the client
  bundle and visible in devtools. Safety comes from **Row Level Security**, not
  from hiding the key: clients may `INSERT` but not `UPDATE`/`DELETE` (denied by
  both policy absence and explicit `REVOKE`), reads are scoped to the caller's
  device key, and every score range and count relationship is a database `CHECK`
  constraint.
- **Never expose the `service_role` key.** It bypasses RLS. It must not appear
  in any `NEXT_PUBLIC_*` variable or client bundle. Use it only for trusted
  server-side maintenance.
- **Scores are never clamped.** Implausible values are rejected outright rather
  than silently rewritten — the project forbids fake data.
- **The API mirrors this posture.** `apps/api` returns metadata verbatim, reports
  imputed features instead of hiding them, and returns `confidence: null` when
  the label is `unknown` rather than attributing a class probability it cannot
  honestly support.

---

## 12. Quick reference

```bash
# Install
npm --prefix apps/web install

# One-time: fetch the MediaPipe WASM + pose landmarker (28 MB) so the app runs offline
npm run fetch:pose-assets
npm run fetch:pose-assets -- --force    # re-download even if present

# Develop
npm run dev                      # http://localhost:3000

# Verify
npm run typecheck                # 0 errors
npm run test:py                  # 34 passed, 0 skipped
npm --prefix apps/web run test   # 162 passed
node scripts/acceptance.mjs      # 16 PASS / 0 FAIL / 0 SKIP

# Build & serve
npm run build
npm start

# Regenerate model artifacts (offline)
npm run ml:pipeline              # fast
npm run ml:pipeline -- --full    # includes heavy feature extraction

# API
cd apps/api && "C:/Users/USER/anaconda3/envs/pushup/Scripts/python.exe" -m uvicorn app.main:app --reload --port 8000
"C:/Users/USER/anaconda3/envs/pushup/Scripts/python.exe" -m pytest apps/api/tests -q   # 44 passed

# Database (optional)
supabase link --project-ref <ref> && supabase db push
```
