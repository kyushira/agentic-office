"""Agent Office projects: a read-only list of the folders under /opt/data/projects.

One card per project folder: its last commit (a read-only `git log`), its briefs under _briefs/, a status from
the newest of those, and the optional projects.json registry, which is the only source of owner and next step.
Nothing is written. Every string that leaves this module passes through redact.redact.
"""
from __future__ import annotations

import importlib.util
import json
import subprocess
import time
from pathlib import Path


def _load(name: str):
    spec = importlib.util.spec_from_file_location(f"agent_office_{name}", Path(__file__).with_name(f"{name}.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


redact = _load("redact")

ROOT = "/opt/data/projects"
DAY = 86400.0
ACTIVE_SECS = 3 * DAY       # newer than this: active
QUIET_SECS = 7 * DAY        # up to this: quiet; older: stale
GIT_TIMEOUT = 3
SUBJECT_CAP, BRANCH_CAP, BRIEF_NAME_CAP = 80, 80, 120
OWNER_CAP, NEXT_CAP = 80, 200
BRIEF_CAP = 8
BRIEF_SUFFIXES = (".md", ".txt", ".json")
LOG_ARGS = ["log", "--all", "-1", "--format=%ct%x1f%s%x1f%D"]


def _clean(text, limit=None) -> str:
    return redact.redact(str(text), limit)


def _skipped(name: str) -> bool:
    return name.startswith(("_", ".")) or name == "worktrees" or name.endswith("-wt")


def _mtime(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


def _branch(refs: str) -> str | None:
    """Branch from git's %D decoration: 'HEAD -> main, origin/main' gives 'main'. Tags are ignored."""
    names = [r.strip() for r in refs.split(",") if r.strip() and not r.strip().startswith("tag: ")]
    for r in names:
        if r.startswith("HEAD -> "):
            return r[len("HEAD -> "):]
    return names[0] if names else None


def _last_commit(path: Path) -> dict | None:
    """Newest commit across all refs, or None when git is missing, times out, or the repo has no commits."""
    try:
        proc = subprocess.run(["git", "-C", str(path), *LOG_ARGS], capture_output=True, text=True,
                              timeout=GIT_TIMEOUT, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    parts = proc.stdout.strip("\n").split("\x1f", 2)
    if len(parts) != 3:
        return None
    try:
        ts = int(parts[0])
    except ValueError:
        return None
    branch = _branch(parts[2])
    return {
        "ts": ts,
        "subject": _clean(parts[1], SUBJECT_CAP),
        "branch": _clean(branch, BRANCH_CAP) if branch else None,
    }


def _brief_files(briefs: Path, name: str) -> list[dict]:
    """Briefs for one project, newest first, at most BRIEF_CAP: files directly inside _briefs/<name>/ (md, txt,
    json), plus top-level _briefs/<name>*.md. Files that vanish mid-scan are skipped."""
    found: dict[str, tuple[str, float]] = {}
    sub = briefs / name
    candidates: list[Path] = []
    try:
        if sub.is_dir():
            candidates += [p for p in sub.iterdir() if p.suffix.lower() in BRIEF_SUFFIXES]
        if briefs.is_dir():
            candidates += [p for p in briefs.iterdir() if p.name.startswith(name) and p.suffix.lower() == ".md"]
    except OSError:
        pass
    for p in candidates:
        try:
            if p.is_file():
                found[str(p)] = (_clean(p.name, BRIEF_NAME_CAP), p.stat().st_mtime)
        except OSError:
            continue
    ordered = sorted(found.values(), key=lambda b: b[1], reverse=True)[:BRIEF_CAP]
    return [{"name": n, "mtime": m} for n, m in ordered]


def _status(age: float) -> str:
    if age < ACTIVE_SECS:
        return "active"
    if age <= QUIET_SECS:
        return "quiet"
    return "stale"


def _registry(path: Path) -> tuple[dict | None, str | None]:
    """(projects map, error). The map is None when the file is absent or malformed; error is set only when malformed."""
    if not path.exists():
        return None, None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        return None, _clean(f"projects.json unreadable: {e}", 200)
    projects = data.get("projects") if isinstance(data, dict) else None
    if not isinstance(projects, dict):
        return None, 'projects.json: expected {"projects": {...}}'
    return projects, None


def _field(entry, key: str, cap: int) -> str | None:
    """A registry string, redacted and capped; anything else (missing, blank, not a string) is not set."""
    if not isinstance(entry, dict):
        return None
    v = entry.get(key)
    if not isinstance(v, str) or not v.strip():
        return None
    return _clean(v.strip(), cap)


def _project(path: Path, briefs_dir: Path, reg: dict | None, now: float) -> dict:
    name = path.name
    git = (path / ".git").exists()
    last_commit = _last_commit(path) if git else None
    briefs = _brief_files(briefs_dir, name)
    candidates = []
    if last_commit:
        candidates.append((last_commit["ts"], "git"))
    if briefs:
        candidates.append((briefs[0]["mtime"], "brief"))
    if candidates:
        last_activity, last_source = max(candidates, key=lambda c: c[0])
    else:
        last_activity, last_source = _mtime(path), "dir"
    entry = (reg or {}).get(name)
    return {
        "name": _clean(name, 120),
        "git": git,
        "last_commit": last_commit,
        "briefs": briefs,
        "last_activity": last_activity,
        "last_source": last_source,
        "status": _status(now - last_activity),
        "owner": _field(entry, "owner", OWNER_CAP) if reg is not None else None,
        "next": _field(entry, "next", NEXT_CAP) if reg is not None else None,
    }


def projects(root=ROOT, now=None) -> dict:
    """{now, registry, error, projects}. Projects are sorted by folder name; skipped names: '_*', '.*',
    'worktrees', '*-wt', and plain files. A missing root gives an empty list."""
    root = Path(root)
    now = time.time() if now is None else float(now)
    reg, err = _registry(root / "projects.json")
    try:
        entries = sorted(root.iterdir(), key=lambda p: p.name)
    except OSError:
        entries = []
    items = [
        _project(p, root / "_briefs", reg, now)
        for p in entries
        if not _skipped(p.name) and p.is_dir()
    ]
    return {"now": now, "registry": reg is not None, "error": err, "projects": items}
