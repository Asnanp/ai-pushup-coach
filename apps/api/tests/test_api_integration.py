"""End-to-end tests for the FastAPI app.

These drive the real application through ``fastapi.testclient.TestClient``,
which runs the genuine lifespan (model load + parity self-check) and the real
routing/validation stack. No port is opened and no network call is made.

Coverage:

* ``/health`` against the shipped artifact — ``kind`` is ``gbm``, the model
  consumes 34 features, the contract has 37, spec version 1, parity OK.
* ``/api/v1/form/predict`` on real vectors from ``ml/models/parity_fixture.json``,
  asserted against the fixture's ``expectedGoodProbability`` within 1e-6 — the
  same tolerance the TypeScript-runtime parity gate uses.
* ``/api/v1/model/info`` returning the metadata file verbatim.
* Graceful degradation: every database-backed route answers a typed
  ``503 {"detail": "database not configured"}`` when Supabase is unset, while
  ``/health`` and ``/predict`` keep working. A configured-but-unreachable
  database is a ``502``, never an untyped 500.
* The database-backed routes' status codes and column mapping, exercised
  against an in-memory double so 201/204/404 are actually verified. The double
  only ever echoes rows the router itself wrote — no value is invented.
"""

from __future__ import annotations

import json
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Mapping, Sequence

import pytest

pytest.importorskip("fastapi", reason="fastapi is not installed in this env")

from fastapi.testclient import TestClient  # noqa: E402

from app.config import get_settings  # noqa: E402
from app.main import create_app  # noqa: E402
from app.paths import DEFAULT_PARITY_FIXTURE_PATH  # noqa: E402
from app.routers.deps import get_db  # noqa: E402
from app.services.model_service import ModelService, ModelServiceConfig  # noqa: E402
from app.services.supabase_client import close_supabase_client  # noqa: E402

DEVICE_KEY = "test-device-key-0001"
PARITY_TOLERANCE = 1e-6
FIXTURE_PATH = Path(DEFAULT_PARITY_FIXTURE_PATH)

# Any of these being present in the ambient environment would silently point the
# "database not configured" tests at a real database.
_SUPABASE_ENV_VARS = (
    "SUPABASE_URL",
    "SUPABASE_KEY",
    "SUPABASE_SERVICE_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_ANON_KEY",
    "AIPC_SUPABASE_URL",
    "AIPC_SUPABASE_KEY",
    "AIPC_SUPABASE_SERVICE_KEY",
)


