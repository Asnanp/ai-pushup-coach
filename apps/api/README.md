# AI Push-Up Coach — API (`apps/api`)

FastAPI backend for the AI Push-Up Coach. It scores a **completed push-up rep**
from its aggregated feature vector and, optionally, persists sessions and
leaderboard rows.

> **The browser is the primary inference path** (`packages/form-engine`), not
> this service. Camera frames never leave the device, and the live rep loop has
> zero network latency. This API exists for batch evaluation, retraining
> verification, and environments where the JS model cannot load — so a backend
> outage cannot interrupt a workout.

---

## 1. Running it

Use the project interpreter. **Do not create a new virtualenv or conda env.**

```bash
# 1. install dependencies into the EXISTING `pushup` env (one time)
"C:/Users/USER/anaconda3/envs/pushup/Scripts/python.exe" -m pip install -r apps/api/requirements.txt

# 2. start the server
cd apps/api
"C:/Users/USER/anaconda3/envs/pushup/Scripts/python.exe" -m uvicorn app.main:app --reload --port 8000
```

Docs UI: <http://localhost:8000/docs> · Health: <http://localhost:8000/health>

Supabase is **optional** — see §6. With no database configured the server still
boots and serves `/health`, `/api/v1/model/*` and `/api/v1/form/predict`;
sessions and leaderboard answer `503 database not configured`.

### Tests

```bash
cd "C:/Users/USER/Downloads/Dataset Exercise Quality-wise/Dataset Exercise Quality-wise/ai-pushup-coach"
"C:/Users/USER/anaconda3/envs/pushup/Scripts/python.exe" -m pytest apps/api/tests -q
```

No environment variables and no network access are required. The integration
tests drive the real app through `fastapi.testclient.TestClient`, which runs the
genuine lifespan (model load + parity self-check) without opening a port. **All
44 tests pass with zero skips.**

## 2. Dependency status

Installed into the existing `pushup` conda env with:

```bash
"C:/Users/USER/anaconda3/envs/pushup/Scripts/python.exe" -m pip install fastapi "uvicorn[standard]" pydantic-settings httpx python-dotenv
```

Result — the app now imports and boots:

| Package | Version |
|---|---|
| fastapi | 0.141.1 |
| starlette | 1.6.0 |
| pydantic | 2.13.5 |
| pydantic-settings | 2.15.0 |
| uvicorn | 0.53.0 |
| httpx | 0.28.1 |

`numpy`, `scipy` and `scikit-learn` were deliberately **not** touched: a
previous numpy upgrade in a shared environment broke scipy and sklearn. The
service does not import any of them at runtime — the GBM is scored by direct
tree traversal (`app/services/model_service.py`), so the scoring path stays
stdlib-only.

> **Version note.** FastAPI ≥0.14x / Starlette ≥1.x stores the result of
> `include_router` as an opaque `_IncludedRouter` with no `.path`, so
> `{route.path for route in app.routes}` no longer lists the contract routes.
> Enumerate `app.openapi()["paths"]` instead — that is what the test suite does.


## 3. Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness + model readiness (polled once on load) |
| `POST` | `/api/v1/form/predict` | Score one completed rep |
| `POST` | `/api/v1/form/predict/batch` | Score many reps (offline evaluation / backfill) |
| `GET` | `/api/v1/model/info` | Full `metadata.json`, verbatim |
| `POST` | `/api/v1/sessions` | Persist a finished session + its per-rep rows |
| `GET` | `/api/v1/sessions` | List this device's sessions |
| `GET` | `/api/v1/sessions/{id}` | One session with its reps |
| `DELETE` | `/api/v1/sessions/{id}` | Delete a session (reps cascade) |
| `GET` | `/api/v1/leaderboard` | Ranked top N for one mode (public) |
| `POST` | `/api/v1/leaderboard` | Submit a score |

Shapes follow `docs/API_CONTRACT.md`; column names follow
`docs/DATABASE_SCHEMA.md`. Where those documents disagree with the shipped
artifact, the artifact wins and the deviation is documented below.

