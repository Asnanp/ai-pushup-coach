"""AI Push-Up Coach — FastAPI backend (Agent 14).

The browser is the primary inference path (packages/form-engine). This service
exists for batch evaluation, retraining verification, and environments where the
JS model cannot load, plus optional session/leaderboard persistence.

Contract sources:
  - docs/API_CONTRACT.md      request/response shapes
  - docs/DATABASE_SCHEMA.md   table and column names
  - docs/MODEL_CONTRACT.md    artifact format, scoring semantics, guardrails
"""

__all__ = ["__version__"]

__version__ = "1.0.0"