# ---------------------------------------------------------------------------
# Fixtures and helpers
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _isolated_settings(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Force a deterministic, database-free configuration for every test.

    ``get_settings`` is an ``lru_cache`` and the Supabase client is a module
    singleton, so both must be reset around any environment change.
    """
    for name in _SUPABASE_ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    get_settings.cache_clear()
    close_supabase_client()
    yield
    get_settings.cache_clear()
    close_supabase_client()


@contextmanager
def running_app(db: Any | None = None) -> Iterator[TestClient]:
    """A live app instance. ``with`` is required: it triggers the lifespan.

    ``db`` replaces the PostgREST dependency when supplied. Note it is a
    positional parameter, not a ``**kwargs`` entry: keyword-argument names are
    always strings, so ``app.dependency_overrides["get_db"]`` would never match
    the function object FastAPI looks up, and the override would silently do
    nothing.
    """
    app = create_app()
    if db is not None:
        app.dependency_overrides[get_db] = lambda: db
    with TestClient(app, raise_server_exceptions=False) as client:
        yield client


@pytest.fixture(scope="module")
def parity_cases() -> list[dict[str, Any]]:
    if not FIXTURE_PATH.is_file():
        pytest.skip(f"parity fixture not found: {FIXTURE_PATH}")
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))["cases"]


@pytest.fixture(scope="module")
def loaded_service() -> ModelService:
    service = ModelService(ModelServiceConfig())
    service.load()
    return service


def session_payload(**overrides: Any) -> dict[str, Any]:
    """A structurally valid `workout_sessions` write."""
    payload: dict[str, Any] = {
        "started_at": "2026-01-01T10:00:00Z",
        "ended_at": "2026-01-01T10:01:30Z",
        "duration_seconds": 90,
        "total_reps": 12,
        "valid_reps": 10,
        "invalid_reps": 2,
        "form_score": 82.5,
        "view_type": "side",
        "mode": "workout",
        "best_streak": 6,
        "mean_rep_seconds": 7.5,
        "most_common_issue": "INCOMPLETE_DEPTH",
        "reps": [
            {
                "rep_number": 1,
                "valid": True,
                "form_label": "good",
                "form_probability": 0.91,
                "depth_score": 88.0,
                "detected_issue": None,
                "rep_duration_seconds": 7.1,
                "min_elbow_angle_deg": 74.5,
                "body_line_deviation_max": 0.031,
            },
            {
                "rep_number": 2,
                "valid": False,
                "form_label": "bad",
                "form_probability": 0.22,
                "depth_score": 41.0,
                "detected_issue": "INCOMPLETE_DEPTH",
                "rep_duration_seconds": 5.4,
                "min_elbow_angle_deg": 108.2,
                "body_line_deviation_max": 0.087,
            },
        ],
    }
    payload.update(overrides)
    return payload


def leaderboard_payload(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "display_name": "Ada",
        "valid_reps": 30,
        "invalid_reps": 4,
        "form_score": 91.25,
        "duration_seconds": 180,
        "best_streak": 14,
        "mode": "challenge30",
        "session_id": None,
    }
    payload.update(overrides)
    return payload


# ---------------------------------------------------------------------------
# In-memory double for the PostgREST client
# ---------------------------------------------------------------------------


class FakeSupabase:
    """Minimal stand-in implementing the four verbs the routers use.

    It stores exactly the rows it is handed and returns them back, so a test can
    assert the router's column mapping and status codes. It deliberately does
    not synthesise any value the router did not supply.
    """

    def __init__(self, rpc_rows: Sequence[Mapping[str, Any]] | None = None) -> None:
        self.tables: dict[str, list[dict[str, Any]]] = {}
        self.rpc_rows: list[Mapping[str, Any]] = list(rpc_rows or [])
        self.rpc_calls: list[tuple[str, Mapping[str, Any]]] = []
        self._seq = 0

    def _new_id(self, table: str) -> str:
        self._seq += 1
        return f"{table}-{self._seq:04d}"

    @staticmethod
    def _matches(row: Mapping[str, Any], params: Mapping[str, str]) -> bool:
        for key, value in params.items():
            if not value.startswith("eq."):
                continue  # select / order / limit are handled separately
            if str(row.get(key)) != value[3:]:
                return False
        return True

    def insert(
        self,
        table: str,
        rows: Sequence[Mapping[str, Any]],
        *,
        device_key: str | None = None,
    ) -> list[dict[str, Any]]:
        written: list[dict[str, Any]] = []
        for row in rows:
            stored = dict(row)
            stored.setdefault("id", self._new_id(table))
            stored.setdefault("created_at", datetime.now(timezone.utc).isoformat())
            stored["device_key"] = device_key
            self.tables.setdefault(table, []).append(stored)
            written.append(dict(stored))
        return written

    def select(
        self,
        table: str,
        *,
        params: Mapping[str, str] | None = None,
        device_key: str | None = None,
    ) -> list[dict[str, Any]]:
        params = params or {}
        rows = [dict(r) for r in self.tables.get(table, []) if self._matches(r, params)]
        order = params.get("order")
        if order:
            column, _, direction = order.partition(".")
            rows.sort(key=lambda r: str(r.get(column, "")), reverse=direction == "desc")
        limit = params.get("limit")
        if limit is not None:
            rows = rows[: int(limit)]
        return rows

    def delete(
        self,
        table: str,
        *,
        params: Mapping[str, str],
        device_key: str | None = None,
    ) -> list[dict[str, Any]]:
        kept, removed = [], []
        for row in self.tables.get(table, []):
            (removed if self._matches(row, params) else kept).append(row)
        self.tables[table] = kept
        if table == "workout_sessions":
            # ON DELETE CASCADE on workout_reps.session_id
            deleted_ids = {str(r.get("id")) for r in removed}
            self.tables["workout_reps"] = [
                r
                for r in self.tables.get("workout_reps", [])
                if str(r.get("session_id")) not in deleted_ids
            ]
        return [dict(r) for r in removed]

    def rpc(
        self,
        function: str,
        args: Mapping[str, Any] | None = None,
        *,
        device_key: str | None = None,
    ) -> Any:
        self.rpc_calls.append((function, dict(args or {})))
        return list(self.rpc_rows)

    def close(self) -> None:  # pragma: no cover - lifecycle parity
        return None


# ---------------------------------------------------------------------------
# /health
# ---------------------------------------------------------------------------


def test_health_reports_real_model_metadata() -> None:
    with running_app() as client:
        response = client.get("/health")

    assert response.status_code == 200
    body = response.json()

    assert body["status"] == "ok"
    assert body["model_loaded"] is True
    assert body["model_kind"] == "gbm"
    assert body["model_type"] == "GradientBoostingClassifier"
    assert body["n_features"] == 34
    assert body["n_features_contract"] == 37
    assert body["feature_spec_version"] == 1
    assert body["decision_threshold"] == pytest.approx(0.58, abs=1e-9)
    assert body["version"] == "1.0.0"
    assert body["model_error"] is None

    # The startup self-check ran and agreed with the TypeScript runtime.
    assert body["parity_ok"] is True
    assert body["parity_max_abs_diff"] is not None
    assert body["parity_max_abs_diff"] < PARITY_TOLERANCE


def test_health_degrades_without_raising_when_model_is_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    missing = Path(__file__).resolve().parent / "no-such-directory"
    monkeypatch.setenv("AIPC_MODEL_JSON_PATH", str(missing / "m.json"))
    monkeypatch.setenv("AIPC_MODEL_METADATA_PATH", str(missing / "m.metadata.json"))
    monkeypatch.setenv("AIPC_PARITY_FIXTURE_PATH", str(missing / "p.json"))
    get_settings.cache_clear()

    with running_app() as client:
        health = client.get("/health")
        predict = client.post("/api/v1/form/predict", json={"features": [0.0] * 34})
        info = client.get("/api/v1/model/info")

    # The service stays up and says so honestly.
    assert health.status_code == 200
    body = health.json()
    assert body["status"] == "degraded"
    assert body["model_loaded"] is False
    assert body["n_features"] is None
    assert body["model_kind"] is None
    assert body["parity_ok"] is None
    assert "ModelArtifactError" in body["model_error"]

    assert predict.status_code == 503
    assert predict.json() == {"detail": "model not loaded"}
    assert info.status_code == 503


def test_model_info_is_the_metadata_file_verbatim() -> None:
    from app.paths import DEFAULT_MODEL_METADATA_PATH

    expected = json.loads(Path(DEFAULT_MODEL_METADATA_PATH).read_text(encoding="utf-8"))

    with running_app() as client:
        response = client.get("/api/v1/model/info")

    assert response.status_code == 200
    assert response.json() == expected


# ---------------------------------------------------------------------------
# /api/v1/form/predict
# ---------------------------------------------------------------------------


def test_predict_matches_the_parity_fixture(parity_cases: list[dict[str, Any]]) -> None:
    """The wire response must reproduce the TypeScript runtime within 1e-6."""
    with running_app() as client:
        for case in parity_cases[:5]:
            response = client.post(
                "/api/v1/form/predict",
                json={
                    "features": case["features"],
                    "meta": {"view_type": "side", "feature_spec_version": 1},
                },
            )
            assert response.status_code == 200
            body = response.json()

            expected = case["expectedGoodProbability"]
            assert body["scores"]["good"] == pytest.approx(expected, abs=PARITY_TOLERANCE)
            assert body["scores"]["bad"] == pytest.approx(1.0 - expected, abs=PARITY_TOLERANCE)
            assert body["missing_features"] == []
            assert body["feature_spec_version"] == 1
            assert body["model_type"] == "GradientBoostingClassifier"
            assert body["threshold_used"] == pytest.approx(0.58, abs=1e-9)
            assert body["label"] == ("good" if expected >= 0.58 else "bad")


def test_predict_scores_the_whole_fixture_through_http(
    parity_cases: list[dict[str, Any]],
) -> None:
    """Every one of the 200 cases, scored over the wire."""
    worst = 0.0
    with running_app() as client:
        for index, case in enumerate(parity_cases):
            response = client.post("/api/v1/form/predict", json={"features": case["features"]})
            assert response.status_code == 200, f"case {index}: {response.text}"
            worst = max(
                worst,
                abs(response.json()["scores"]["good"] - case["expectedGoodProbability"]),
            )

    assert worst < PARITY_TOLERANCE, f"max abs diff over HTTP was {worst:.3e}"


def test_predict_accepts_named_mapping_and_37_contract_array(
    parity_cases: list[dict[str, Any]], loaded_service: ModelService
) -> None:
    from app.services.features import FEATURE_NAMES as CONTRACT_NAMES

    assert len(CONTRACT_NAMES) == 37
    case = parity_cases[0]
    expected = case["expectedGoodProbability"]

    named = dict(zip(loaded_service.feature_names, case["features"]))
    contract_vector = [named.get(name) for name in CONTRACT_NAMES]

    with running_app() as client:
        by_name = client.post("/api/v1/form/predict", json={"features": named})
        by_array = client.post("/api/v1/form/predict", json={"features": contract_vector})

    assert by_name.status_code == 200
    assert by_array.status_code == 200
    assert by_name.json()["scores"]["good"] == pytest.approx(expected, abs=PARITY_TOLERANCE)
    assert by_array.json()["scores"]["good"] == pytest.approx(expected, abs=PARITY_TOLERANCE)


def test_predict_batch_scores_every_item(parity_cases: list[dict[str, Any]]) -> None:
    items = [{"features": case["features"]} for case in parity_cases[:3]]

    with running_app() as client:
        response = client.post("/api/v1/form/predict/batch", json={"items": items})

    assert response.status_code == 200
    results = response.json()["results"]
    assert len(results) == 3
    for result, case in zip(results, parity_cases[:3]):
        assert result["scores"]["good"] == pytest.approx(
            case["expectedGoodProbability"], abs=PARITY_TOLERANCE
        )


def test_confidence_is_the_probability_of_the_returned_label(
    parity_cases: list[dict[str, Any]],
) -> None:
    with running_app() as client:
        for case in parity_cases[:40]:
            body = client.post(
                "/api/v1/form/predict", json={"features": case["features"]}
            ).json()
            label = body["label"]
            assert label in ("good", "bad")
            assert body["confidence"] == pytest.approx(
                body["scores"][label], abs=1e-12
            )


def test_more_than_three_missing_features_is_unknown_with_null_confidence(
    parity_cases: list[dict[str, Any]],
) -> None:
    vector = list(parity_cases[0]["features"])
    vector[0] = vector[1] = vector[2] = vector[3] = None

    with running_app() as client:
        response = client.post("/api/v1/form/predict", json={"features": vector})

    assert response.status_code == 200
    body = response.json()
    assert body["label"] == "unknown"
    # No class probability can honestly be attributed to "unknown".
    assert body["confidence"] is None
    assert len(body["missing_features"]) == 4
    # The real class scores are still reported.
    assert body["scores"]["good"] + body["scores"]["bad"] == pytest.approx(1.0, abs=1e-12)


def test_feature_spec_version_mismatch_is_a_hard_400(
    parity_cases: list[dict[str, Any]],
) -> None:
    with running_app() as client:
        response = client.post(
            "/api/v1/form/predict",
            json={"features": parity_cases[0]["features"], "meta": {"feature_spec_version": 0}},
        )

    assert response.status_code == 400
    assert "feature_spec_version mismatch" in response.json()["detail"]


def test_wrong_vector_length_is_422() -> None:
    with running_app() as client:
        response = client.post("/api/v1/form/predict", json={"features": [1.0, 2.0, 3.0]})

    assert response.status_code == 422
    assert "expected 34 or 37 features" in response.json()["detail"]


def test_non_numeric_feature_is_rejected_by_schema_validation() -> None:
    vector: list[Any] = [0.0] * 34
    vector[0] = "not-a-number"

    with running_app() as client:
        response = client.post("/api/v1/form/predict", json={"features": vector})

    assert response.status_code == 422


# ---------------------------------------------------------------------------
# Database-backed routes: graceful degradation
# ---------------------------------------------------------------------------


def test_sessions_routes_require_a_device_key() -> None:
    with running_app() as client:
        assert client.get("/api/v1/sessions").status_code == 400
        assert client.post("/api/v1/sessions", json=session_payload()).status_code == 400
        assert client.get("/api/v1/sessions/abc").status_code == 400
        assert client.delete("/api/v1/sessions/abc").status_code == 400
        assert (
            client.post("/api/v1/leaderboard", json=leaderboard_payload()).status_code == 400
        )

    with running_app() as client:
        response = client.get("/api/v1/sessions")

    assert response.json() == {"detail": "missing required header: x-device-key"}


def test_sessions_and_leaderboard_answer_503_when_supabase_is_unconfigured() -> None:
    """No database must be a typed 503, never a 500 and never an empty 200."""
    headers = {"x-device-key": DEVICE_KEY}

    with running_app() as client:
        calls = [
            client.get("/api/v1/sessions", headers=headers),
            client.post("/api/v1/sessions", json=session_payload(), headers=headers),
            client.get("/api/v1/sessions/abc", headers=headers),
            client.delete("/api/v1/sessions/abc", headers=headers),
            client.get("/api/v1/leaderboard"),
            client.post("/api/v1/leaderboard", json=leaderboard_payload(), headers=headers),
        ]
        # ... and the model endpoints keep serving.
        assert client.get("/health").status_code == 200
        assert (
            client.post("/api/v1/form/predict", json={"features": [0.0] * 34}).status_code
            == 200
        )

    for response in calls:
        assert response.status_code == 503, response.text
        assert response.json() == {"detail": "database not configured"}


def test_unreachable_database_is_a_502_not_an_untyped_500(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A configured-but-unreachable PostgREST must not escape as a stack trace."""
    monkeypatch.setenv("AIPC_SUPABASE_URL", "http://127.0.0.1:9")
    monkeypatch.setenv("AIPC_SUPABASE_KEY", "test-key")
    monkeypatch.setenv("AIPC_SUPABASE_TIMEOUT_SECONDS", "2")
    get_settings.cache_clear()
    close_supabase_client()

    headers = {"x-device-key": DEVICE_KEY}
    with running_app() as client:
        sessions = client.get("/api/v1/sessions", headers=headers)
        leaderboard = client.get("/api/v1/leaderboard")

    for response in (sessions, leaderboard):
        assert response.status_code == 502, response.text
        assert response.json()["detail"].startswith("database unreachable:")


# ---------------------------------------------------------------------------
# Database-backed routes: status codes and column mapping (in-memory double)
# ---------------------------------------------------------------------------


def test_create_session_maps_columns_and_returns_201() -> None:
    db = FakeSupabase()
    headers = {"x-device-key": DEVICE_KEY}

    with running_app(db) as client:
        response = client.post(
            "/api/v1/sessions", json=session_payload(), headers=headers
        )

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["total_reps"] == 12
    assert body["valid_reps"] == 10
    assert body["invalid_reps"] == 2
    assert body["form_score"] == pytest.approx(82.5)
    assert body["view_type"] == "side"
    assert body["mode"] == "workout"
    assert body["id"]

    # Column names follow docs/DATABASE_SCHEMA.md, and the device key is
    # forwarded as the denormalised owner column.
    written = db.tables["workout_sessions"][0]
    assert written["device_key"] == DEVICE_KEY
    assert "duration_seconds" in written
    assert "most_common_issue" in written

    reps = db.tables["workout_reps"]
    assert len(reps) == 2
    assert {rep["session_id"] for rep in reps} == {body["id"]}
    assert reps[1]["detected_issue"] == "INCOMPLETE_DEPTH"
    assert reps[0]["form_label"] == "good"


def test_session_count_integrity_is_enforced_before_the_database() -> None:
    db = FakeSupabase()

    with running_app(db) as client:
        response = client.post(
            "/api/v1/sessions",
            json=session_payload(valid_reps=9),  # 9 + 2 != 12
            headers={"x-device-key": DEVICE_KEY},
        )

    assert response.status_code == 422
    assert db.tables == {}, "an invalid session must never reach the database"


def test_get_session_returns_its_reps_and_404s_when_absent() -> None:
    db = FakeSupabase()
    headers = {"x-device-key": DEVICE_KEY}

    with running_app(db) as client:
        created = client.post("/api/v1/sessions", json=session_payload(), headers=headers)
        session_id = created.json()["id"]

        found = client.get(f"/api/v1/sessions/{session_id}", headers=headers)
        missing = client.get("/api/v1/sessions/does-not-exist", headers=headers)

    assert found.status_code == 200
    detail = found.json()
    assert detail["id"] == session_id
    assert [rep["rep_number"] for rep in detail["reps"]] == [1, 2]

    assert missing.status_code == 404
    assert missing.json() == {"detail": "session not found"}


def test_list_sessions_is_device_scoped() -> None:
    db = FakeSupabase()

    with running_app(db) as client:
        client.post(
            "/api/v1/sessions",
            json=session_payload(),
            headers={"x-device-key": DEVICE_KEY},
        )
        client.post(
            "/api/v1/sessions",
            json=session_payload(),
            headers={"x-device-key": "someone-else"},
        )

        mine = client.get("/api/v1/sessions", headers={"x-device-key": DEVICE_KEY})
        theirs = client.get("/api/v1/sessions", headers={"x-device-key": "someone-else"})

    assert mine.status_code == 200
    assert theirs.status_code == 200
    assert len(mine.json()) == 1
    assert len(theirs.json()) == 1
    assert mine.json()[0]["id"] != theirs.json()[0]["id"]


def test_delete_session_returns_204_and_cascades_reps() -> None:
    db = FakeSupabase()
    headers = {"x-device-key": DEVICE_KEY}

    with running_app(db) as client:
        session_id = client.post(
            "/api/v1/sessions", json=session_payload(), headers=headers
        ).json()["id"]

        deleted = client.delete(f"/api/v1/sessions/{session_id}", headers=headers)
        again = client.delete(f"/api/v1/sessions/{session_id}", headers=headers)

    assert deleted.status_code == 204
    assert deleted.content == b""
    assert db.tables["workout_sessions"] == []
    assert db.tables["workout_reps"] == []
    assert again.status_code == 404


def test_leaderboard_read_is_public_and_ranked() -> None:
    ranked = [
        {
            "rank_position": 1,
            "id": "11111111-1111-1111-1111-111111111111",
            "display_name": "Ada",
            "valid_reps": 40,
            "invalid_reps": 2,
            "form_score": 93.5,
            "duration_seconds": 120,
            "best_streak": 22,
            "mode": "challenge30",
            "created_at": "2026-01-01T10:00:00Z",
        }
    ]
    db = FakeSupabase(rpc_rows=ranked)

    with running_app(db) as client:
        # No x-device-key: the board is public.
        response = client.get("/api/v1/leaderboard?mode=challenge30&limit=10")

    assert response.status_code == 200
    body = response.json()
    assert body["mode"] == "challenge30"
    assert body["count"] == 1
    assert body["entries"][0]["rank_position"] == 1
    assert body["entries"][0]["display_name"] == "Ada"
    assert db.rpc_calls == [("leaderboard_top", {"p_mode": "challenge30", "p_limit": 10})]


def test_leaderboard_rejects_unknown_mode_and_out_of_range_limit() -> None:
    db = FakeSupabase()

    with running_app(db) as client:
        bad_mode = client.get("/api/v1/leaderboard?mode=weekly")
        bad_limit = client.get("/api/v1/leaderboard?limit=0")
        too_many = client.get("/api/v1/leaderboard?limit=501")

    assert bad_mode.status_code == 422
    assert bad_limit.status_code == 422
    assert too_many.status_code == 422
    assert db.rpc_calls == []


def test_leaderboard_submit_returns_201_with_null_rank() -> None:
    db = FakeSupabase()

    with running_app(db) as client:
        response = client.post(
            "/api/v1/leaderboard",
            json=leaderboard_payload(display_name="  Ada   Lovelace  "),
            headers={"x-device-key": DEVICE_KEY},
        )

    assert response.status_code == 201, response.text
    body = response.json()
    # Sanitised: trimmed, inner whitespace collapsed.
    assert body["display_name"] == "Ada Lovelace"
    assert body["valid_reps"] == 30
    # A guessed rank would be fabricated data.
    assert body["rank_position"] is None
    assert db.tables["leaderboard_entries"][0]["device_key"] == DEVICE_KEY


def test_leaderboard_rejects_blank_name_and_impossible_streak() -> None:
    db = FakeSupabase()

    with running_app(db) as client:
        blank = client.post(
            "/api/v1/leaderboard",
            json=leaderboard_payload(display_name="   "),
            headers={"x-device-key": DEVICE_KEY},
        )
        streak = client.post(
            "/api/v1/leaderboard",
            json=leaderboard_payload(valid_reps=5, best_streak=9),
            headers={"x-device-key": DEVICE_KEY},
        )
        score = client.post(
            "/api/v1/leaderboard",
            json=leaderboard_payload(form_score=140.0),
            headers={"x-device-key": DEVICE_KEY},
        )

    assert blank.status_code == 422
    assert streak.status_code == 422
    assert score.status_code == 422
    assert db.tables == {}


# ---------------------------------------------------------------------------
# CORS
# ---------------------------------------------------------------------------


def test_cors_allows_the_configured_dev_origin() -> None:
    with running_app() as client:
        response = client.get("/health", headers={"Origin": "http://localhost:3000"})

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:3000"