### `POST /api/v1/form/predict`

```jsonc
// request — `features` may be a 37-key object, or an array of 37 (contract
// order) or 34 (model order) values
{
  "features": { "elbow_angle_deg_mean": 112.4, "...": "..." },
  "meta": { "view_type": "side", "feature_spec_version": 1 }
}

// response
{
  "label": "good",
  "confidence": 0.94,
  "scores": { "good": 0.94, "bad": 0.06 },
  "threshold_used": 0.58,
  "feature_spec_version": 1,
  "missing_features": [],
  "model_type": "GradientBoostingClassifier"
}
```

Errors: `422` schema/vector violation · `400` `feature_spec_version` mismatch
(hard failure by design — a mismatched vector would yield a plausible-looking
but meaningless number) · `503` model not loaded.

## 4. What the model actually is

Verified against `ml/models/pushup_form_model.metadata.json`:

| Fact | Value |
|---|---|
| Kind | `gbm` (sklearn `GradientBoostingClassifier`, 150 trees, lr 0.05) |
| `initRaw` | `-0.5469469321799849` |
| Features consumed | **34** (`n_features`), contract is **37** |
| `positive_class` | `0`, meaning `"P(good form)"` |
| `decision_threshold` | `0.58` |
| Test accuracy / macro-F1 / bad-form recall | 0.688 / 0.672 / 0.585 |

`excluded_capture_features` (`jitter_max`, `jitter_mean`, `jitter_std`,
`low_confidence_ratio`, `mean_visibility`, `min_visibility`,
`tracking_gap_ratio`) are deliberately withheld: they leaked capture conditions
as a subject-identity proxy and halved bad-form recall. A full 37-key payload is
therefore expected, and those 7 keys are ignored — they never reach the model.

### The class-inversion gotcha

`pushup_form_model.json` declares `sigmoidIsClass: 1`, while the metadata
declares `positive_class: 0` (`P(good)`). The raw sigmoid returns **P(class 1)
= P(bad)**; it must be complemented. `ModelService._score_gbm` mirrors
`packages/form-engine/src/model-runtime.ts::scoreGbm` line for line, composing
both possible flips (which class the sigmoid refers to, and whether the
configured positive class is "good") instead of assuming they cancel.

**Parity is asserted, not assumed.** `verify_parity()` re-scores all 200 cases
in `ml/models/parity_fixture.json` (whose expected values come from the
TypeScript runtime). Measured max abs difference: **1.1e-16** (tolerance 1e-6).
If the inversion were dropped, the difference would be ~0.96. The same check
runs at startup and is surfaced on `/health` as `parity_ok` /
`parity_max_abs_diff`; a failure downgrades `status` to `"degraded"`.

## 5. No fake data

- Nothing in this service invents a metric. `/api/v1/model/info` returns the
  metadata file byte-for-byte; the About page reads real numbers from it.
- `PredictResponse.confidence` is the probability of the **returned label**,
  never of a fixed class. When the label is `"unknown"` (more than 3 features
  required imputation) no class probability can be honestly attributed to it, so
  `confidence` is `null` and the client renders `--`. The real `scores.good` /
  `scores.bad` are always present.
- Missing or non-finite features are imputed with `train_feature_means` and
  reported in `missing_features` — never silently substituted.
- `form_score` and `mean_rep_seconds` are nullable in the schema and in the API
  responses: fewer than 3 reps legitimately has no score.
- No LLM is involved in deciding form correctness. Ever.

### Deviations from the documents (deliberate, documented)

1. **`/health.n_features` is 34, not 37.** The contract example predates the
   capture-leak exclusion. `n_features` reports what the model consumes;
   `n_features_contract` reports 37. Both are returned.
2. **`confidence` is nullable** (see above).
3. **Sessions are append-only** — there is no `PATCH`/`PUT`. A session row is
   written complete (`ended_at`, counts and score are all known at the end) and
   no field is meaningfully mutable, so an update endpoint would only create a
   way to desynchronise counts from per-rep rows.
