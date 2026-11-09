"""Agent Deck server card: read-only host numbers for GET /api/plugins/agent-office/server.

Reads /proc/meminfo, /proc/loadavg and each /proc/<pid>/status file, plus os.statvfs('/') and os.cpu_count().
Nothing is run, no command line or environment is read, and no request input is used. Every value is a number
except the sanitized process names. Any failure of a section gives null for that section; a failed meminfo
read gives None for the whole snapshot (the route answers 503).
"""
import os
import re
import time

PROC = "/proc"
DISK_PATH = "/"
GIB = 1024 ** 3
TOP_N = 3
NAME_MAX = 32

_DIGITS = re.compile(r"[0-9]+")
_DECIMAL = re.compile(r"[0-9]+(?:\.[0-9]+)?")
_KEEP_NAME = re.compile(r"[^A-Za-z0-9._:/ -]")
_STATUS_REL = re.compile(r"[0-9]+/status")
_ALLOWED_REL = ("meminfo", "loadavg")


def _read(root, rel):
    """The only open() in this module. rel must be a fixed /proc file or <digits>/status; nothing else is read."""
    if rel not in _ALLOWED_REL and not _STATUS_REL.fullmatch(rel):
        raise ValueError("refused path")
    with open(os.path.join(root, rel), "rb") as f:
        return f.read().decode("utf-8", "replace")


def parse_meminfo(text):
    """MemTotal and MemAvailable (kB) -> MB figures. Raises ValueError on anything unexpected."""
    found = {}
    for line in text.splitlines():
        key, sep, rest = line.partition(":")
        if not sep or key not in ("MemTotal", "MemAvailable"):
            continue
        parts = rest.split()
        if len(parts) not in (1, 2) or not _DIGITS.fullmatch(parts[0]) or (len(parts) == 2 and parts[1] != "kB"):
            raise ValueError("bad meminfo line")
        found[key] = int(parts[0])
    if set(found) != {"MemTotal", "MemAvailable"}:
        raise ValueError("meminfo fields missing")
    total_kb, avail_kb = found["MemTotal"], found["MemAvailable"]
    if total_kb <= 0 or avail_kb < 0 or avail_kb > total_kb:
        raise ValueError("meminfo out of range")
    total_mb = total_kb // 1024
    avail_mb = avail_kb // 1024
    return {
        "total_mb": total_mb,
        "available_mb": avail_mb,
        "used_mb": total_mb - avail_mb,
        "used_pct": round(100.0 * (total_kb - avail_kb) / total_kb, 1),
    }


def parse_loadavg(text):
    """First three fields of /proc/loadavg as floats. Raises ValueError on anything unexpected."""
    parts = text.split()
    if len(parts) < 3 or not all(_DECIMAL.fullmatch(p) for p in parts[:3]):
        raise ValueError("bad loadavg")
    return round(float(parts[0]), 2), round(float(parts[1]), 2), round(float(parts[2]), 2)


def clean_name(raw):
    """Keep only [A-Za-z0-9._:/ -], at most NAME_MAX characters; a name that ends up blank becomes '?'."""
    s = _KEEP_NAME.sub("", raw or "")[:NAME_MAX].strip()
    return s or "?"


def _parse_status(text):
    """(name, rss_mb) from a status file, or None when there is no VmRSS line (kernel threads)."""
    name, rss_kb = None, None
    for line in text.splitlines():
        if name is None and line.startswith("Name:"):
            name = line[5:].strip()
        elif rss_kb is None and line.startswith("VmRSS:"):
            parts = line[6:].split()
            if parts and _DIGITS.fullmatch(parts[0]):
                rss_kb = int(parts[0])
    if rss_kb is None:
        return None
    return clean_name(name), rss_kb // 1024


def mem_stats(proc_root=None):
    """RAM figures from meminfo. Raises OSError or ValueError when meminfo cannot be read or parsed."""
    root = PROC if proc_root is None else proc_root
    return parse_meminfo(_read(root, "meminfo"))


def load_stats(proc_root=None, cpu_count=os.cpu_count):
    """Load averages plus core count, or None on any failure."""
    root = PROC if proc_root is None else proc_root
    try:
        one, five, fifteen = parse_loadavg(_read(root, "loadavg"))
        cores = cpu_count()
    except (OSError, ValueError, TypeError):
        return None
    if not isinstance(cores, int) or cores < 1:
        return None
    return {"one": one, "five": five, "fifteen": fifteen, "cores": cores}


def disk_stats(statvfs=os.statvfs, path=DISK_PATH):
    """Free space on the root filesystem, or None on any failure."""
    try:
        st = statvfs(path)
        frsize = int(st.f_frsize)
        total = int(st.f_blocks) * frsize
        free = int(st.f_bavail) * frsize
    except (OSError, AttributeError, TypeError, ValueError):
        return None
    if total <= 0:
        return None
    return {
        "path": path,
        "total_gb": round(total / GIB, 1),
        "free_gb": round(free / GIB, 1),
        "free_pct": round(100.0 * free / total, 1),
    }


def top_processes(proc_root=None):
    """Top TOP_N processes by resident memory. Reads only <pid>/status. None if the proc tree cannot be listed."""
    root = PROC if proc_root is None else proc_root
    try:
        entries = os.listdir(root)
    except OSError:
        return None
    rows = []
    for pid in entries:
        if not _DIGITS.fullmatch(pid):
            continue
        try:
            parsed = _parse_status(_read(root, f"{pid}/status"))
        except (OSError, ValueError, UnicodeError):
            continue  # the process vanished mid-read, or the file is not readable
        if parsed is None:
            continue  # no VmRSS: kernel thread
        rows.append({"name": parsed[0], "rss_mb": parsed[1]})
    rows.sort(key=lambda r: (-r["rss_mb"], r["name"]))
    return rows[:TOP_N]


def snapshot(proc_root=None, statvfs=os.statvfs, cpu_count=os.cpu_count):
    """The whole card payload, or None when /proc/meminfo cannot be read or parsed (the route answers 503)."""
    root = PROC if proc_root is None else proc_root
    try:
        mem = mem_stats(root)
    except (OSError, ValueError):
        return None
    return {
        "ts": time.time(),
        "mem": mem,
        "disk": disk_stats(statvfs),
        "load": load_stats(root, cpu_count),
        "top": top_processes(root),
    }
