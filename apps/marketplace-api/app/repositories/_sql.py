"""
Internal SQL helpers shared by repositories.
"""
import re

# Comma-separated identifier list, with optional `as alias`. Lower/upper case
# letters, digits, underscores. Used to gate the `columns` parameter on
# repository SELECT helpers — callers always pass literals today, but
# nothing else stops a future caller from forwarding user input.
_COLUMN_TERM = re.compile(r'^[a-zA-Z_][a-zA-Z0-9_]*(\s+as\s+[a-zA-Z_][a-zA-Z0-9_]*)?$')


def safe_columns(columns: str) -> str:
    """Validate `columns` is `*` or a comma-separated list of identifiers,
    optionally aliased with `as`. Raise ValueError on anything else.
    """
    if columns == "*":
        return columns
    for term in columns.split(","):
        if not _COLUMN_TERM.match(term.strip()):
            raise ValueError(f"Invalid columns spec: {columns!r}")
    return columns
