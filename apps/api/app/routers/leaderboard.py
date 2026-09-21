"""Leaderboard read/write (docs/DATABASE_SCHEMA.md §2, §3).

Ordering is owned by the database: reads go through the ``leaderboard_top``
function so the API cannot drift from the documented sort order
(valid_reps DESC, form_score DESC, duration_seconds ASC, created_at ASC).

Reads are public — it is a scoreboard. Writes require a device key and are
validated server-side against the same constraints the table enforces, so a
malformed submission is a 422 rather than a 502 from Postgres.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.routers.deps import db_errors, get_db, require_device_key
from app.schemas import (
    LeaderboardEntry,
    LeaderboardEntryCreate,
    LeaderboardMode,
    LeaderboardResponse,
)
from app.services.supabase_client import SupabaseClient

router = APIRouter(prefix="/api/v1/leaderboard", tags=["leaderboard"])

LEADERBOARD_TABLE = "leaderboard_entries"
TOP_FUNCTION = "leaderboard_top"

# The SQL function clamps to 1..500; clamping here too keeps the error a 422
# instead of a silently different answer.
MAX_LIMIT = 500


@router.get("", response_model=LeaderboardResponse, summary="Ranked top N for one mode")
def get_leaderboard(
    db: Annotated[SupabaseClient, Depends(get_db)],
    mode: Annotated[LeaderboardMode, Query()] = "challenge30",
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = 100,
) -> LeaderboardResponse:
    with db_errors():
        rows: Any = db.rpc(TOP_FUNCTION, {"p_mode": mode, "p_limit": limit})

    if not isinstance(rows, list):
        rows = []

    entries = [LeaderboardEntry.model_validate(row) for row in rows]
    return LeaderboardResponse(mode=mode, count=len(entries), entries=entries)


@router.post(
    "",
    response_model=LeaderboardEntry,
    status_code=status.HTTP_201_CREATED,
    summary="Submit a score",
)
def submit_entry(
    payload: LeaderboardEntryCreate,
    device_key: Annotated[str, Depends(require_device_key)],
    db: Annotated[SupabaseClient, Depends(get_db)],
) -> LeaderboardEntry:
    """Insert one leaderboard row.

    Note: docs/DATABASE_SCHEMA.md §4 describes inserting through a
    ``SECURITY DEFINER`` function, but no such function exists in
    supabase/migrations/0002_leaderboard.sql (only ``leaderboard_top`` does).
    Until one is added, this endpoint performs a direct table insert and applies
    the validation itself — the display name is sanitised in the request schema
    before it reaches the database.

    ``rank_position`` is ``null`` in the response: the real rank would require a
    second query, and a guessed one would be fabricated data.
    """
    row = {
        "display_name": payload.display_name,
        "valid_reps": payload.valid_reps,
        "invalid_reps": payload.invalid_reps,
        "form_score": payload.form_score,
        "duration_seconds": payload.duration_seconds,
        "best_streak": payload.best_streak,
        "mode": payload.mode,
        "session_id": payload.session_id,
    }

    with db_errors():
        rows = db.insert(LEADERBOARD_TABLE, [row], device_key=device_key)

    if not rows:
        raise HTTPException(status_code=502, detail="database returned no leaderboard row")

    return LeaderboardEntry.model_validate(rows[0])
