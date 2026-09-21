"""Filesystem layout constants (stdlib only).

Kept separate from ``app.config`` so that the scoring core
(``app.services.model_service``) and the parity test can be imported and run
without pydantic-settings installed.

    <repo>/apps/api/app/paths.py
      parents[0] = <repo>/apps/api/app
      parents[1] = <repo>/apps/api
      parents[2] = <repo>/apps
      parents[3] = <repo>
"""

from __future__ import annotations

from pathlib import Path

APP_DIR: Path = Path(__file__).resolve().parent
API_DIR: Path = APP_DIR.parent
APPS_DIR: Path = API_DIR.parent
REPO_ROOT: Path = APPS_DIR.parent

ML_DIR: Path = REPO_ROOT / "ml"
ML_SRC_DIR: Path = ML_DIR / "src"
MODELS_DIR: Path = ML_DIR / "models"

DEFAULT_MODEL_JSON_PATH: Path = MODELS_DIR / "pushup_form_model.json"
DEFAULT_MODEL_METADATA_PATH: Path = MODELS_DIR / "pushup_form_model.metadata.json"
DEFAULT_PARITY_FIXTURE_PATH: Path = MODELS_DIR / "parity_fixture.json"
