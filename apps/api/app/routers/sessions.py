"""Workout session persistence (docs/DATABASE_SCHEMA.md §2).

Sessions are **append-only**: a row is written complete (ended_at, counts and
score are all known when the workout ends) and there is no mutable field worth
exposing, so no update endpoint exists. That is a deliberate omission, not a
gap — inventing a PATCH would only create a way to desynchronise the stored
counts from the per-rep rows.

Every endpoint is device-scoped through the `x-device-key` header. RLS enforces
this for client keys; when a service key is configured (which bypasses RLS) the
filter is also applied explicitly in the query, so scoping holds either way.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Mapping

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status

from app.routers.deps import db_errors, get_db, require_device_key
from app.schemas import RepCreate, SessionCreate, SessionDetail, SessionRecord
from app.services.supabase_client import SupabaseClient

router = APIRouter(prefix="/api/v1/sessions", tags=["sessions"])

SESSIONS_TABLE = "workout_sessions"
REPS_TABLE = "workout_reps"


def _iso(value: datetime) -> str:
    return value.isoformat()


def _session_row(payload: SessionCreate) -> dict[str, Any]:
    """Column mapping for `workout_sessions` (names follow the schema exactly)."""
    return {
        "started_at": _iso(payload.started_at),
        "ended_at": _iso(payload.ended_at),
        "duration_seconds": payload.duration_seconds,
        "total_reps": payload.total_reps,
        "valid_reps": payload.valid_reps,
        "invalid_reps": payload.invalid_reps,
        "form_score": payload.form_score,
        "view_type": payload.view_type,
        "mode": payload.mode,
        "best_streak": payload.best_streak,
        "mean_rep_seconds": payload.mean_rep_seconds,
        "most_common_issue": payload.most_common_issue,
    }


def _rep_row(session_id: str, rep: RepCreate) -> dict[str, Any]:
    """Column mapping for `workout_reps`."""
    return {
        "session_id": session_id,
        "rep_number": rep.rep_number,
        "valid": rep.valid,
        "form_probability": rep.form_probability,
        "form_label": rep.form_label,
        "depth_score": rep.depth_score,
        "alignment_score": rep.alignment_score,
        "tempo_score": rep.tempo_score,
        "consistency_score": rep.consistency_score,
        "detected_issue": rep.detected_issue,
        "rep_duration_seconds": rep.rep_duration_seconds,
        "min_elbow_angle_deg": rep.min_elbow_angle_deg,
        "body_line_deviation_max": rep.body_line_deviation_max,
    }


def _device_filter(device_key: str) -> dict[str, str]:
    return {"device_key": f"eq.{device_key}"}


@router.post(
    "",
    response_model=SessionRecord,
    status_code=status.HTTP_201_CREATED,
    summary="Persist a finished session (and its per-rep rows)",
)
def create_session(
    payload: SessionCreate,
    device_key: Annotated[str, Depends(require_device_key)],
    db: Annotated[SupabaseClient, Depends(get_db)],
) -> SessionRecord:
    with db_errors():
        rows = db.insert(SESSIONS_TABLE, [_session_row(payload)], device_key=device_key)
        if not rows:
            raise HTTPException(status_code=502, detail="database returned no session row")

        session = rows[0]
        session_id = str(session["id"])

        if payload.reps:
            try:
                db.insert(
                    REPS_TABLE,
                    [_rep_row(session_id, rep) for rep in payload.reps],
                    device_key=device_key,
                )
            except Exception:
                # A session without its reps is worse than no session: the
                # Progress page would show counts it cannot break down. Roll
                # back the parent (ON DELETE CASCADE clears any partial reps).
                try:
                    db.delete(SESSIONS_TABLE, params={"id": f"eq.{session_id}"}, device_key=device_key)
                except Exception:  # pragma: no cover - best effort cleanup
                    pass
                raise

    return SessionRecord.model_validate(session)


@router.get("", response_model=list[SessionRecord], summary="List this device's sessions")
def list_sessions(
    device_key: Annotated[str, Depends(require_device_key)],
    db: Annotated[SupabaseClient, Depends(get_db)],
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> list[SessionRecord]:
    params = {
        "select": "*",
        "order": "started_at.desc",
        "limit": str(limit),
        **_device_filter(device_key),
    }
    with db_errors():
        rows = db.select(SESSIONS_TABLE, params=params, device_key=device_key)
    return [SessionRecord.model_validate(row) for row in rows]


@router.get("/{session_id}", response_model=SessionDetail, summary="One session with its reps")
def get_session(
    session_id: str,
    device_key: Annotated[str, Depends(require_device_key)],
    db: Annotated[SupabaseClient, Depends(get_db)],
) -> SessionDetail:
    with db_errors():
        rows = db.select(
            SESSIONS_TABLE,
            params={"select": "*", "id": f"eq.{session_id}", **_device_filter(device_key)},
            device_key=device_key,
        )
        if not rows:
            raise HTTPException(status_code=404, detail="session not found")

        reps: list[Mapping[str, Any]] = db.select(
            REPS_TABLE,
            params={"select": "*", "session_id": f"eq.{session_id}", "order": "rep_number.asc"},
            device_key=device_key,
        )

    detail = SessionDetail.model_validate({**rows[0], "reps": reps})
    return detail


@router.delete(
    "/{session_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete one session (reps cascade)",
)
def delete_session(
    session_id: str,
    device_key: Annotated[str, Depends(require_device_key)],
    db: Annotated[SupabaseClient, Depends(get_db)],
) -> Response:
    with db_errors():
        deleted = db.delete(
            SESSIONS_TABLE,
            params={"id": f"eq.{session_id}", **_device_filter(device_key)},
            device_key=device_key,
        )
    if not deleted:
        raise HTTPException(status_code=404, detail="session not found")
    return Response(status_code=status.HTTP_204_NO_CONTENT)
