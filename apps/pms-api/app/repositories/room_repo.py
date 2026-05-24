import logging
import re
from collections import Counter
from collections.abc import Iterable

import asyncpg

from app.database import Database

logger = logging.getLogger(__name__)


class RoomRepository:
    @staticmethod
    async def list_by_hotel_id(hotel_id: str) -> list[dict]:
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
    async def bulk_set_sort_order(hotel_id: str, ordered_ids: Iterable[tuple[str, int]]) -> None:
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
        "{room_type_name}" or "{room_type_name} N" naming so they follow a
        renamed room type.

        Only rooms whose current room_number matches the exact pattern
        "<old_name>" or "<old_name> <integer>" are touched — manually-renamed
        rooms (e.g. "101", "Penthouse") are left alone. Returns the number
        of rows rewritten. Hotel-scoped to defend against cross-tenant writes.

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
        escaped_old = "".join(("\\" + c) if c in special else c for c in old_name)
        pattern = f"^{escaped_old}( [0-9]+)?$"
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
                room_type_id,
                old_name,
                new_name,
            )
            return 0
        # asyncpg returns "UPDATE <n>" for executes that affect rows.
        try:
            return int(result.split()[-1])
        except (ValueError, AttributeError, IndexError):
            return 0

    @staticmethod
    async def heal_stale_room_names(
        hotel_id: str,
        room_type_id: str,
        current_name: str,
    ) -> int:
        """Rewrite room_numbers in this room type that look like stale
        auto-names left over from a previous room-type name.

        rename_auto_named() handles the on-rename case where we still know
        the old name. heal covers the other case: hotels that renamed
        their room type before the on-rename fix shipped, so the old name
        is gone and rename_auto_named can never fire. This runs on every
        PATCH /admin/room-types/{id} so any save heals stale data, and is
        also called by scripts/backfill_room_names_vay322.py.

        Heuristic — to avoid stomping a deliberately-customized name
        ("Penthouse") we only rewrite when we have strong evidence the
        room was auto-generated:
          - "shared prefix": ≥2 rooms in this room type share the same
            prefix that isn't the current name and isn't a sibling room
            type's name. Auto-naming is the only realistic source of
            that pattern.
          - "lone room": this room type has exactly one room and its
            prefix isn't the current name and isn't a sibling type's
            name. The screenshot scenario from the ticket lives here —
            single "#Deluxe Room" under "Deluxe Party Room".

        The "isn't a sibling type's name" guard prevents stealing rooms
        that match another type's prefix (e.g. don't rewrite a "Garden
        King 1" room while saving "Deluxe Suite" — that prefix belongs
        to a different type).

        Returns the number of rooms rewritten. Idempotent.
        """
        rooms = await Database.fetch(
            """
            SELECT id, room_number
            FROM rooms
            WHERE hotel_id = $1 AND room_type_id = $2
            """,
            hotel_id,
            room_type_id,
        )
        if not rooms:
            return 0

        sibling_rows = await Database.fetch(
            """
            SELECT name
            FROM room_types
            WHERE hotel_id = $1 AND id != $2
            """,
            hotel_id,
            room_type_id,
        )
        sibling_names = {row["name"] for row in sibling_rows}

        # Greedy on the prefix so digits inside the name (e.g. "Suite 2"
        # as a deliberate type name) are preserved, and only a trailing
        # " <integer>" is treated as the auto-numbered suffix.
        prefix_re = re.compile(r"^(.*?)( [0-9]+)?$")
        candidates: list[tuple[str, str, str, str]] = []
        for r in rooms:
            number = r["room_number"]
            m = prefix_re.match(number)
            if not m:
                continue
            prefix = m.group(1)
            suffix = m.group(2) or ""
            if not prefix or prefix == current_name:
                continue
            if prefix in sibling_names:
                continue
            candidates.append((str(r["id"]), number, prefix, suffix))

        if not candidates:
            return 0

        prefix_counts = Counter(c[2] for c in candidates)
        only_room_in_type = len(rooms) == 1

        renames: list[tuple[str, str, str]] = []
        for room_id, old_number, prefix, suffix in candidates:
            shared = prefix_counts[prefix] >= 2
            if not (shared or only_room_in_type):
                continue
            new_number = f"{current_name}{suffix}"
            if new_number == old_number:
                continue
            renames.append((room_id, old_number, new_number))

        renamed = 0
        for room_id, old_number, new_number in renames:
            try:
                await Database.execute(
                    """
                    UPDATE rooms
                    SET room_number = $3, updated_at = now()
                    WHERE id = $1 AND hotel_id = $2
                    """,
                    room_id,
                    hotel_id,
                    new_number,
                )
                renamed += 1
            except asyncpg.UniqueViolationError:
                logger.warning(
                    "Skipped healing room %s (%r -> %r): would collide with "
                    "an existing room_number in hotel %s",
                    room_id,
                    old_number,
                    new_number,
                    hotel_id,
                )
        return renamed

    @staticmethod
    async def list_for_room_type(room_type_id: str) -> list[dict]:
        """List active rooms of a type with the sort key the calendar uses.

        Returned rows carry id and sort_order so the auto-rearrange solver
        (VAY-397) can pick rooms in the same order the calendar displays
        them — picking the lowest-numbered free room first stays consistent
        with the legacy direct-fit `_assign_room_unit` query.
        """
        rows = await Database.fetch(
            """
            SELECT id, sort_order
            FROM rooms
            WHERE room_type_id = $1
              AND status = 'available'
            ORDER BY sort_order,
                     (COALESCE(NULLIF(regexp_replace(room_number, '[^0-9].*', '', 'g'), ''), '0'))::int,
                     room_number
            """,
            room_type_id,
        )
        return [dict(r) for r in rows]

    @staticmethod
    async def get_by_id(room_id: str) -> dict | None:
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
    async def update(room_id: str, updates: dict) -> dict | None:
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
        query = f"UPDATE rooms SET {', '.join(set_clauses)} WHERE id = ${idx} RETURNING *"
        values.append(room_id)
        row = await Database.fetchrow(query, *values)
        if not row:
            return None
        return await RoomRepository.get_by_id(room_id)

    @staticmethod
    async def delete(room_id: str) -> bool:
        result = await Database.execute("DELETE FROM rooms WHERE id = $1", room_id)
        return result == "DELETE 1"

    @staticmethod
    async def list_for_reconciliation(room_type_id: str) -> list[dict]:
        """List a room type's rooms in delete-last order (VAY-406).

        Used when "Total Rooms" is reduced and we have to choose which
        physical rooms to drop. Ordering keeps "Deluxe 1, Deluxe 2" and
        removes "Deluxe 3, …, Deluxe 21": ascending trailing-integer
        suffix first, then sort_order, then created_at. The caller takes
        the tail of the returned list and deletes those rooms.
        """
        rows = await Database.fetch(
            """
            SELECT id, room_number, sort_order
            FROM rooms
            WHERE room_type_id = $1
            ORDER BY (COALESCE(NULLIF(regexp_replace(room_number, '.*[^0-9]', '', 'g'), ''), '0'))::int,
                     sort_order,
                     created_at,
                     room_number
            """,
            room_type_id,
        )
        return [dict(r) for r in rows]

    @staticmethod
    async def active_bookings_referencing(room_ids: list[str]) -> list[dict]:
        """Return non-cancelled bookings that would lose their room
        assignment if any of `room_ids` were deleted (VAY-406).

        Covers both the primary `bookings.room_id` (ON DELETE SET NULL
        would silently unassign) and `booking_rooms.room_id` for
        multi-room bookings (ON DELETE CASCADE would silently drop the
        link). "Active" means status NOT IN ('cancelled', 'declined',
        'expired') — historical/terminal-state bookings are fine to leave
        behind.
        """
        if not room_ids:
            return []
        rows = await Database.fetch(
            """
            SELECT DISTINCT b.id AS booking_id,
                            b.booking_reference,
                            b.status,
                            b.check_in,
                            b.check_out,
                            r.id AS room_id,
                            r.room_number
            FROM bookings b
            JOIN rooms r
              ON r.id = b.room_id
              OR r.id IN (SELECT room_id FROM booking_rooms WHERE booking_id = b.id)
            WHERE r.id = ANY($1::uuid[])
              AND b.status NOT IN ('cancelled', 'declined', 'expired')
            ORDER BY b.check_in, b.booking_reference
            """,
            room_ids,
        )
        return [dict(r) for r in rows]