4. **`POST /api/v1/leaderboard` inserts directly.** `docs/DATABASE_SCHEMA.md` §4
   describes a `SECURITY DEFINER` submit function, but
   `supabase/migrations/0002_leaderboard.sql` only defines `leaderboard_top`.
   Until that function exists, the insert is direct and validated server-side
   (display name sanitised in the request schema before it reaches the database).

## 6. Configuration

All optional. Copy to `apps/api/.env` and set as needed.

| Variable | Default | Notes |
|---|---|---|
| `AIPC_CORS_ORIGINS` | `["http://localhost:3000"]` | JSON array; the Next dev server |
| `AIPC_MODEL_JSON_PATH` | `<repo>/ml/models/pushup_form_model.json` | |
| `AIPC_MODEL_METADATA_PATH` | `<repo>/ml/models/pushup_form_model.metadata.json` | |
| `AIPC_PARITY_FIXTURE_PATH` | `<repo>/ml/models/parity_fixture.json` | Startup self-check |
| `AIPC_MAX_MISSING_FEATURES` | `3` | Above this the label becomes `unknown` |
| `SUPABASE_URL` / `AIPC_SUPABASE_URL` | unset | |
| `SUPABASE_KEY` / `SUPABASE_SERVICE_KEY` / `SUPABASE_ANON_KEY` | unset | |

### Database-optional behaviour

The app is fully functional with no database configured
(`docs/DATABASE_SCHEMA.md` §6): sessions go to `localStorage` and the Progress
page reads from there.

When Supabase is unset, the session and leaderboard endpoints answer
`503 {"detail": "database not configured"}`. They never return an empty `200` —
the client must be able to distinguish "no data" from "no database".

Three distinct storage outcomes, all typed (never a 500 stack trace):

| Condition | Status | Body |
|---|---|---|
| Supabase unset | `503` | `{"detail": "database not configured"}` |
| Supabase configured but unreachable (DNS/refused/timeout/TLS) | `502` | `{"detail": "database unreachable: <ExceptionType>"}` |
| Supabase reachable, request rejected | `502` | `{"detail": "database error (<status>): <body>"}` |

The unreachable case is worth calling out: the transport raises
`httpx.HTTPError`, which is *not* the `SupabaseError` raised for a non-2xx
response that actually arrived. Without an explicit clause it escaped as an
untyped 500 — the exact failure mode this module exists to prevent.

Identity is the `x-device-key` header (the browser's `localStorage` key),
matching `public.current_device_key()` in the migrations. It is required for
session reads/writes and for leaderboard writes; leaderboard **reads are
public** (it is a scoreboard). Because a service key bypasses RLS, device-scoped
queries also filter explicitly, so scoping holds either way.

## 7. Layout

```
apps/api/
  requirements.txt
  app/
    paths.py                  # filesystem layout (stdlib only)
    config.py                 # pydantic-settings
    schemas.py                # pydantic v2 request/response models
    main.py                   # app factory, CORS, lifespan (loads model once)
    routers/
      deps.py                 # device-key dependency, DB error mapping
      health.py               # /health, /api/v1/model/info
      predict.py              # /api/v1/form/predict[/batch]
      sessions.py             # /api/v1/sessions
      leaderboard.py          # /api/v1/leaderboard
    services/
      model_service.py        # GBM traversal + sigmoid + class inversion (stdlib)
      features.py             # wrapper over the reference ml/src/features.py
      supabase_client.py      # minimal PostgREST client (httpx)
  tests/
    conftest.py
    test_model_service.py     # parity gate + guardrails (stdlib-only core)
    test_api_integration.py   # TestClient: every endpoint, real model, degradation
```

`app/services/features.py` puts `ml/src` on `sys.path` and re-exports the
reference extractor rather than copying it, so the 37-feature contract has
exactly one implementation. It is not used by the live scoring path — `/predict`
receives an already-aggregated vector.
