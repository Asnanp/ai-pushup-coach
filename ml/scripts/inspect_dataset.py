"""
scripts/inspect_dataset.py

Agent 9 — DATASET ENGINEER

Inspects the push_up dataset, validates every video, extracts subject IDs, and
produces a subject-independent train/val/test split.

Outputs:
    ml/data/dataset_manifest.csv    one row per video, with probe metadata
    ml/data/splits/dataset_split.json   authoritative split record

Run:
    python ml/scripts/inspect_dataset.py
"""

from __future__ import annotations

import csv
import hashlib
import json
import re
import subprocess
import sys
from dataclasses import dataclass, asdict
from pathlib import Path

# --------------------------------------------------------------------------
# Paths
# --------------------------------------------------------------------------

SCRIPT_DIR = Path(__file__).resolve().parent
ML_DIR = SCRIPT_DIR.parent
PROJECT_DIR = ML_DIR.parent
REPO_ROOT = PROJECT_DIR.parent

# Dataset lives outside the repo, in the workspace root.
DATASET_ROOT_CANDIDATES = [
    REPO_ROOT / "push_up",
    PROJECT_DIR / "push_up",
    Path.cwd() / "push_up",
]

DATA_DIR = ML_DIR / "data"
SPLITS_DIR = DATA_DIR / "splits"
MANIFEST_PATH = DATA_DIR / "dataset_manifest.csv"
SPLIT_PATH = SPLITS_DIR / "dataset_split.json"

FILENAME_RE = re.compile(
    r"^subject_(?P<subject>\d+)_(?P<exercise>[a-z_]+)_(?P<quality>good|bad)_(?P<view>front|side|diagonal)\.mp4$"
)

VALID_VIEWS = {"front", "side", "diagonal"}
VALID_QUALITIES = {"good", "bad"}

# Split fractions per spec (~65-70 / 15-20 / 15-20).
TRAIN_FRACTION = 0.667
VAL_FRACTION = 0.167
# remainder -> test


# --------------------------------------------------------------------------
# Data model
# --------------------------------------------------------------------------


@dataclass
class VideoRecord:
    path: str
    filename: str
    subject: str
    quality: str
    view: str
    split: str
    width: int
    height: int
    fps: float
    nb_frames: int
    duration_s: float
    size_bytes: int
    readable: bool
    error: str


def resolve_dataset_root() -> Path:
    for candidate in DATASET_ROOT_CANDIDATES:
        if candidate.is_dir() and (candidate / "good").is_dir():
            return candidate
    raise SystemExit(
        "Could not locate the push_up dataset. Looked in:\n  "
        + "\n  ".join(str(c) for c in DATASET_ROOT_CANDIDATES)
    )


def probe_video(path: Path) -> dict:
    """ffprobe a video; return metadata or an error marker."""
    cmd = [
        "ffprobe", "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height,r_frame_rate,nb_frames,duration",
        "-of", "json",
        str(path),
    ]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        if out.returncode != 0:
            return {"readable": False, "error": out.stderr.strip()[:200]}
        import json as _json

        payload = _json.loads(out.stdout)
        streams = payload.get("streams", [])
        if not streams:
            return {"readable": False, "error": "no video stream"}
        s = streams[0]

        # r_frame_rate is "num/den"
        fps = 0.0
        rfr = s.get("r_frame_rate", "0/1")
        if "/" in rfr:
            num, den = rfr.split("/")
            fps = float(num) / float(den) if float(den) else 0.0
        elif rfr:
            fps = float(rfr)

        nb = int(s.get("nb_frames") or 0)
        dur = float(s.get("duration") or 0.0)
        if dur == 0.0 and fps > 0 and nb > 0:
            dur = nb / fps

        return {
            "readable": True,
            "error": "",
            "width": int(s.get("width") or 0),
            "height": int(s.get("height") or 0),
            "fps": round(fps, 3),
            "nb_frames": nb,
            "duration_s": round(dur, 3),
        }
    except FileNotFoundError:
        return {"readable": False, "error": "ffprobe not found on PATH"}
    except subprocess.TimeoutExpired:
        return {"readable": False, "error": "ffprobe timeout"}
    except Exception as exc:  # noqa: BLE001
        return {"readable": False, "error": f"{type(exc).__name__}: {exc}"[:200]}


