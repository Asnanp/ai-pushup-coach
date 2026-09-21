"""Application settings for the AI Push-Up Coach API.

Paths come from ``app.paths`` (stdlib) so the layout has exactly one definition.
Every field can be overridden with an ``AIPC_``-prefixed environment variable or
a line in ``apps/api/.env``.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.paths import (
    API_DIR,
    DEFAULT_MODEL_JSON_PATH,
    DEFAULT_MODEL_METADATA_PATH,
    DEFAULT_PARITY_FIXTURE_PATH,
)

__all__ = [
    "Settings",
    "get_settings",
    "API_DIR",
    "DEFAULT_MODEL_JSON_PATH",
    "DEFAULT_MODEL_METADATA_PATH",
    "DEFAULT_PARITY_FIXTURE_PATH",
]


class Settings(BaseSettings):
    """Environment-driven configuration."""

    model_config = SettingsConfigDict(
        env_prefix="AIPC_",
        env_file=API_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # --- service identity -------------------------------------------------
    service_name: str = "ai-pushup-coach-api"
    api_version: str = "1.0.0"

    # --- model artifact ---------------------------------------------------
    # The contract version this service was built against. A model whose
    # metadata declares a different version is refused at load time
    # (docs/MODEL_CONTRACT.md §8).
    feature_spec_version: int = 1
    model_json_path: Path = DEFAULT_MODEL_JSON_PATH
    model_metadata_path: Path = DEFAULT_MODEL_METADATA_PATH
    # Dev-only parity fixture used by the startup self-check and the test suite.
    parity_fixture_path: Path = DEFAULT_PARITY_FIXTURE_PATH

    # A rep is reported as `unknown` when more than this many features had to be
    # imputed (docs/MODEL_CONTRACT.md §8, guardrail 3).
    max_missing_features: int = 3

    # --- CORS -------------------------------------------------------------
    # The Next.js dev server. Override with AIPC_CORS_ORIGINS='["https://..."]'.
    cors_origins: list[str] = Field(default_factory=lambda: ["http://localhost:3000"])

    # --- Supabase (optional) ---------------------------------------------
    # The app is fully functional with no database configured; the session and
    # leaderboard endpoints answer 503 rather than inventing data.
    supabase_url: str | None = Field(
        default=None,
        validation_alias=AliasChoices("AIPC_SUPABASE_URL", "SUPABASE_URL"),
    )
    supabase_key: str | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "AIPC_SUPABASE_KEY",
            "AIPC_SUPABASE_SERVICE_KEY",
            "SUPABASE_SERVICE_KEY",
            "SUPABASE_SERVICE_ROLE_KEY",
            "SUPABASE_ANON_KEY",
            "SUPABASE_KEY",
        ),
    )
    supabase_timeout_seconds: float = 10.0

    @property
    def database_configured(self) -> bool:
        return bool(self.supabase_url and self.supabase_key)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Process-wide settings singleton."""
    return Settings()
