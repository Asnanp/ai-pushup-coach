"""Model service — loads the exported GBM artifact and scores feature vectors.

PARITY CONTRACT
---------------
This module must reproduce ``packages/form-engine/src/model-runtime.ts``
method ``FormModel.scoreGbm`` exactly (max abs difference < 1e-6, measured
1.1e-16 against ``ml/models/parity_fixture.json``). The logic below is a
deliberate line-for-line mirror of that method, including its class-semantics
composition, because the shipped artifact is easy to get backwards:

    pushup_form_model.json      kind: "gbm", sigmoidIsClass: 1
    pushup_form_model.metadata  positive_class: 0, positive_class_meaning: "P(good form)"

The raw sigmoid therefore yields P(class 1) = P(bad), and P(good) is its
complement. Two independent things can flip the answer — which class the
sigmoid refers to, and whether the configured positive class is "good" — so
they are composed rather than assumed to cancel (see ``_score_gbm``).

The module is intentionally dependency-free (stdlib only) so the scoring path —
and therefore the parity test — can run without numpy, FastAPI, pydantic or
scikit-learn installed.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal, Mapping, Sequence

from app.paths import (
    DEFAULT_MODEL_JSON_PATH,
    DEFAULT_MODEL_METADATA_PATH,
    DEFAULT_PARITY_FIXTURE_PATH,
)

if TYPE_CHECKING:  # pragma: no cover - typing only, avoids a pydantic import
    from app.config import Settings

# Structurally identical to `app.schemas.FormLabel`. Defined here rather than
# imported so the scoring core stays importable without pydantic; the web layer
# re-declares it as a Literal in app/schemas.py.
FormLabel = Literal["good", "bad", "unknown"]

# ---------------------------------------------------------------------------
# Constants (mirrors packages/form-engine/src/model-runtime.ts)
# ---------------------------------------------------------------------------

# sklearn's LabelEncoder mapped the string labels in sorted order:
# 'bad' -> 0, 'good' -> 1.
CLASS_BAD = 0
CLASS_GOOD = 1
POSITIVE_CLASS = CLASS_GOOD

# A malformed export must not hang the request. Mirrors the TS depth guard.
_TREE_DEPTH_GUARD = 200

DEFAULT_PARITY_TOLERANCE = 1e-6


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ModelServiceConfig:
    """Where the artifact lives and which contract version to enforce.

    Deliberately a plain dataclass rather than the pydantic ``Settings`` object,
    so this module (and its tests) do not depend on pydantic being installed.
    """

    model_json_path: Path = field(default_factory=lambda: Path(DEFAULT_MODEL_JSON_PATH))
    model_metadata_path: Path = field(
        default_factory=lambda: Path(DEFAULT_MODEL_METADATA_PATH)
    )
    parity_fixture_path: Path = field(
        default_factory=lambda: Path(DEFAULT_PARITY_FIXTURE_PATH)
    )
    feature_spec_version: int = 1
    max_missing_features: int = 3

    @classmethod
    def from_settings(cls, settings: "Settings") -> "ModelServiceConfig":
        """Build from the app ``Settings`` (duck-typed; no import needed)."""
        return cls(
            model_json_path=Path(settings.model_json_path),
            model_metadata_path=Path(settings.model_metadata_path),
            parity_fixture_path=Path(settings.parity_fixture_path),
            feature_spec_version=int(settings.feature_spec_version),
            max_missing_features=int(settings.max_missing_features),
        )


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class ModelError(RuntimeError):
    """Base class for model problems."""


class ModelNotLoadedError(ModelError):
    """`predict` was called before a successful `load()`."""


class ModelArtifactError(ModelError):
    """The artifact is missing, malformed, or violates the model contract."""


class FeatureVectorError(ModelError):
    """The supplied feature vector does not match the model's contract."""


# ---------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PredictionResult:
    """Outcome of scoring one completed rep."""

    good_probability: float
    label: FormLabel
    missing_feature_count: int
    missing_feature_names: tuple[str, ...]


@dataclass(frozen=True)
class ParityReport:
    """Result of the Python-vs-TypeScript parity self-check."""

    n_cases: int
    max_abs_diff: float
    tolerance: float

    @property
    def ok(self) -> bool:
        return self.max_abs_diff < self.tolerance


# ---------------------------------------------------------------------------
# Numeric helpers
# ---------------------------------------------------------------------------


def _is_finite_number(value: object) -> bool:
    """Equivalent of TS ``Number.isFinite(value)`` (bools are not numbers)."""
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
    )