# --------------------------------------------------------------------------
# Subject-independent splitting
# --------------------------------------------------------------------------


def _stable_rank(subject_id: str) -> str:
    """Hash a subject ID. Used to order subjects in a way that is independent of
    their numeric ID (so numbering order cannot correlate with recording
    session/environment and leak scene information across splits)."""
    return hashlib.sha256(f"aipc-split-v1::{subject_id}".encode()).hexdigest()


# Exact allocation for 24 subjects, giving 16/6/2 -> adjusted below.
# Pure hash banding on a 24-subject set is too coarse: it produced a 2-subject
# test split, which is too small to report trustworthy metrics on. We therefore
# sort subjects by hash and cut at fixed positions, guaranteeing exact sizes
# while keeping the *assignment* independent of subject numbering.
SPLIT_SIZES = {"train": 16, "validation": 4, "test": 4}


def build_split_map(subjects: list[str]) -> dict[str, str]:
    """
    Deterministically allocate subjects to train/validation/test.

    Subjects are ordered by hash (deterministic, independent of ID order) and
    then cut into fixed-size groups so the split sizes are exactly 16/4/4 = 67/17/17%.
    """
    ordered = sorted(subjects, key=_stable_rank)

    mapping: dict[str, str] = {}
    idx = 0
    for split_name in ("train", "validation", "test"):
        size = SPLIT_SIZES[split_name]
        for subject in ordered[idx : idx + size]:
            mapping[subject] = split_name
        idx += size

    # Any leftover subjects (if the dataset grows) go to train.
    for subject in ordered[idx:]:
        mapping[subject] = "train"

    return mapping


