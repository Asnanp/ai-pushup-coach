# API_CONTRACT.md

Base URL: `http://localhost:8000` (dev) — versioned under `/api/v1`.

## `GET /health`

Liveness + model readiness. The frontend polls this once on load to decide whether the
server inference path is available.

```json
{
  "status": "ok",
  "model_loaded": true,
  "feature_spec_version": 1,
  "n_features": 37,
  "model_type": "RandomForestClassifier",
  "decision_threshold": 0.47,
  "version": "1.0.0"
}
```

`status` is `"degraded"` when the service is up but the model failed to load. The client
treats `model_loaded: false` as "use in-browser model only".

## `POST /api/v1/form/predict`

Score a **completed rep** from its aggregated feature vector.

### Request

```json
{
  "features": {
    "elbow_angle_deg_mean": 112.4,
    "elbow_angle_deg_min": 84.1,
    "body_line_deviation_mean": 0.062,
    "...": "all 37 keys from FEATURE_SCHEMA.md §8"
  },
  "meta": {
    "view_type": "side",
    "feature_spec_version": 1
  }
}
```

`features` may also be sent as an ordered array; the server validates length against
`n_features`.

### Response

```json
{
  "label": "good",
  "confidence": 0.94,
  "scores": { "good": 0.94, "bad": 0.06 },
  "threshold_used": 0.47,
  "feature_spec_version": 1,
  "missing_features": [],
  "model_type": "RandomForestClassifier"
}
```

`label` is `"unknown"` when more than 3 features required imputation. `confidence` is
always the probability of the returned `label`, never of a fixed class — client code
must not assume `confidence` means P(good).

### Errors

| Status | Body | Meaning |
|---|---|---|
| `422` | `{"detail": [{"loc": [...], "msg": "..."}]}` | schema violation |
| `400` | `{"detail": "feature_spec_version mismatch: got 0, expected 1"}` | stale client |
| `503` | `{"detail": "model not loaded"}` | model failed to initialise |

Note: a `400` version mismatch is a **hard failure by design**. Scoring with a mismatched
feature vector would produce a plausible-looking but meaningless number, which is worse
than an error.

## `POST /api/v1/form/predict/batch`

```json
{ "items": [ { "features": {...} }, { "features": {...} } ] }
```

Returns `{ "results": [ <predict response>, ... ] }`. Used for offline evaluation and
backfilling, not in the live loop.

## `GET /api/v1/model/info`

Returns the full `metadata.json` including train/val/test metrics, so the About page can
show genuinely measured numbers rather than hardcoded copy.

## Runtime Note

The **browser is the primary inference path**, not this API. The API exists for:
- batch evaluation,
- retraining verification,
- environments where the JS model cannot load.

Because the live loop never depends on it, a backend outage cannot interrupt a workout.
