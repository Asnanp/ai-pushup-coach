"""Rep scoring endpoints.

`POST /api/v1/form/predict` scores one completed rep; the batch variant exists
for offline evaluation and backfilling, not the live loop (the browser is the
primary inference path).

A feature-spec mismatch is a hard 400 by design: scoring with a mismatched
vector would produce a plausible-looking but meaningless number, which is worse
than an error.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from app.config import get_settings
from app.schemas import (
    BatchPredictRequest,
    BatchPredictResponse,
    PredictMeta,
    PredictRequest,
    PredictResponse,
    ScoreBreakdown,
)
from app.services.model_service import (
    FeatureVectorError,
    ModelNotLoadedError,
    ModelService,
    PredictionResult,
)

router = APIRouter(prefix="/api/v1/form", tags=["predict"])


def _require_service(request: Request) -> ModelService:
    service: ModelService | None = getattr(request.app.state, "model_service", None)
    if service is None or not service.is_loaded:
        raise HTTPException(status_code=503, detail="model not loaded")
    return service


def _check_version(meta: PredictMeta | None) -> None:
    if meta is None or meta.feature_spec_version is None:
        return
    expected = get_settings().feature_spec_version
    if meta.feature_spec_version != expected:
        raise HTTPException(
            status_code=400,
            detail=(
                f"feature_spec_version mismatch: got {meta.feature_spec_version}, "
                f"expected {expected}"
            ),
        )


def _to_response(result: PredictionResult, service: ModelService) -> PredictResponse:
    """Shape one prediction for the wire.

    ``confidence`` is the probability of the returned label — never of a fixed
    class, so client code must not read it as P(good). When the label is
    ``unknown`` no class probability can be honestly attributed to it, so it is
    ``null`` and the client renders ``--``.
    """
    label = result.label
    good = result.good_probability
    confidence: float | None
    if label == "good":
        confidence = good
    elif label == "bad":
        confidence = 1.0 - good
    else:
        confidence = None

    return PredictResponse(
        label=label,
        confidence=confidence,
        scores=ScoreBreakdown(good=good, bad=1.0 - good),
        threshold_used=service.decision_threshold,
        feature_spec_version=service.feature_spec_version,
        missing_features=list(result.missing_feature_names),
        model_type=service.model_type or "unknown",
    )


def _score_one(request: Request, payload: PredictRequest) -> PredictResponse:
    service = _require_service(request)
    _check_version(payload.meta)
    try:
        result = service.score_any(payload.features)
    except FeatureVectorError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ModelNotLoadedError as exc:  # pragma: no cover - guarded above
        raise HTTPException(status_code=503, detail="model not loaded") from exc
    return _to_response(result, service)


@router.post("/predict", response_model=PredictResponse, summary="Score one rep")
async def predict(request: Request, payload: PredictRequest) -> PredictResponse:
    return _score_one(request, payload)


@router.post(
    "/predict/batch",
    response_model=BatchPredictResponse,
    summary="Score many reps in one call",
)
async def predict_batch(
    request: Request, payload: BatchPredictRequest
) -> BatchPredictResponse:
    return BatchPredictResponse(
        results=[_score_one(request, item) for item in payload.items]
    )