def main() -> int:
    dataset_root = resolve_dataset_root()
    print(f"Dataset root: {dataset_root}")

    SPLITS_DIR.mkdir(parents=True, exist_ok=True)

    records: list[VideoRecord] = []
    problems: list[str] = []
    unknown_names: list[str] = []

    # First pass: discover all subjects so the split map can be built globally.
    discovered: list[str] = []
    for quality in ("good", "bad"):
        for view in ("front", "side", "diagonal"):
            folder = dataset_root / quality / view
            if folder.is_dir():
                for video in folder.glob("*.mp4"):
                    m = FILENAME_RE.match(video.name)
                    if m and m.group("subject") not in discovered:
                        discovered.append(m.group("subject"))

    if not discovered:
        print("ERROR: no videos found.", file=sys.stderr)
        return 1

    split_map = build_split_map(sorted(discovered))

    for quality in ("good", "bad"):
        for view in ("front", "side", "diagonal"):
            folder = dataset_root / quality / view
            if not folder.is_dir():
                problems.append(f"MISSING FOLDER: {folder}")
                continue

            for video in sorted(folder.glob("*.mp4")):
                m = FILENAME_RE.match(video.name)
                if not m:
                    unknown_names.append(video.name)
                    continue

                subject = m.group("subject")
                split = split_map[subject]
                info = probe_video(video)

                rec = VideoRecord(
                    path=str(video.relative_to(REPO_ROOT)).replace("\\", "/"),
                    filename=video.name,
                    subject=subject,
                    quality=m.group("quality"),
                    view=m.group("view"),
                    split=split,
                    width=info.get("width", 0),
                    height=info.get("height", 0),
                    fps=info.get("fps", 0.0),
                    nb_frames=info.get("nb_frames", 0),
                    duration_s=info.get("duration_s", 0.0),
                    size_bytes=video.stat().st_size,
                    readable=bool(info.get("readable", False)),
                    error=info.get("error", ""),
                )
                records.append(rec)

                if not rec.readable:
                    problems.append(f"UNREADABLE: {rec.filename} -> {rec.error}")

    if not records:
        print("ERROR: no videos found.", file=sys.stderr)
        return 1

    # ---------------- manifest ----------------
    fields = list(asdict(records[0]).keys())
    with MANIFEST_PATH.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields)
        writer.writeheader()
        for rec in records:
            writer.writerow(asdict(rec))

    # ---------------- summary ----------------
    subjects = sorted({r.subject for r in records})
    by_split: dict[str, list[str]] = {"train": [], "validation": [], "test": []}
    for s in subjects:
        by_split[split_map[s]].append(s)

    counts = {"good": 0, "bad": 0}
    by_view = {v: 0 for v in VALID_VIEWS}
    for r in records:
        counts[r.quality] += 1
        by_view[r.view] += 1

    split_summary = {}
    for name, subs in by_split.items():
        sub_set = set(subs)
        rows = [r for r in records if r.subject in sub_set]
        good = sum(1 for r in rows if r.quality == "good")
        bad = sum(1 for r in rows if r.quality == "bad")
        split_summary[name] = {
            "subjects": subs,
            "n_subjects": len(subs),
            "n_videos": len(rows),
            "n_good": good,
            "n_bad": bad,
            "views": {v: sum(1 for r in rows if r.view == v) for v in VALID_VIEWS},
        }

    split_payload = {
        "version": 1,
        "strategy": "subject-independent, sha256-hash-banded",
        "dataset_root": str(dataset_root),
        "total_videos": len(records),
        "total_subjects": len(subjects),
        "all_subjects": subjects,
        "splits": split_summary,
        "fractions": {
            "train": TRAIN_FRACTION,
            "validation": VAL_FRACTION,
            "test": round(1.0 - TRAIN_FRACTION - VAL_FRACTION, 4),
        },
    }
    SPLIT_PATH.write_text(json.dumps(split_payload, indent=2), encoding="utf-8")

    # ---------------- report ----------------
    print()
    print("=" * 62)
    print("DATASET INSPECTION SUMMARY")
    print("=" * 62)
    print(f"  Total videos   : {len(records)}")
    print(f"  Readable       : {sum(1 for r in records if r.readable)}")
    print(f"  Unreadable     : {sum(1 for r in records if not r.readable)}")
    print(f"  Unique subjects: {len(subjects)}")
    print(f"  good / bad     : {counts['good']} / {counts['bad']}")
    print(f"  views          : {by_view}")
    print()
    print("  SPLIT (subject-independent)")
    for name in ("train", "validation", "test"):
        s = split_summary[name]
        pct = 100.0 * s["n_subjects"] / len(subjects)
        print(
            f"    {name:11s} {s['n_subjects']:2d} subjects ({pct:5.1f}%)  "
            f"{s['n_videos']:3d} videos  good={s['n_good']:3d} bad={s['n_bad']:3d}"
        )
        print(f"                subjects: {', '.join(s['subjects'])}")
    print()

    # leakage check
    train_set = set(by_split["train"])
    val_set = set(by_split["validation"])
    test_set = set(by_split["test"])
    leaks = []
    if train_set & val_set:
        leaks.append(f"train/val {sorted(train_set & val_set)}")
    if train_set & test_set:
        leaks.append(f"train/test {sorted(train_set & test_set)}")
    if val_set & test_set:
        leaks.append(f"val/test {sorted(val_set & test_set)}")

    if leaks:
        print(f"  !! SUBJECT LEAKAGE: {'; '.join(leaks)}")
        print("     Fix the hashing bands before training.")
    else:
        print("  [OK] No subject leakage between splits.")

    if unknown_names:
        print(f"\n  Unrecognised filenames ({len(unknown_names)}):")
        for n in unknown_names[:10]:
            print(f"    {n}")

    if problems:
        print(f"\n  Problems ({len(problems)}):")
        for p in problems[:20]:
            print(f"    {p}")

    print()
    print(f"  manifest -> {MANIFEST_PATH}")
    print(f"  split    -> {SPLIT_PATH}")

    return 0 if not leaks and not problems else 2


if __name__ == "__main__":
    raise SystemExit(main())