def _sigmoid(z: float) -> float:
    """Numerically safe logistic function.

    Branching keeps ``math.exp`` inside its range for large |z|; the result is
    mathematically identical to ``1 / (1 + exp(-z))`` and matches JS
    ``Math.exp`` behaviour (which saturates to 0.0 / 1.0 instead of raising).
    """
    if z >= 0.0:
        return 1.0 / (1.0 + math.exp(-z))
    exp_z = math.exp(z)
    return exp_z / (1.0 + exp_z)


def _traverse(tree: Mapping[str, Any], x: Sequence[float]) -> int:
    """Walk one tree, returning the leaf index. Mirrors TS ``traverse``."""
    children_left = tree["childrenLeft"]
    children_right = tree["childrenRight"]
    feature = tree["feature"]
    threshold = tree["threshold"]

    node = 0
    for _ in range(_TREE_DEPTH_GUARD):
        left = children_left[node]
        if left == -1:
            return node  # leaf
        node = left if x[feature[node]] <= threshold[node] else children_right[node]
    raise ModelArtifactError("tree traversal exceeded the depth guard (malformed export)")


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------


class ModelService:
    """Loads the exported artifact once and scores feature vectors."""

    def __init__(self, config: ModelServiceConfig | None = None) -> None:
        self._config: ModelServiceConfig = config or ModelServiceConfig()
        self._meta: dict[str, Any] | None = None
        self._exp: dict[str, Any] | None = None
        self._feature_names: list[str] = []
        self._means: list[float] = []
        self._n_features: int = 0
        self._threshold: float = 0.5
        self._parity: ParityReport | None = None

    # -- state -------------------------------------------------------------

    @property
    def is_loaded(self) -> bool:
        return self._meta is not None and self._exp is not None

    @property
    def metadata(self) -> dict[str, Any] | None:
        return self._meta

    @property
    def model_type(self) -> str | None:
        return None if self._meta is None else str(self._meta.get("model_type", "unknown"))

    @property
    def model_kind(self) -> str | None:
        return None if self._exp is None else str(self._exp.get("kind", "unknown"))

    @property
    def n_features(self) -> int | None:
        """Number of features the MODEL consumes (34 for the shipped artifact)."""
        return self._n_features or None

    @property
    def n_features_contract(self) -> int | None:
        """Size of the feature contract in docs/FEATURE_SCHEMA.md (37)."""
        if self._meta is None:
            return None
        value = self._meta.get("n_features_contract")
        return int(value) if isinstance(value, (int, float)) else None

    @property
    def feature_spec_version(self) -> int:
        return self._config.feature_spec_version

    @property
    def decision_threshold(self) -> float:
        return self._threshold

    @property
    def feature_names(self) -> list[str]:
        return list(self._feature_names)

    @property
    def parity_report(self) -> ParityReport | None:
        return self._parity

    # -- loading -----------------------------------------------------------

    def load(self) -> None:
        """Read and validate the artifact pair. Raises ``ModelArtifactError``."""
        meta_path = Path(self._config.model_metadata_path)
        exp_path = Path(self._config.model_json_path)

        for path in (meta_path, exp_path):
            if not path.is_file():
                raise ModelArtifactError(f"model artifact not found: {path}")

        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            exp = json.loads(exp_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise ModelArtifactError(f"model artifact is not valid JSON: {exc}") from exc

        if not isinstance(meta, dict) or not isinstance(exp, dict):
            raise ModelArtifactError("model artifact must be a JSON object")

        self._validate(meta, exp)

        self._meta = meta
        self._exp = exp
        self._feature_names = [str(name) for name in meta["feature_names"]]
        self._n_features = int(meta["n_features"])
        self._threshold = float(meta["decision_threshold"])
        # Positional: a non-finite mean stays in place as NaN so index i always
        # corresponds to feature i (predict() then falls back to 0.0 for it).
        raw_means = meta.get("train_feature_means") or []
        self._means = [
            float(value) if _is_finite_number(value) else float("nan")
            for value in raw_means
        ]

    def _validate(self, meta: Mapping[str, Any], exp: Mapping[str, Any]) -> None:
        """Guardrails from docs/MODEL_CONTRACT.md §8.

        A feature-spec mismatch means the model was trained on a different
        vector layout; scoring with it would produce confident nonsense, so we
        refuse instead of guessing.
        """
        expected_version = self._config.feature_spec_version
        declared_version = meta.get("feature_spec_version")
        if declared_version != expected_version:
            raise ModelArtifactError(
                "feature_spec_version mismatch: "
                f"model={declared_version}, service={expected_version}"
            )

        kind = exp.get("kind")
        if kind != "gbm":
            raise ModelArtifactError(
                f"unsupported export kind {kind!r}; this service implements 'gbm' only"
            )

        # A GBM export without `sigmoidIsClass` cannot be interpreted safely:
        # we would have to guess whether the sigmoid means P(good) or P(bad),
        # and guessing wrong inverts every prediction.
        sigmoid_class = exp.get("sigmoidIsClass")
        if not _is_finite_number(sigmoid_class):
            raise ModelArtifactError(
                "GBM export is missing a numeric `sigmoidIsClass`; refusing to "
                "guess class semantics. Re-run ml/scripts/export_model.py."
            )

        n_features = meta.get("n_features")
        if not isinstance(n_features, int) or n_features <= 0:
            raise ModelArtifactError(f"invalid n_features: {n_features!r}")

        names = meta.get("feature_names")
        if not isinstance(names, list) or len(names) != n_features:
            raise ModelArtifactError(
                "feature_names must be a list whose length equals n_features "
                f"(got {len(names) if isinstance(names, list) else names!r}, "
                f"expected {n_features})"
            )

        if not _is_finite_number(meta.get("decision_threshold")):
            raise ModelArtifactError("decision_threshold must be a finite number")

        trees = exp.get("trees")
        if not isinstance(trees, list) or not trees:
            raise ModelArtifactError("export contains no trees")

        if not _is_finite_number(exp.get("initRaw")) or not _is_finite_number(
            exp.get("learningRate")
        ):
            raise ModelArtifactError("export is missing a numeric initRaw/learningRate")

    # -- class semantics ---------------------------------------------------

    def _resolve_positive_class(self) -> tuple[int, bool]:
        """Resolve ``positive_class`` to an index and whether that index is "good".

        Mirrors TS ``FormModel.resolvePositiveClass``. ``positive_class_meaning``
        is the authority on what the positive class IS, because the index alone
        is not self-describing.
        """
        assert self._meta is not None
        declared = self._meta.get("positive_class")
        meaning = str(self._meta.get("positive_class_meaning") or "").lower()

        if _is_finite_number(declared):
            index = int(declared)  # type: ignore[arg-type]
        elif declared in ("good", "bad"):
            index = CLASS_GOOD if declared == "good" else CLASS_BAD
        else:
            index = POSITIVE_CLASS

        if "good" in meaning:
            is_good = True
        elif "bad" in meaning:
            is_good = False
        else:
            is_good = index == CLASS_GOOD

        return index, is_good

    def _row_for_class(self, classes: Sequence[Any] | None, index: int) -> int:
        """Mirrors TS ``rowForClass``: position of ``index`` in ``classes``."""
        if not classes:
            return 0
        try:
            return list(classes).index(index)
        except ValueError:
            return 0

    def _score_gbm(self, x: Sequence[float]) -> float:
        """P(good form). Mirrors TS ``FormModel.scoreGbm`` exactly."""
        assert self._exp is not None
        learning_rate = float(self._exp["learningRate"])
        raw = float(self._exp["initRaw"])

        for tree in self._exp["trees"]:
            leaf = _traverse(tree, x)
            value = tree["value"][leaf]
            raw += learning_rate * (value[0] if isinstance(value, (list, tuple)) else value)

        p = _sigmoid(raw)

        index, is_good = self._resolve_positive_class()
        sigmoid_class = self._exp.get("sigmoidIsClass")
        if not _is_finite_number(sigmoid_class):
            sigmoid_class = self._row_for_class(self._exp.get("classes"), CLASS_GOOD)

        # Compose the two flips rather than assuming either cancels out.
        sigmoid_is_positive = int(sigmoid_class) == index  # type: ignore[arg-type]
        want_good = sigmoid_is_positive if is_good else not sigmoid_is_positive
        return p if want_good else 1.0 - p

    # -- scoring -----------------------------------------------------------

    def predict(self, vector: Sequence[float | None]) -> PredictionResult:
        """Score one feature vector in MODEL order.

        Non-finite (or ``None``) features are imputed with the training mean and
        counted. If more than ``max_missing_features`` were imputed the label is
        reported as ``unknown`` rather than guessed — degrading to "I don't
        know" is what keeps the system honest (docs/MODEL_CONTRACT.md §8).
        """
        if not self.is_loaded:
            raise ModelNotLoadedError("model not loaded")

        if len(vector) != self._n_features:
            raise FeatureVectorError(
                f"expected {self._n_features} features, got {len(vector)}"
            )

        x: list[float] = [0.0] * self._n_features
        missing_names: list[str] = []

        for i, name in enumerate(self._feature_names):
            value = vector[i]
            if _is_finite_number(value):
                x[i] = float(value)  # type: ignore[arg-type]
                continue
            mean = self._means[i] if i < len(self._means) else 0.0
            x[i] = mean if math.isfinite(mean) else 0.0
            missing_names.append(name)

        good_probability = min(1.0, max(0.0, self._score_gbm(x)))

        label: FormLabel = "good" if good_probability >= self._threshold else "bad"
        if len(missing_names) > self._config.max_missing_features:
            label = "unknown"

        return PredictionResult(
            good_probability=good_probability,
            label=label,
            missing_feature_count=len(missing_names),
            missing_feature_names=tuple(missing_names),
        )

    def score_named(self, features: Mapping[str, float | None]) -> PredictionResult:
        """Score a mapping keyed by feature name.

        Absent keys are treated exactly like non-finite values: imputed and
        counted as missing. The 7 excluded capture features present in the
        37-key contract payload are ignored by construction.
        """
        if not self.is_loaded:
            raise ModelNotLoadedError("model not loaded")
        vector = [features.get(name) for name in self._feature_names]
        return self.predict(vector)

    def score_any(
        self, features: Mapping[str, float | None] | Sequence[float | None]
    ) -> PredictionResult:
        """Score either a named mapping or an ordered array.

        Arrays of ``n_features`` are read in model order; arrays of
        ``n_features_contract`` (37) are read in contract order and then reduced
        to the model's 34 by name.
        """
        if not self.is_loaded:
            raise ModelNotLoadedError("model not loaded")

        if isinstance(features, Mapping):
            return self.score_named(features)

        values = list(features)
        if len(values) == self._n_features:
            return self.predict(values)

        contract_n = self.n_features_contract
        if contract_n is not None and len(values) == contract_n:
            return self.score_named(self._contract_vector_to_mapping(values))

        raise FeatureVectorError(
            f"expected {self._n_features} or {contract_n} features, got {len(values)}"
        )

    def _contract_vector_to_mapping(
        self, values: Sequence[float | None]
    ) -> dict[str, float | None]:
        """Map a 37-length contract-order array onto model feature names.

        The contract order is imported from the reference extractor rather than
        duplicated here, so the two can never drift.
        """
        from app.services.features import FEATURE_NAMES as CONTRACT_FEATURE_NAMES

        if len(CONTRACT_FEATURE_NAMES) != len(values):
            raise FeatureVectorError(
                f"contract feature list has {len(CONTRACT_FEATURE_NAMES)} names "
                f"but {len(values)} values were supplied"
            )

        unknown = [name for name in self._feature_names if name not in CONTRACT_FEATURE_NAMES]
        if unknown:
            raise FeatureVectorError(
                "model consumes features that are absent from the current feature "
                f"contract, so positional mapping is unsafe: {unknown}"
            )

        return dict(zip(CONTRACT_FEATURE_NAMES, values))

    # -- self-check --------------------------------------------------------

    def verify_parity(
        self,
        fixture_path: Path | str | None = None,
        tolerance: float = DEFAULT_PARITY_TOLERANCE,
    ) -> ParityReport | None:
        """Re-score ``ml/models/parity_fixture.json`` and report the worst error.

        Returns ``None`` when the fixture is absent (it is a development
        artifact, not a runtime requirement).
        """
        if not self.is_loaded:
            raise ModelNotLoadedError("model not loaded")

        path = Path(fixture_path or self._config.parity_fixture_path)
        if not path.is_file():
            return None

        payload = json.loads(path.read_text(encoding="utf-8"))
        cases = payload.get("cases") if isinstance(payload, dict) else None
        if not isinstance(cases, list):
            raise ModelArtifactError(f"parity fixture has no `cases` array: {path}")

        max_diff = 0.0
        for index, case in enumerate(cases):
            features = case.get("features")
            expected = case.get("expectedGoodProbability")
            if not isinstance(features, list) or len(features) != self._n_features:
                raise ModelArtifactError(
                    f"parity fixture case {index} has "
                    f"{len(features) if isinstance(features, list) else 'no'} features; "
                    f"the model consumes {self._n_features}"
                )
            if not _is_finite_number(expected):
                raise ModelArtifactError(
                    f"parity fixture case {index} has no numeric expectedGoodProbability"
                )
            actual = self.predict(features).good_probability
            max_diff = max(max_diff, abs(actual - float(expected)))  # type: ignore[arg-type]

        report = ParityReport(
            n_cases=len(cases), max_abs_diff=max_diff, tolerance=tolerance
        )
        self._parity = report
        return report
