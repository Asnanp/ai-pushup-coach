"""
Generate ml/reports/shipped_model_summary.json from active model artifacts.

Authoritative machine-readable source for published metrics.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MODEL_JSON = ROOT / "ml" / "models" / "pushup_form_model.json"
META_JSON = ROOT / "ml" / "models" / "pushup_form_model.metadata.json"
OUT_JSON = ROOT / "ml" / "reports" / "shipped_model_summary.json"


def sha256(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else ""


def main():
    if not META_JSON.exists():
        raise FileNotFoundError(f"Missing {META_JSON}")

    meta = json.loads(META_JSON.read_text(encoding="utf-8"))
    
    # The browser loads this metadata with these weights. An experiment report
    # can describe a different run, so it must never override shipped metrics.
    test_metrics = meta.get("metrics", {})
    threshold = meta.get("decision_threshold", 0.5)

    summary = {
        "model_type": meta.get("model_type", ""),
        "feature_spec_version": meta.get("feature_spec_version", 1),
        "n_features": meta.get("n_features", len(meta.get("feature_names", []))),
        "decision_threshold": threshold,
        "positive_class": meta.get("positive_class", 0),
        "positive_class_meaning": meta.get("positive_class_meaning", "P(good form)"),
        "test_metrics": {
            "accuracy": test_metrics.get("accuracy", 0.0),
            "macro_f1": test_metrics.get("macro_f1", 0.0),
            "roc_auc": test_metrics.get("roc_auc", 0.0),
            "precision_good": test_metrics.get("precision_good", 0.0),
            "recall_good": test_metrics.get("recall_good", 0.0),
            "f1_good": test_metrics.get("f1_good", 0.0),
            "precision_bad": test_metrics.get("precision_bad", 0.0),
            "recall_bad": test_metrics.get("recall_bad", 0.0),
            "f1_bad": test_metrics.get("f1_bad", 0.0),
            "confusion_matrix": test_metrics.get("confusion_matrix", []),
        },
        "per_view": meta.get("per_view", {}),
        "per_subject": meta.get("per_subject", {}),
        "feature_names": meta.get("feature_names", []),
        "excluded_capture_features": meta.get("excluded_capture_features", []),
        "checksums": {
            "pushup_form_model.json": sha256(MODEL_JSON),
            "pushup_form_model.metadata.json": sha256(META_JSON),
        }
    }

    OUT_JSON.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(f"Wrote authoritative summary to {OUT_JSON}")


if __name__ == "__main__":
    main()
