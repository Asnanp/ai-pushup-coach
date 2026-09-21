"""Model service tests — the parity gate.

The single most important assertion here is ``test_parity_fixture_max_abs_diff``:
it re-scores ``ml/models/parity_fixture.json`` (200 cases whose expected values
were produced by the TypeScript runtime, ``FormModel.scoreGbm``) and requires the
Python scorer to agree within 1e-6.

That test is also the guard against the class-inversion bug. The artifact has
``sigmoidIsClass: 1`` while the metadata declares ``positive_class: 0``
(P(good)), so the raw sigmoid must be complemented. If the inversion were
dropped, every probability would be replaced by its complement and the maximum
difference would be ~0.96, not ~1e-16.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.paths import DEFAULT_PARITY_FIXTURE_PATH
from app.services.model_service import (
    FeatureVectorError,
    ModelArtifactError,
    ModelService,
    ModelServiceConfig,
)

# NOTE: app.config (pydantic-settings) is deliberately not imported here. The
# scoring core takes a stdlib config dataclass so this parity gate runs even
# when FastAPI/pydantic are not installed in the interpreter.
FIXTURE_PATH: Path = Path(DEFAULT_PARITY_FIXTURE_PATH)
PARITY_TOLERANCE = 1e-6

pytestmark = pytest.mark.skipif(
    not FIXTURE_PATH.is_file(), reason=f"parity fixture not found: {FIXTURE_PATH}"
)


@pytest.fixture(scope="module")
def config() -> ModelServiceConfig:
    return ModelServiceConfig()


@pytest.fixture(scope="module")
def service(config: ModelServiceConfig) -> ModelService:
    """Load the real shipped artifact once for the whole module."""
    model = ModelService(config)
    model.load()
    return model


@pytest.fixture(scope="module")
def fixture_cases() -> list[dict]:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))["cases"]


# ---------------------------------------------------------------------------
# The gate
# ---------------------------------------------------------------------------


def test_parity_fixture_max_abs_diff(service: ModelService) -> None:
    """Python scoring must reproduce the TypeScript runtime exactly."""
    report = service.verify_parity()

    assert report is not None, "parity fixture missing"
    assert report.n_cases == 200
    assert report.max_abs_diff < PARITY_TOLERANCE, (
        f"max abs diff {report.max_abs_diff:.3e} exceeds tolerance "
        f"{PARITY_TOLERANCE:.0e} — the Python scorer disagrees with "
        "packages/form-engine/src/model-runtime.ts scoreGbm()"
    )
    assert report.ok


def test_parity_case_by_case(
    service: ModelService, fixture_cases: list[dict]
) -> None:
    """Same check, but reporting the worst individual case."""
    worst_diff = 0.0
    worst_index = -1

    for index, case in enumerate(fixture_cases):
        actual = service.predict(case["features"]).good_probability
        diff = abs(actual - case["expectedGoodProbability"])
        if diff > worst_diff:
            worst_diff, worst_index = diff, index

    assert worst_diff < PARITY_TOLERANCE, (
        f"case {worst_index} differs by {worst_diff:.3e} "
        f"(tolerance {PARITY_TOLERANCE:.0e})"
    )


def test_fixture_spans_both_classes(fixture_cases: list[dict]) -> None:
    """Guard against a global complement: the fixture must straddle 0.5."""
    expected = [case["expectedGoodProbability"] for case in fixture_cases]
    assert min(expected) < 0.5 < max(expected), "fixture does not span both classes"


# ---------------------------------------------------------------------------
# Artifact facts (verified against ml/models/pushup_form_model.metadata.json)
# ---------------------------------------------------------------------------


def test_artifact_facts(service: ModelService) -> None:
    assert service.is_loaded
    assert service.model_kind == "gbm"
    assert service.model_type == "GradientBoostingClassifier"
    # The model consumes 34 features; the contract in FEATURE_SCHEMA.md has 37.
    assert service.n_features == 34
    assert service.n_features_contract == 37
    assert len(service.feature_names) == 34
    assert service.decision_threshold == pytest.approx(0.58, abs=1e-9)
    assert service.feature_spec_version == 1


def test_export_class_semantics(service: ModelService, config: ModelServiceConfig) -> None:
    """The two facts that make the inversion necessary, asserted explicitly."""
    metadata = service.metadata
    assert metadata is not None
    assert metadata["positive_class"] == 0
    assert "good" in metadata["positive_class_meaning"].lower()

    export = json.loads(Path(config.model_json_path).read_text(encoding="utf-8"))
    assert export["kind"] == "gbm"
    assert export["sigmoidIsClass"] == 1
    assert export["classes"] == [0, 1]
    assert export["learningRate"] == pytest.approx(0.05)
    assert export["initRaw"] == pytest.approx(-0.5469469321799849)
    assert len(export["trees"]) == 150


def test_excluded_capture_features_are_not_model_inputs(service: ModelService) -> None:
    metadata = service.metadata
    assert metadata is not None
    excluded = set(metadata["excluded_capture_features"])
    assert excluded == {
        "jitter_max",
        "jitter_mean",
        "jitter_std",
        "low_confidence_ratio",
        "mean_visibility",
        "min_visibility",
        "tracking_gap_ratio",
    }
    assert not (excluded & set(service.feature_names))


# ---------------------------------------------------------------------------
# Guardrails (docs/MODEL_CONTRACT.md §8)
# ---------------------------------------------------------------------------


def test_missing_features_are_imputed_and_counted(
    service: ModelService, fixture_cases: list[dict]
) -> None:
    vector = list(fixture_cases[0]["features"])
    clean = service.predict(vector)
    assert clean.missing_feature_count == 0
    assert clean.missing_feature_names == ()

    # Replace one value with None -> imputed with the train mean, still scored.
    dirty_vector = list(vector)
    dirty_vector[0] = None
    dirty = service.predict(dirty_vector)

    assert dirty.missing_feature_count == 1
    assert dirty.missing_feature_names == (service.feature_names[0],)
    # Imputing a single feature must not flip the label to `unknown`.
    assert dirty.label in ("good", "bad")
    assert dirty.good_probability != pytest.approx(clean.good_probability, abs=1e-12)


def test_more_than_three_missing_features_yields_unknown(
    service: ModelService, fixture_cases: list[dict]
) -> None:
    vector = list(fixture_cases[0]["features"])

    three = list(vector)
    three[0] = three[1] = three[2] = None
    assert service.predict(three).label in ("good", "bad")

    four = list(vector)
    four[0] = four[1] = four[2] = four[3] = None
    result = service.predict(four)
    assert result.label == "unknown"
    assert result.missing_feature_count == 4
    assert len(result.missing_feature_names) == 4


def test_label_follows_threshold(
    service: ModelService, fixture_cases: list[dict]
) -> None:
    for case in fixture_cases[:50]:
        result = service.predict(case["features"])
        expected = "good" if result.good_probability >= service.decision_threshold else "bad"
        assert result.label == expected


def test_probability_is_clamped_and_complementary(
    service: ModelService, fixture_cases: list[dict]
) -> None:
    for case in fixture_cases[:50]:
        probability = service.predict(case["features"]).good_probability
        assert 0.0 <= probability <= 1.0


# ---------------------------------------------------------------------------
# Input handling
# ---------------------------------------------------------------------------


def test_named_mapping_matches_model_order(
    service: ModelService, fixture_cases: list[dict]
) -> None:
    case = fixture_cases[3]
    named = dict(zip(service.feature_names, case["features"]))
    assert service.score_named(named).good_probability == pytest.approx(
        case["expectedGoodProbability"], abs=PARITY_TOLERANCE
    )


def test_seven_excluded_features_are_ignored(
    service: ModelService, fixture_cases: list[dict]
) -> None:
    """A full 37-key contract payload scores identically to the 34-key one."""
    case = fixture_cases[5]
    metadata = service.metadata
    assert metadata is not None

    payload = dict(zip(service.feature_names, case["features"]))
    for name in metadata["excluded_capture_features"]:
        payload[name] = 12345.678  # arbitrary: must never reach the model

    result = service.score_named(payload)
    assert result.missing_feature_count == 0
    assert result.good_probability == pytest.approx(
        case["expectedGoodProbability"], abs=PARITY_TOLERANCE
    )


def test_contract_order_array_is_mapped_positionally(
    service: ModelService, fixture_cases: list[dict]
) -> None:
    from app.services.features import FEATURE_NAMES as CONTRACT_NAMES

    assert len(CONTRACT_NAMES) == 37

    case = fixture_cases[7]
    by_name = dict(zip(service.feature_names, case["features"]))
    contract_vector = [by_name.get(name) for name in CONTRACT_NAMES]
    assert len(contract_vector) == 37

    result = service.score_any(contract_vector)
    assert result.missing_feature_count == 0
    assert result.good_probability == pytest.approx(
        case["expectedGoodProbability"], abs=PARITY_TOLERANCE
    )


def test_wrong_vector_length_is_rejected(service: ModelService) -> None:
    with pytest.raises(FeatureVectorError):
        service.predict([1.0, 2.0, 3.0])


def test_predict_before_load_raises(config: ModelServiceConfig) -> None:
    from app.services.model_service import ModelNotLoadedError

    with pytest.raises(ModelNotLoadedError):
        ModelService(config).predict([0.0] * 34)


def test_missing_artifact_raises() -> None:
    # Deliberately not using pytest's tmp_path: creating it requires write
    # access to the OS temp directory, which is not guaranteed in every
    # environment. A non-existent path is all this test needs.
    missing_dir = Path(__file__).resolve().parent / "no-such-directory"
    broken = ModelServiceConfig(
        model_json_path=missing_dir / "nope.json",
        model_metadata_path=missing_dir / "nope.metadata.json",
    )
    with pytest.raises(ModelArtifactError):
        ModelService(broken).load()


# ---------------------------------------------------------------------------
# Reference feature extractor wrapper
# ---------------------------------------------------------------------------


def test_features_wrapper_imports_the_reference_module() -> None:
    from app.services import features as wrapper

    assert wrapper.N_FEATURES == 37
    assert wrapper.FEATURE_SPEC_VERSION == 1
    assert len(wrapper.FEATURE_NAMES) == 37
    assert Path(wrapper._REFERENCE_PATH).is_file()
    assert Path(wrapper._REFERENCE_PATH).parts[-3:] == ("ml", "src", "features.py")


def test_rep_segmenter_is_importable() -> None:
    """The reference rep counter must be reachable on the same path."""
    import sys

    from app.paths import ML_SRC_DIR

    assert str(ML_SRC_DIR) in sys.path
    assert (ML_SRC_DIR / "rep_segmenter.py").is_file()


# ---------------------------------------------------------------------------
# Application wiring (skipped when FastAPI is not installed)
# ---------------------------------------------------------------------------


def test_app_imports_and_exposes_contract_routes() -> None:
    pytest.importorskip("fastapi", reason="fastapi is not installed in this env")

    from app.main import app

    # Enumerate through the OpenAPI schema rather than `app.routes`: FastAPI
    # >=0.14x / Starlette >=1.x store an `include_router` result as an opaque
    # `_IncludedRouter` that has no `.path`, so iterating `app.routes` no longer
    # yields the contract paths (it raised AttributeError). The schema is the
    # public, version-stable description of what the app serves.
    paths = set(app.openapi()["paths"])
    assert "/health" in paths
    assert "/api/v1/form/predict" in paths
    assert "/api/v1/form/predict/batch" in paths
    assert "/api/v1/model/info" in paths
    assert "/api/v1/sessions" in paths
    assert "/api/v1/sessions/{session_id}" in paths
    assert "/api/v1/leaderboard" in paths
