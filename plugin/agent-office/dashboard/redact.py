"""Server-side redaction for text that leaves the Agent Office API (/feed, /comms).

Pure functions, no I/O. Redaction is a safety net, not a parser: it strips the secret shapes we know about
(provider keys, bearer tokens, key=value / "key": "value" pairs whose name says KEY, TOKEN, SECRET, PASSWORD
or PASSWD, PEM private keys, .env-style blocks, long hex/base64 runs). Normal prose, paths, URLs without
secrets and short git SHAs pass through unchanged.

Deliberate choices:
- UUIDs are kept (their hyphen-separated groups are short); 7-12 hex git SHAs are kept.
- Full 40-char SHAs and any 33+ run of hex/base64 characters are redacted.
- A base64 run containing '/' is only caught via its key name, because '/' is how paths look.
- Conservative on key names: "max_tokens=4096" or "keys: none" are redacted too.
"""
import re

MARK = "[redacted]"
ENV_MARK = "[redacted: .env file]"

_NAME = r"[A-Za-z0-9_.\-]*(?i:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Za-z0-9_.\-]*"

_PEM = re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|\Z)")
_ENV_LINE = re.compile(r"^([ \t]*(?:export[ \t]+)?[A-Z][A-Z0-9_]*=)[^\n]*", re.M)
# "key": "value" (plain or JSON-escaped inside a tool-call arguments string).
_JSON_KV = re.compile(r'(\\?"' + _NAME + r'\\?"\s*:\s*\\?")([^"\\\n]*)')
_BEARER = re.compile(r"(\bbearer\s+)(?:(?=\S*\d)[A-Za-z0-9._~+/=\-]{8,}|[A-Za-z0-9._~+/=\-]{20,})", re.I)
_PREFIXES = [
    re.compile(r"\bsk-(?:ant-|proj-)?[A-Za-z0-9_\-]{16,}"),
    re.compile(r"\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"\bAIza[0-9A-Za-z_\-]{30,}"),
    re.compile(r"\bxox[abpr]-[A-Za-z0-9\-]{10,}"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
]
_KV_QUOTED = re.compile(r"(" + _NAME + r"\s*[=:]\s*)([\"'])[^\n]*?\2")  # group 2 = the quote char
_KV_BARE = re.compile(r"(" + _NAME + r"\s*[=:]\s*)[^\s\"'\\,;&]+")
_FLAG = re.compile(r"(--[A-Za-z0-9_\-]*(?i:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Za-z0-9_\-]*\s+)[^\s\-][^\s]*")
_HEX = re.compile(r"(?<![0-9A-Za-z])[0-9a-fA-F]{33,}(?![0-9A-Za-z])")
_B64 = re.compile(r"(?<![A-Za-z0-9+/])[A-Za-z0-9+]{33,}={0,2}(?![A-Za-z0-9+/=])")
_ENV_PATH = re.compile(r"(?<![A-Za-z0-9_\-])\.env(?![A-Za-z0-9_\-])")


def is_env_path(s) -> bool:
    """True when the text references a .env file (".env", "/x/.env", ".env.local"); not "process.env" or "dotenv"."""
    return bool(s) and _ENV_PATH.search(str(s)) is not None


def _scrub(s: str) -> str:
    s = _PEM.sub(MARK, s)
    if len(_ENV_LINE.findall(s)) >= 2:
        s = _ENV_LINE.sub(lambda m: m.group(1) + MARK, s)
    s = _JSON_KV.sub(lambda m: m.group(1) + MARK, s)
    s = _BEARER.sub(lambda m: m.group(1) + MARK, s)
    for p in _PREFIXES:
        s = p.sub(MARK, s)
    s = _KV_QUOTED.sub(lambda m: m.group(1) + m.group(2) + MARK + m.group(2), s)
    s = _KV_BARE.sub(lambda m: m.group(1) + MARK, s)
    s = _FLAG.sub(lambda m: m.group(1) + MARK, s)
    s = _HEX.sub(MARK, s)
    s = _B64.sub(MARK, s)
    return s


def redact(text, limit=None) -> str:
    """Text with secrets replaced by '[redacted]'. Redaction runs before truncation; a result over `limit`
    characters is cut to limit-1 characters plus an ellipsis, so the result never exceeds `limit`."""
    if text is None:
        return ""
    s = _scrub(text if isinstance(text, str) else str(text))
    if limit is not None:
        if limit <= 0:
            return ""
        if len(s) > limit:
            s = s[: limit - 1].rstrip() + "…"
    return s
