"""Minimal PostgREST client for Supabase.

The database is optional (docs/DATABASE_SCHEMA.md §6): the app is fully
functional with no database configured, writing sessions to localStorage. When
``SUPABASE_URL``/``SUPABASE_KEY`` are absent the session and leaderboard
endpoints answer ``503 database not configured`` rather than inventing data.

Why not ``supabase-py``: it is not installed in the project interpreter and
pulls a large dependency tree. The API only needs four REST verbs, and ``httpx``
is already required by FastAPI's test client.

Identity: the schema resolves the caller's device key from the PostgREST request
header ``x-device-key`` (see ``public.current_device_key()`` in
supabase/migrations/0001_init.sql). We forward that header on every call so RLS
and column defaults behave the same as a direct client request. When the service
key is used, RLS is bypassed, so callers that must be device-scoped also filter
explicitly.
"""

from __future__ import annotations

from typing import Any, Mapping, Sequence

import httpx

from app.config import Settings, get_settings

DEVICE_KEY_HEADER = "x-device-key"


class DatabaseNotConfiguredError(RuntimeError):
    """Raised when Supabase env vars are absent."""


class SupabaseError(RuntimeError):
    """An upstream PostgREST/Supabase call failed."""

    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.message = message


class SupabaseClient:
    """Thin synchronous PostgREST wrapper."""

    def __init__(self, settings: Settings | None = None) -> None:
        self._settings: Settings = settings or get_settings()
        self._client: httpx.Client | None = None

    # -- lifecycle ---------------------------------------------------------

    @property
    def configured(self) -> bool:
        return self._settings.database_configured

    def _http(self) -> httpx.Client:
        if not self.configured:
            raise DatabaseNotConfiguredError(
                "database not configured: set SUPABASE_URL and SUPABASE_KEY "
                "(or AIPC_SUPABASE_URL / AIPC_SUPABASE_KEY)"
            )
        if self._client is None:
            self._client = httpx.Client(
                base_url=f"{str(self._settings.supabase_url).rstrip('/')}/rest/v1",
                timeout=self._settings.supabase_timeout_seconds,
                headers={
                    "apikey": str(self._settings.supabase_key),
                    "Authorization": f"Bearer {self._settings.supabase_key}",
                    "Content-Type": "application/json",
                },
            )
        return self._client

    def close(self) -> None:
        if self._client is not None:
            self._client.close()
            self._client = None

    # -- helpers -----------------------------------------------------------

    @staticmethod
    def _headers(device_key: str | None, prefer: str | None) -> dict[str, str]:
        headers: dict[str, str] = {}
        if device_key:
            headers[DEVICE_KEY_HEADER] = device_key
        if prefer:
            headers["Prefer"] = prefer
        return headers

    @staticmethod
    def _check(response: httpx.Response) -> None:
        if response.is_success:
            return
        raise SupabaseError(response.status_code, response.text[:2000])

    # -- verbs -------------------------------------------------------------

    def select(
        self,
        table: str,
        *,
        params: Mapping[str, str] | None = None,
        device_key: str | None = None,
    ) -> list[dict[str, Any]]:
        response = self._http().get(
            f"/{table}", params=dict(params or {}), headers=self._headers(device_key, None)
        )
        self._check(response)
        payload = response.json()
        return payload if isinstance(payload, list) else []

    def insert(
        self,
        table: str,
        rows: Sequence[Mapping[str, Any]],
        *,
        device_key: str | None = None,
    ) -> list[dict[str, Any]]:
        response = self._http().post(
            f"/{table}",
            json=list(rows),
            headers=self._headers(device_key, "return=representation"),
        )
        self._check(response)
        payload = response.json()
        return payload if isinstance(payload, list) else []

    def delete(
        self,
        table: str,
        *,
        params: Mapping[str, str],
        device_key: str | None = None,
    ) -> list[dict[str, Any]]:
        response = self._http().delete(
            f"/{table}",
            params=dict(params),
            headers=self._headers(device_key, "return=representation"),
        )
        self._check(response)
        payload = response.json()
        return payload if isinstance(payload, list) else []

    def rpc(
        self,
        function: str,
        args: Mapping[str, Any] | None = None,
        *,
        device_key: str | None = None,
    ) -> Any:
        response = self._http().post(
            f"/rpc/{function}",
            json=dict(args or {}),
            headers=self._headers(device_key, None),
        )
        self._check(response)
        return response.json()


_client_singleton: SupabaseClient | None = None


def get_supabase_client() -> SupabaseClient:
    """Process-wide client, so connection pooling survives across requests."""
    global _client_singleton
    if _client_singleton is None:
        _client_singleton = SupabaseClient()
    return _client_singleton


def close_supabase_client() -> None:
    global _client_singleton
    if _client_singleton is not None:
        _client_singleton.close()
        _client_singleton = None
