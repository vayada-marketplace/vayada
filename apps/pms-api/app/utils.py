import json
from collections.abc import Awaitable, Callable
from contextvars import ContextVar

from fastapi import HTTPException

from app.database import AuthDatabase, Database

# Per-request override for the "current hotel" resolution. Populated
# by the capture_hotel_header dependency (see dependencies.py), read
# by get_hotel_id below. Using a contextvar lets us keep the existing
# get_hotel_id(user_id) signature unchanged across ~50 call sites
# while still honoring the X-Hotel-Id header when it's present.
#
# Contextvars are task-local in asyncio, so each FastAPI request runs
# in isolation — no cross-request leakage.
_current_hotel_id_override: ContextVar[str | None] = ContextVar(
    "_current_hotel_id_override", default=None
)


def set_current_hotel_id_override(hotel_id: str | None) -> None:
    """Set the per-request X-Hotel-Id override. Called by the global
    capture_hotel_header dependency at the start of each admin request."""
    _current_hotel_id_override.set(hotel_id)


def parse_jsonb(val):
    """Parse a JSONB value that might be a string or already parsed."""
    if isinstance(val, str):
        return json.loads(val)
    return val if val else []


async def get_hotel_id(user_id: str) -> str:
    """
    Resolve the hotel id for the current request.

    Priority:
      1. X-Hotel-Id header (via contextvar), validated to be owned by
         the authenticated user. Raises 403 on mismatch.
      2. Fallback: user's oldest hotel. Single-hotel legacy behavior.
         Preserved so callers that don't (yet) send the header still
         work in the one-hotel case, which is how every PMS endpoint
         used to work before multi-hotel support landed.
    """
    override = _current_hotel_id_override.get()
    if override:
        user = await AuthDatabase.fetchrow(
            "SELECT is_superadmin FROM users WHERE id = $1",
            user_id,
        )
        if user and user["is_superadmin"]:
            row = await Database.fetchrow("SELECT id FROM hotels WHERE id = $1", override)
        else:
            row = await Database.fetchrow(
                "SELECT id FROM hotels WHERE id = $1 AND user_id = $2",
                override,
                user_id,
            )
        if not row:
            raise HTTPException(
                status_code=403,
                detail="X-Hotel-Id does not match any hotel owned by this user",
            )
        return str(row["id"])

    row = await Database.fetchrow(
        "SELECT id FROM hotels WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1",
        user_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="No hotel found for this account")
    return str(row["id"])


async def get_hotel_id_by_slug(slug: str) -> str:
    """Look up hotel ID from slug, raising 404 if not found."""
    row = await Database.fetchrow("SELECT id FROM hotels WHERE slug = $1", slug)
    if not row:
        raise HTTPException(status_code=404, detail="Hotel not found")
    return str(row["id"])


async def generate_unique_code(
    generator: Callable[[], str],
    exists_checker: Callable[[str], Awaitable[bool]],
    max_attempts: int = 10,
    entity_name: str = "code",
) -> str:
    """Generate a unique code with retry logic."""
    for _ in range(max_attempts):
        code = generator()
        if not await exists_checker(code):
            return code
    raise RuntimeError(f"Could not generate unique {entity_name}")


async def upsert_by_hotel_id(
    table: str,
    hotel_id: str,
    data: dict,
) -> dict:
    """Generic upsert for tables with a hotel_id foreign key."""
    existing = await Database.fetchrow(f"SELECT * FROM {table} WHERE hotel_id = $1", hotel_id)

    if existing:
        sets = ["updated_at = now()"]
        args = [str(existing["id"])]
        idx = 2
        for key, value in data.items():
            sets.append(f"{key} = ${idx}")
            args.append(value)
            idx += 1

        row = await Database.fetchrow(
            f"UPDATE {table} SET {', '.join(sets)} WHERE id = $1 RETURNING *",
            *args,
        )
    else:
        columns = ["hotel_id"]
        values = [hotel_id]
        placeholders = ["$1"]
        idx = 2
        for key, value in data.items():
            columns.append(key)
            values.append(value)
            placeholders.append(f"${idx}")
            idx += 1

        row = await Database.fetchrow(
            f"INSERT INTO {table} ({', '.join(columns)}) VALUES ({', '.join(placeholders)}) RETURNING *",
            *values,
        )
    return dict(row)
