import json
import re


def to_camel(string: str) -> str:
    parts = string.split("_")
    return parts[0] + "".join(w.capitalize() for w in parts[1:])


def parse_json(val, default=None):
    """Parse a value that may be a JSON string, a native Python object, or None."""
    if default is None:
        default = []
    if isinstance(val, str):
        return json.loads(val)
    return val if val is not None else default


def slugify(text: str) -> str:
    """Convert text to a URL-safe slug."""
    text = text.lower().strip()
    text = re.sub(r'[^\w\s-]', '', text)
    text = re.sub(r'[\s_]+', '-', text)
    text = re.sub(r'-+', '-', text)
    return text or 'my-hotel'
