"""Persistence for internal staff notes attached to a booking (VAY-495)."""

from app.database import Database


class BookingNoteRepository:
    @staticmethod
    async def list_for_booking(booking_id: str) -> list[dict]:
        rows = await Database.fetch(
            """
            SELECT * FROM booking_notes
            WHERE booking_id = $1
            ORDER BY created_at DESC
            """,
            booking_id,
        )
        return [dict(r) for r in rows]

    @staticmethod
    async def create(
        booking_id: str,
        hotel_id: str,
        author_user_id: str,
        author_name: str,
        body: str,
        source: str | None = None,
    ) -> dict:
        row = await Database.fetchrow(
            """
            INSERT INTO booking_notes
                (booking_id, hotel_id, author_user_id, author_name, body, source)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
            """,
            booking_id,
            hotel_id,
            author_user_id,
            author_name,
            body,
            source,
        )
        return dict(row)

    @staticmethod
    async def get_by_id(note_id: str) -> dict | None:
        row = await Database.fetchrow(
            "SELECT * FROM booking_notes WHERE id = $1",
            note_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def delete(note_id: str) -> bool:
        result = await Database.execute(
            "DELETE FROM booking_notes WHERE id = $1",
            note_id,
        )
        return result.endswith(" 1")
