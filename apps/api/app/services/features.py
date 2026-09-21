"""Thin wrapper around the reference feature extractor.

The single source of truth for the 37-feature contract is
``ml/src/features.py`` (which itself mirrors ``packages/biomechanics``). Rather
than copying that file — which would create a second implementation free to
drift — this module puts ``ml/src`` on ``sys.path`` and re-exports the reference
public API.

Nothing here is used by the live scoring path: ``/predict`` receives an already
aggregated feature vector. The extractor is exposed so offline evaluation and
retraining verification can build vectors from raw landmarks without importing
``ml`` as a package.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Sequence

from app.paths import ML_SRC_DIR

_REFERENCE_PATH: Path = ML_SRC_DIR / "features.py"

if str(ML_SRC_DIR) not in sys.path:
    # Appended to the front so `import features` resolves to the reference
    # module even if an unrelated top-level module of that name is installed.
    sys.path.insert(0, str(ML_SRC_DIR))

try:  # pragma: no cover - exercised indirectly by the test suite
    import features as _reference
except ImportError as exc:  # pragma: no cover
    raise ImportError(
        f"could not import the reference feature extractor from {_REFERENCE_PATH}. "
        "It requires numpy; install apps/api/requirements.txt."
    ) from exc

if Path(_reference.__file__).resolve() != _REFERENCE_PATH.resolve():  # pragma: no cover
    raise ImportError(
        "imported a module named `features` that is not the reference extractor: "
        f"{_reference.__file__} (expected {_REFERENCE_PATH})"
    )

# --- re-exported reference API ---------------------------------------------

FEATURE_SPEC_VERSION: int = _reference.FEATURE_SPEC_VERSION
FEATURE_NAMES: list[str] = _reference.FEATURE_NAMES
N_FEATURES: int = _reference.N_FEATURES
MIN_VISIBILITY: float = _reference.MIN_VISIBILITY
SIDE_SWITCH_MARGIN: float = _reference.SIDE_SWITCH_MARGIN

Landmark = _reference.Landmark
FrameFeatures = _reference.FrameFeatures

aggregate_rep_window = _reference.aggregate_rep_window
extract_frame_features = _reference.extract_frame_features
choose_side = _reference.choose_side
side_visibility = _reference.side_visibility
torso_frame = _reference.torso_frame
normalize_points = _reference.normalize_points
signed_body_line_deviation = _reference.signed_body_line_deviation


def rep_window_vector(
    frames: Sequence["FrameFeatures"],
    total_frames_in_window: int | None = None,
) -> tuple[list[float], dict[str, float]]:
    """Aggregate one rep window into a plain 37-length list.

    Convenience over the reference ``aggregate_rep_window``, which returns a
    numpy array; the API and its JSON responses deal in plain floats.
    """
    vector, raw = aggregate_rep_window(frames, total_frames_in_window)
    return [float(value) for value in vector], dict(raw)


__all__ = [
    "FEATURE_SPEC_VERSION",
    "FEATURE_NAMES",
    "N_FEATURES",
    "MIN_VISIBILITY",
    "SIDE_SWITCH_MARGIN",
    "Landmark",
    "FrameFeatures",
    "aggregate_rep_window",
    "extract_frame_features",
    "choose_side",
    "side_visibility",
    "torso_frame",
    "normalize_points",
    "signed_body_line_deviation",
    "rep_window_vector",
]
