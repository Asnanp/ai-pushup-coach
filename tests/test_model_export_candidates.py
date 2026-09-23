"""All model candidates must keep P(good) intact in browser JSON."""
from __future__ import annotations

import sys
import json
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "ml" / "scripts"))

from export_model import export_forest, export_gbm, export_logistic, score_export, unwrap  # noqa: E402
from train_v2_model import candidate_factories  # noqa: E402
import generate_model_summary as summary  # noqa: E402


@pytest.mark.parametrize("name", ["random_forest", "gradient_boosting", "logistic_regression"])
def test_candidate_export_matches_sklearn_good_probability(name: str) -> None:
    rng = np.random.default_rng(17)
    X = rng.normal(size=(90, 6))
    y = (X[:, 0] + 0.4 * X[:, 1] < 0).astype(int)  # 0 = good
    model = candidate_factories()[name]()
    model.fit(X[:70], y[:70])
    estimator, scaler = unwrap(model)
    exported = {
        "random_forest": lambda: export_forest(estimator),
        "gradient_boosting": lambda: export_gbm(estimator),
        "logistic_regression": lambda: export_logistic(estimator, scaler),
    }[name]()

    expected = model.predict_proba(X[70:])[:, list(model.classes_).index(0)]
    actual = np.array([score_export(exported, row, 0) for row in X[70:]])
    np.testing.assert_allclose(actual, expected, atol=1e-6)


def test_shipped_summary_uses_browser_metadata(monkeypatch: pytest.MonkeyPatch) -> None:
    content = json.dumps({
        "model_type": "RandomForestClassifier",
        "decision_threshold": 0.58,
        "metrics": {"accuracy": 0.7463, "macro_f1": 0.7412},
    })
    written: dict[str, str] = {}

    class FakePath:
        def exists(self) -> bool:
            return True

        def read_text(self, **_kwargs) -> str:
            return content

        def write_text(self, value: str, **_kwargs) -> None:
            written["value"] = value

        def __str__(self) -> str:
            return "model-audit-summary.json"

    fake_path = FakePath()
    monkeypatch.setattr(summary, "META_JSON", fake_path)
    monkeypatch.setattr(summary, "MODEL_JSON", fake_path)
    monkeypatch.setattr(summary, "OUT_JSON", fake_path)
    monkeypatch.setattr(summary, "sha256", lambda _path: "test-checksum")
    summary.main()
    result = json.loads(written["value"])
    assert result["decision_threshold"] == 0.58
    assert result["test_metrics"]["accuracy"] == 0.7463
