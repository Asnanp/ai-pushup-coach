"""Test bootstrap.

Adds ``apps/api`` to ``sys.path`` so ``import app...`` works when pytest is
invoked from the repository root:

    python -m pytest apps/api/tests -q
"""

from __future__ import annotations

import sys
from pathlib import Path

API_ROOT = Path(__file__).resolve().parents[1]

if str(API_ROOT) not in sys.path:
    sys.path.insert(0, str(API_ROOT))
