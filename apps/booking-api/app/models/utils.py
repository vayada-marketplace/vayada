import json
import re


def to_camel(string: str) -> str:
    parts = string.split("_")
    return parts[0] + "".join(w.capitalize() for w in parts[1:])


def parse_json(val, default=None):
    """Parse a JSONB-shaped value that may be a JSON string, a native object,
    or None. Returns ``default`` (or ``[]`` if not given) when the value is
    None or a malformed JSON string."""
    if default is None:
        default = []
    if val is None:
        return default
    if isinstance(val, str):
        try:
            return json.loads(val)
        except (json.JSONDecodeError, TypeError):
            return default
    return val


def parse_json_list(val) -> list:
    """Like ``parse_json`` but coerces non-list shapes to ``[]`` so columns
    that should be JSONB arrays don't crash downstream Pydantic validation
    if a stray dict / scalar slips in."""
    parsed = parse_json(val, default=[])
    return parsed if isinstance(parsed, list) else []


def slugify(text: str) -> str:
    """Convert text to a URL-safe subdomain slug (lowercase, no spaces)."""
    text = text.lower().strip()
    text = re.sub(r'[^\w-]', '', text)
    text = re.sub(r'_+', '', text)
    text = re.sub(r'-+', '-', text)
    return text or 'my-hotel'
