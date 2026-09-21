"""Liveness / readiness and model metadata.

`GET /health` is polled once on load by the frontend to decide whether the
server inference path is available. It deliberately keeps answering when the
model failed to load — the app degrades to in-browser inference rather than
going down (docs/API_CONTRACT.md).
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request

from app.config import get_settings
from app.schemas import HealthResponse
from app.services.model_service import ModelService

router = APIRouter(tags=["health"])
model_router = APIRouter(prefix="/api/v1/model", tags=["model"])


def get_model_service(request: Request) -> ModelService | None:
    """The instance loaded during the application lifespan, if any."""
    return getattr(request.app.state, "model_service", None)


@router.get("/health", response_model=HealthResponse, summary="Liveness + model readiness")
async def health(request: Request) -> HealthResponse:
    settings = get_settings()
    service = get_model_service(request)
    loaded = service is not None and service.is_loaded
    report = service.parity_report if service is not None else None

    parity_ok = None if report is None else report.ok
    # Degraded when the model is missing, or when the self-check disagrees with
    # the TypeScript runtime — either way the numbers cannot be trusted blindly.
    status = "ok" if loaded and parity_ok is not False else "degraded"

    return HealthResponse(
        status=status,
        model_loaded=loaded,
        feature_spec_version=settings.feature_spec_version,
        n_features=service.n_features if loaded and service else None,
        n_features_contract=service.n_features_contract if loaded and service else None,
        model_type=service.model_type if loaded and service else None,
        model_kind=service.model_kind if loaded and service else None,
        decision_threshold=service.decision_threshold if loaded and service else None,
        version=settings.api_version,
        parity_ok=parity_ok,
        parity_max_abs_diff=None if report is None else report.max_abs_diff,
        model_error=getattr(request.app.state, "model_error", None),
    )


@model_router.get("/info", summary="Full model metadata (verbatim)")
async def model_info(request: Request) -> dict[str, Any]:
    """Return ``pushup_form_model.metadata.json`` unchanged.

    The About page reads genuinely measured metrics from here instead of
    hardcoded copy. Nothing is recomputed or prettified on the way out.
    """
    service = get_model_service(request)
    if service is None or not service.is_loaded or service.metadata is None:
        raise HTTPException(status_code=503, detail="model not loaded")
    return service.metadata
