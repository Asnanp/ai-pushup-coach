"""Pydantic v2 request/response models.

Shapes follow ``docs/API_CONTRACT.md`` exactly. Column names follow
``docs/DATABASE_SCHEMA.md`` exactly.

Two deliberate deviations from the illustrative examples in API_CONTRACT.md,
both forced by the *real* model artifact (see
``ml/models/pushup_form_model.metadata.json``):

1. ``/health`` reports ``n_features = 34`` (the count the GBM actually consumes)
   alongside ``n_features_contract = 37``. The contract document's example shows
   37 because it was written before the capture-leak features were excluded.
2. ``PredictResponse.confidence`` is nullable. It is the probability of the
   returned ``label``; when the label is ``"unknown"`` no class probability can
   be honestly attributed to it, so the field is ``null`` and the client renders
   ``--``. Returning a number there would be fabricated data.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

# ---------------------------------------------------------------------------
# Enumerations (mirror the Postgres enums in supabase/migrations/0001_init.sql)
# ---------------------------------------------------------------------------

FormLabel = Literal["good", "bad", "unknown"]
CameraView = Literal["side", "diagonal", "front"]
SessionMode = Literal["workout", "challenge"]
LeaderboardMode = Literal["challenge30", "free"]

IssueCode = Literal[
    "INCOMPLETE_DEPTH",
    "HIPS_TOO_HIGH",
    "HIPS_DROPPING",
    "BODY_NOT_STRAIGHT",
    "ELBOW_FLARE",
    "TOO_FAST",
    "KNEES_BENT",
    "PARTIAL_RANGE",
    "UNSTABLE",
    "LOW_CONFIDENCE",
]

# A feature may legitimately be unknown at the client (`null`), in which case
# the server imputes the training mean and counts it as missing.
FeatureValue = float | None


class _Base(BaseModel):
    """Shared config: ignore unknown keys so additive contract changes are safe."""

    model_config = ConfigDict(extra="ignore")


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------


class HealthResponse(_Base):
    """`GET /health` — liveness plus model readiness.

    The frontend polls this once on load to decide whether the server inference
    path is available. ``model_loaded: false`` means "use the in-browser model
    only"; the service is still considered up.
    """

    status: Literal["ok", "degraded"]
    model_loaded: bool
    feature_spec_version: int
    n_features: int | None
    n_features_contract: int | None
    model_type: str | None
    model_kind: str | None
    decision_threshold: float | None
    version: str
    # Honest diagnostics: `null` when the model could not be inspected at all.
    parity_ok: bool | None = None
    parity_max_abs_diff: float | None = None
    model_error: str | None = None


# ---------------------------------------------------------------------------
# Prediction
# ---------------------------------------------------------------------------


class PredictMeta(_Base):
    view_type: CameraView | None = None
    feature_spec_version: int | None = None


class PredictRequest(_Base):
    """One completed rep.

    ``features`` may be a mapping keyed by the 37 contract feature names (the
    excluded capture features are simply ignored), or an ordered array of either
    37 values (contract order) or 34 values (model order).
    """

    features: dict[str, FeatureValue] | list[FeatureValue]
    meta: PredictMeta | None = None


class ScoreBreakdown(_Base):
    good: float
    bad: float


class PredictResponse(_Base):
    label: FormLabel
    # Probability of `label`. `null` when label == "unknown".
    confidence: float | None
    scores: ScoreBreakdown
    threshold_used: float
    feature_spec_version: int
    missing_features: list[str]
    model_type: str


class BatchPredictRequest(_Base):
    items: list[PredictRequest]


class BatchPredictResponse(_Base):
    results: list[PredictResponse]


# ---------------------------------------------------------------------------
# Sessions (docs/DATABASE_SCHEMA.md §2)
# ---------------------------------------------------------------------------


class RepCreate(_Base):
    """One row of `workout_reps`."""

    rep_number: int = Field(ge=1)
    valid: bool
    form_label: FormLabel
    form_probability: Annotated[float | None, Field(ge=0, le=1)] = None
    depth_score: Annotated[float | None, Field(ge=0, le=100)] = None
    alignment_score: Annotated[float | None, Field(ge=0, le=100)] = None
    tempo_score: Annotated[float | None, Field(ge=0, le=100)] = None
    consistency_score: Annotated[float | None, Field(ge=0, le=100)] = None
    detected_issue: IssueCode | None = None
    rep_duration_seconds: Annotated[float | None, Field(ge=0)] = None
    min_elbow_angle_deg: Annotated[float | None, Field(ge=0, le=180)] = None
    body_line_deviation_max: Annotated[float | None, Field(ge=0)] = None


class SessionCreate(_Base):
    """One row of `workout_sessions`, optionally with its per-rep rows.

    The validation below mirrors the CHECK constraints in
    supabase/migrations/0001_init.sql so a bad payload fails fast with a 422
    instead of round-tripping to Postgres for a 502.
    """

    started_at: datetime
    ended_at: datetime
    duration_seconds: int = Field(ge=0)
    total_reps: int = Field(ge=0)
    valid_reps: int = Field(ge=0)
    invalid_reps: int = Field(ge=0)
    form_score: Annotated[float | None, Field(ge=0, le=100)] = None
    view_type: CameraView
    mode: SessionMode
    best_streak: int = Field(default=0, ge=0)
    mean_rep_seconds: Annotated[float | None, Field(ge=0)] = None
    most_common_issue: IssueCode | None = None
    reps: list[RepCreate] = Field(default_factory=list)

    @model_validator(mode="after")
    def _enforce_integrity(self) -> "SessionCreate":
        # Deliberate: bad reps are counted, never discarded.
        if self.valid_reps + self.invalid_reps != self.total_reps:
            raise ValueError(
                "valid_reps + invalid_reps must equal total_reps "
                f"({self.valid_reps} + {self.invalid_reps} != {self.total_reps})"
            )
        if self.ended_at < self.started_at:
            raise ValueError("ended_at must not be earlier than started_at")
        if self.best_streak > self.valid_reps:
            raise ValueError("best_streak cannot exceed valid_reps")
        return self


class RepRecord(_Base):
    id: str
    session_id: str
    rep_number: int
    valid: bool
    form_label: FormLabel
    form_probability: float | None = None
    decision_threshold: float | None = None
    depth_score: float | None = None
    alignment_score: float | None = None
    tempo_score: float | None = None
    consistency_score: float | None = None
    detected_issue: IssueCode | None = None
    rep_duration_seconds: float | None = None
    min_elbow_angle_deg: float | None = None
    body_line_deviation_max: float | None = None
    created_at: datetime | None = None


class SessionRecord(_Base):
    id: str
    user_id: str | None = None
    started_at: datetime
    ended_at: datetime
    duration_seconds: int
    total_reps: int
    valid_reps: int
    invalid_reps: int
    form_score: float | None = None
    view_type: CameraView
    mode: SessionMode
    best_streak: int
    mean_rep_seconds: float | None = None
    most_common_issue: IssueCode | None = None
    created_at: datetime | None = None


class SessionDetail(SessionRecord):
    reps: list[RepRecord] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Leaderboard (docs/DATABASE_SCHEMA.md §2, §3)
# ---------------------------------------------------------------------------

MAX_DISPLAY_NAME_LENGTH = 24


def sanitise_display_name(raw: str) -> str:
    """Trim, collapse whitespace, strip control characters, cap at 24 chars.

    `display_name` is the only user-supplied text in the schema
    (docs/DATABASE_SCHEMA.md §1) and is rendered on a projector at the booth, so
    it is normalised server-side rather than trusted.
    """
    printable = "".join(ch for ch in raw if ch.isprintable())
    collapsed = " ".join(printable.split())
    return collapsed[:MAX_DISPLAY_NAME_LENGTH].strip()


class LeaderboardEntryCreate(_Base):
    """A leaderboard row.

    Every count is required — the table has column defaults, but silently
    writing a zero for a missing count would fabricate data.
    """

    display_name: str
    valid_reps: int = Field(ge=0)
    invalid_reps: int = Field(ge=0)
    form_score: Annotated[float, Field(ge=0, le=100)]
    duration_seconds: int = Field(ge=0)
    best_streak: int = Field(ge=0)
    mode: LeaderboardMode
    session_id: str | None = None

    @field_validator("display_name")
    @classmethod
    def _sanitise(cls, value: str) -> str:
        cleaned = sanitise_display_name(value)
        if not cleaned:
            raise ValueError("display_name must contain at least 1 printable character")
        return cleaned

    @model_validator(mode="after")
    def _enforce_integrity(self) -> "LeaderboardEntryCreate":
        if self.best_streak > self.valid_reps:
            raise ValueError("best_streak cannot exceed valid_reps")
        return self


class LeaderboardEntry(_Base):
    """A ranked row, as returned by the `leaderboard_top` RPC."""

    rank_position: int | None = None
    id: str
    display_name: str
    valid_reps: int
    invalid_reps: int
    form_score: float | None = None
    duration_seconds: int
    best_streak: int
    mode: LeaderboardMode
    created_at: datetime | None = None


class LeaderboardResponse(_Base):
    mode: LeaderboardMode
    count: int
    entries: list[LeaderboardEntry]


# ---------------------------------------------------------------------------
# Model info
# ---------------------------------------------------------------------------

# `GET /api/v1/model/info` returns the metadata file verbatim so the About page
# can show genuinely measured numbers rather than hardcoded copy.
ModelInfoResponse = dict[str, Any]
