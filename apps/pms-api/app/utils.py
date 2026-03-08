import json
import secrets
import string
from typing import Callable, Awaitable

from fastapi import HTTPException
from app.database import Database


def parse_jsonb(val):
    """Parse a JSONB value that might be a string or already parsed."""
    if isinstance(val, str):
        return json.loads(val)
    return val if val else []


async def get_hotel_id(user_id: str) -> str:
    """Look up hotel ID from user_id, raising 404 if not found."""
    row = await Database.fetchrow(
        "SELECT id FROM hotels WHERE user_id = $1", user_id
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
    existing = await Database.fetchrow(
        f"SELECT * FROM {table} WHERE hotel_id = $1", hotel_id
    )

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
