"""booking_rooms junction access (VAY-403).

The FIRST room of a booking stays in bookings.room_id (position 0, implicit).
This table holds only the ADDITIONAL physical rooms a multi-room booking
occupies (positions 1..N-1). Single-room bookings never get a row here, so
every single-room path is unaffected.
"""

from typing import List, Optional
from app.database import Database


class BookingRoomRepository:

    @staticmethod
    async def set_extra_rooms(booking_id: str, room_ids: List[str]) -> None:
        """Replace the extra-room set for a booking.

        ``room_ids`` are the rooms beyond the primary, in order. They are
        written at positions 1..len(room_ids); position 0 is the primary
        room held by bookings.room_id.
        """
        await Database.execute(
            "DELETE FROM booking_rooms WHERE booking_id = $1", booking_id
        )
        if not room_ids:
            return
        await Database.execute(
            """
            INSERT INTO booking_rooms (booking_id, room_id, position)
            SELECT $1, r.room_id::uuid, r.ord
            FROM unnest($2::uuid[]) WITH ORDINALITY AS r(room_id, ord)
            """,
            booking_id,
            room_ids,
        )

    @staticmethod
    async def list_extra_rooms(booking_id: str) -> List[dict]:
        """Extra rooms for one booking, ordered by slot position.

        Returns dicts with room_id, room_number, position.
        """
        rows = await Database.fetch(
            """
            SELECT br.room_id, br.position, rm.room_number
            FROM booking_rooms br
            JOIN rooms rm ON rm.id = br.room_id
            WHERE br.booking_id = $1
            ORDER BY br.position
            """,
            booking_id,
        )
        return [dict(r) for r in rows]

    @staticmethod
    async def list_extra_rooms_for_bookings(booking_ids: List[str]) -> List[dict]:
        """Batched variant for the calendar render — one query for many
        bookings to avoid an N+1. Returns booking_id, room_id, room_number,
        position rows.
        """
        if not booking_ids:
            return []
        rows = await Database.fetch(
            """
            SELECT br.booking_id, br.room_id, br.position, rm.room_number
            FROM booking_rooms br
            JOIN rooms rm ON rm.id = br.room_id
            WHERE br.booking_id = ANY($1::uuid[])
            ORDER BY br.booking_id, br.position
            """,
            booking_ids,
        )
        return [dict(r) for r in rows]

    @staticmethod
    async def occupied_room_ids_for_room_type(
        room_type_id: str, check_in, check_out
    ) -> set:
        """Every physical room of a room type taken by an overlapping
        non-cancelled booking — the union of the primary room
        (bookings.room_id) and every extra room (booking_rooms).

        Mirrors count_booked's stale-unpaid-pending exclusion so the
        multi-room picker and the inventory count agree on what's taken.
        """
        rows = await Database.fetch(
            """
            SELECT b.room_id AS room_id
            FROM bookings b
            WHERE b.room_type_id = $1
              AND b.room_id IS NOT NULL
              AND b.status IN ('pending', 'confirmed')
              AND b.check_in < $3
              AND b.check_out > $2
              AND NOT (
                b.status = 'pending'
                AND b.payment_status = 'unpaid'
                AND b.created_at < NOW() - INTERVAL '30 minutes'
              )
            UNION
            SELECT br.room_id AS room_id
            FROM booking_rooms br
            JOIN bookings b ON b.id = br.booking_id
            WHERE b.room_type_id = $1
              AND b.status IN ('pending', 'confirmed')
              AND b.check_in < $3
              AND b.check_out > $2
              AND NOT (
                b.status = 'pending'
                AND b.payment_status = 'unpaid'
                AND b.created_at < NOW() - INTERVAL '30 minutes'
              )
            """,
            room_type_id,
            check_in,
            check_out,
        )
        return {str(r["room_id"]) for r in rows if r["room_id"] is not None}

    @staticmethod
    async def reassign_extra_room(
        booking_id: str, old_room_id: str, new_room_id: str
    ) -> Optional[dict]:
        """Move one extra room of a booking to a different unit, leaving the
        booking's other rooms (primary + remaining extras) where they are.
        """
        row = await Database.fetchrow(
            """
            UPDATE booking_rooms
            SET room_id = $3
            WHERE booking_id = $1 AND room_id = $2
            RETURNING id, booking_id, room_id, position
            """,
            booking_id,
            old_room_id,
            new_room_id,
        )
        return dict(row) if row else None
