#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PYTHON_BIN="${PYTHON_BIN:-python3}"

"$PYTHON_BIN" - <<'PY'
import importlib.util
import sys

missing = [name for name in ("asyncpg", "bcrypt") if importlib.util.find_spec(name) is None]
if missing:
    print("Missing Python seed dependencies: " + ", ".join(missing), file=sys.stderr)
    print("Install them with: pip install asyncpg bcrypt", file=sys.stderr)
    sys.exit(1)
PY

exec "$PYTHON_BIN" scripts/seed_all.py
