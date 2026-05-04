import logging
from typing import Optional, List, Iterable, Tuple

import asyncpg

from app.database import Database

logger = logging.getLogger(__name__)


class RoomRepository:

    @staticmethod
    async def list_by_hotel_id(hotel_id: str) -> List[dict]:
        # Primary key is r.sort_order so the user-visible order on the
        # PMS Calendar (driven by the "Reorder rooms" mode) wins. Default
        # sort_order=0 means rooms that have never been reordered fall
        # back to the original room-type grouping.
        rows = await Database.fetch(
            """
            SELECT r.*, rt.name AS room_type_name
            FROM rooms r
            JOIN room_types rt ON rt.id = r.room_type_id
            WHERE r.hotel_id = $1
            ORDER BY r.sort_order, rt.sort_order, rt.name,
                     (COALESCE(NULLIF(regexp_replace(r.room_number, '.*[^0-9]', '', 'g'), ''), '0'))::int,
                     r.room_number
            """,
            hotel_id,
        )
        return [dict(r) for r in rows]

    @staticmethod
    async def max_sort_order(hotel_id: str) -> int:
        row = await Database.fetchrow(
            "SELECT COALESCE(MAX(sort_order), 0) AS max_so FROM rooms WHERE hotel_id = $1",
            hotel_id,
        )
        return int(row["max_so"]) if row else 0

    @staticmethod
    async def bulk_set_sort_order(
        hotel_id: str, ordered_ids: Iterable[Tuple[str, int]]
    ) -> None:
        """Atomically rewrite sort_order for a hotel's rooms.

        ordered_ids is an iterable of (room_id, sort_order) pairs. The
        update is hotel-scoped to defend against cross-tenant writes
        even if a room_id in the list belongs to another hotel.
        """
        items = list(ordered_ids)
        if not items:
            return
        ids = [room_id for room_id, _ in items]
        orders = [sort_order for _, sort_order in items]
        await Database.execute(
            """
            UPDATE rooms AS r
            SET sort_order = v.sort_order,
                updated_at = now()
            FROM (
                SELECT UNNEST($2::uuid[]) AS id, UNNEST($3::int[]) AS sort_order
            ) AS v
            WHERE r.id = v.id AND r.hotel_id = $1
            """,
            hotel_id,
            ids,
            orders,
        )

    @staticmethod
    async def rename_auto_named(
        hotel_id: str,
        room_type_id: str,
        old_name: str,
        new_name: str,
    ) -> int:
        """Rewrite room_number for rooms still using the auto-generated
        "{room_type_name} N" naming so they follow a renamed room type.

        Only rooms whose current room_number matches the exact pattern
        "<old_name> <integer>" are touched — manually-renamed rooms (e.g.
        "101", "Penthouse") are left alone. Returns the number of rows
        rewritten. Hotel-scoped to defend against cross-tenant writes.

        If the rename would collide with the unique (hotel_id, room_number)
        index — e.g. another room type already owns "<new_name> 1" — the
        whole UPDATE is rolled back and 0 is returned. The caller keeps
        the room-type rename; only the room_number rewrite is skipped, and
        the user can resolve the conflict manually.
        """
        if old_name == new_name:
            return 0
        # POSIX-regex special chars that need escaping inside the anchored
        # pattern. Backslash first so we don't double-escape later additions.
        special = r"\.^$*+?()[]{}|"
        escaped_old = "".join(
            ("\\" + c) if c in special else c for c in old_name
        )
        pattern = f"^{escaped_old} [0-9]+$"
        try:
            result = await Database.execute(
                """
                UPDATE rooms
                SET room_number = $4 || substring(room_number from length($3) + 1),
                    updated_at = now()
                WHERE hotel_id = $1
                  AND room_type_id = $2
                  AND room_number ~ $5
                """,
                hotel_id,
                room_type_id,
                old_name,
                new_name,
                pattern,
            )
        except asyncpg.UniqueViolationError:
            logger.warning(
                "Skipped renaming auto-named rooms for room_type %s "
                "(%r -> %r): would collide with existing room numbers",
                room_type_id, old_name, new_name,
            )
            return 0
        # asyncpg returns "UPDATE <n>" for executes that affect rows.
        try:
            return int(result.split()[-1])
        except (ValueError, AttributeError, IndexError):
            return 0

    @staticmethod
    async def get_by_id(room_id: str) -> Optional[dict]:
        row = await Database.fetchrow(
            """
            SELECT r.*, rt.name AS room_type_name
            FROM rooms r
            JOIN room_types rt ON rt.id = r.room_type_id
            WHERE r.id = $1
            """,
            room_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def create(data: dict) -> dict:
        # Default sort_order = max + 1 so newly created rooms land at
        # the bottom of the user's saved Calendar order (VAY-307).
        sort_order = data.get("sort_order")
        if sort_order is None or sort_order == 0:
            sort_order = await RoomRepository.max_sort_order(data["hotel_id"]) + 1
        row = await Database.fetchrow(
            """
            INSERT INTO rooms (
                hotel_id, room_type_id, room_number, floor, status, sort_order
            ) VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
            """,
            data["hotel_id"],
            data["room_type_id"],
            data["room_number"],
            data.get("floor", ""),
            data.get("status", "available"),
            sort_order,
        )
        # Re-fetch with JOIN to get room_type_name
        return await RoomRepository.get_by_id(str(row["id"]))

    @staticmethod
    async def update(room_id: str, updates: dict) -> Optional[dict]:
        if not updates:
            return await RoomRepository.get_by_id(room_id)

        set_clauses = []
        values = []
        idx = 1
        for col, val in updates.items():
            set_clauses.append(f"{col} = ${idx}")
            values.append(val)
            idx += 1

        set_clauses.append("updated_at = now()")
        query = (
            f"UPDATE rooms SET {', '.join(set_clauses)} "
            f"WHERE id = ${idx} RETURNING *"
        )
        values.append(room_id)
        row = await Database.fetchrow(query, *values)
        if not row:
            return None
        return await RoomRepository.get_by_id(room_id)

    @staticmethod
    async def delete(room_id: str) -> bool:
        result = await Database.execute(
            "DELETE FROM rooms WHERE id = $1", room_id
        )
        return result == "DELETE 1"
