"""Shared router dependencies and error mapping."""

from __future__ import annotations

from contextlib import contextmanager
from typing import Annotated, Iterator

import httpx
from fastapi import Header, HTTPException

from app.services.supabase_client import (
    DatabaseNotConfiguredError,
    SupabaseClient,
    SupabaseError,
    get_supabase_client,
)

DEVICE_KEY_HEADER_ALIAS = "x-device-key"

DeviceKeyHeader = Annotated[str | None, Header(alias=DEVICE_KEY_HEADER_ALIAS)]


def require_device_key(device_key: DeviceKeyHeader = None) -> str:
    """Identity for every write and for every device-scoped read.

    The app runs anonymously at a booth, so "who am I" is the localStorage key
    the browser generated. Requiring it up front turns a forgotten header into a
    clear 400 instead of an orphaned, unreadable row.
    """
    if not device_key or not device_key.strip():
        raise HTTPException(
            status_code=400,
            detail=f"missing required header: {DEVICE_KEY_HEADER_ALIAS}",
        )
    return device_key.strip()


def get_db() -> SupabaseClient:
    return get_supabase_client()


@contextmanager
def db_errors() -> Iterator[None]:
    """Translate storage failures into honest HTTP responses.

    A missing database is 503 ("not configured"), never an empty 200 — the
    client must be able to tell "no data" from "no database".

    A configured-but-unreachable database (DNS failure, connection refused,
    timeout, TLS error) is a 502. Those surface as ``httpx.HTTPError`` from the
    transport, *not* as ``SupabaseError`` (which only covers a non-2xx response
    that was actually received), so without this clause they escaped as an
    untyped 500 stack trace — exactly the failure mode this module exists to
    prevent.
    """
    try:
        yield
    except DatabaseNotConfiguredError as exc:
        raise HTTPException(status_code=503, detail="database not configured") from exc
    except SupabaseError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"database error ({exc.status_code}): {exc.message}",
        ) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"database unreachable: {type(exc).__name__}",
        ) from exc
