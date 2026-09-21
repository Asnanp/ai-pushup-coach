"""FastAPI application entry point.

The model is loaded exactly once, during the lifespan startup, and shared through
``app.state.model_service``. A load failure does not stop the service: the API
answers ``/health`` with ``status: "degraded"`` and ``model_loaded: false`` so
the client falls back to in-browser inference (docs/API_CONTRACT.md).
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from collections.abc import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.config import get_settings
from app.routers import health, leaderboard, predict, sessions
from app.services.model_service import ModelService, ModelServiceConfig
from app.services.supabase_client import close_supabase_client

logger = logging.getLogger("aipc.api")

DESCRIPTION = """
Backend for the AI Push-Up Coach.

The browser is the **primary inference path** — camera frames never leave the
device. This API exists for batch evaluation, retraining verification, and
environments where the JS model cannot load, plus optional session and
leaderboard persistence.
""".strip()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()

    service = ModelService(ModelServiceConfig.from_settings(settings))
    model_error: str | None = None

    try:
        service.load()
    except Exception as exc:  # noqa: BLE001 - any failure means "degraded"
        model_error = f"{type(exc).__name__}: {exc}"
        logger.error("model failed to load; serving degraded: %s", model_error)
    else:
        logger.info(
            "model loaded: type=%s kind=%s n_features=%s threshold=%.4f",
            service.model_type,
            service.model_kind,
            service.n_features,
            service.decision_threshold,
        )
        # Parity self-check: the Python scorer must reproduce the TypeScript
        # runtime exactly, or the two inference paths would disagree silently.
        try:
            report = service.verify_parity()
        except Exception as exc:  # noqa: BLE001
            logger.error("parity self-check could not run: %s: %s", type(exc).__name__, exc)
        else:
            if report is None:
                logger.warning(
                    "parity fixture not found at %s; skipping self-check",
                    settings.parity_fixture_path,
                )
            elif report.ok:
                logger.info(
                    "parity self-check passed: %d cases, max abs diff %.3e (< %.0e)",
                    report.n_cases,
                    report.max_abs_diff,
                    report.tolerance,
                )
            else:
                logger.error(
                    "parity self-check FAILED: %d cases, max abs diff %.3e (>= %.0e). "
                    "The Python scorer disagrees with packages/form-engine.",
                    report.n_cases,
                    report.max_abs_diff,
                    report.tolerance,
                )

    app.state.model_service = service
    app.state.model_error = model_error
    app.state.settings = settings

    logger.info(
        "database configured: %s", "yes" if settings.database_configured else "no (503 on /sessions, /leaderboard)"
    )

    try:
        yield
    finally:
        close_supabase_client()


def create_app() -> FastAPI:
    settings = get_settings()

    app = FastAPI(
        title="AI Push-Up Coach API",
        description=DESCRIPTION,
        version=settings.api_version or __version__,
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(health.router)
    app.include_router(health.model_router)
    app.include_router(predict.router)
    app.include_router(sessions.router)
    app.include_router(leaderboard.router)

    return app


app = create_app()
