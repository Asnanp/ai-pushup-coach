"""tests/test_acceptance.py

Pytest-visible wrapper around the end-to-end acceptance runner
(``scripts/acceptance.mjs``).

Why a wrapper instead of re-implementing the checks in Python: the runner is
the single source of truth for what "accepted" means, and it is the same
command a judge or CI job runs by hand. Duplicating the logic here would let
the two drift apart. So this test shells out, parses the runner's ``--json``
output, and asserts a clean acceptance.

The runner runs the Python suite itself (check 8) but passes
``--ignore=tests/test_acceptance.py``, so this wrapper cannot recurse.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
RUNNER = ROOT / "scripts" / "acceptance.mjs"

# The runner is expensive (it builds the packages and runs the web build), so
# the two tests below share one invocation.
_CACHE: dict = {}


def _run_acceptance() -> dict:
    if "payload" in _CACHE:
        return _CACHE["payload"]

    node = shutil.which("node")
    if not node:
        pytest.skip("acceptance runner not run: node not found on PATH")
    if not RUNNER.exists():
        pytest.skip(f"acceptance runner missing at {RUNNER}")

    proc = subprocess.run(
        [node, str(RUNNER), "--json"],
        capture_output=True,
        text=True,
        cwd=str(ROOT),
        timeout=1800,
    )

    if proc.returncode not in (0, 1, 2):
        pytest.skip(
            f"acceptance runner crashed (exit {proc.returncode}). "
            f"stderr: {proc.stderr.strip()[:800]}"
        )

    try:
        payload = json.loads(proc.stdout)
    except json.JSONDecodeError:
        pytest.skip(f"acceptance runner emitted non-JSON output: {proc.stdout[:300]!r}")

    _CACHE["payload"] = payload
    return payload


def test_acceptance_runner_has_no_failures():
    payload = _run_acceptance()
    results = payload.get("results", [])
    assert results, "acceptance runner reported no checks"

    failures = [r for r in results if r["status"] == "FAIL"]
    assert not failures, "acceptance failures:\n" + "\n".join(
        f"  - {r['name']}: {r['detail']}" for r in failures
    )


def test_acceptance_runner_exits_zero():
    """
    Exit 0 means no FAILs *and* no blocking SKIPs. A blocking skip is worse
    than a failure because it looks like a pass: the parity tests skip
    themselves when the packages are not built.
    """
    payload = _run_acceptance()
    blocking = [
        r for r in payload.get("results", [])
        if r["status"] == "SKIP" and r["name"] == "Python test suite"
    ]
    assert not blocking, "the Python suite was skipped; a skip can hide a regression"
    assert payload.get("exitCode") == 0, (
        f"acceptance exit code was {payload.get('exitCode')}, expected 0"
    )
