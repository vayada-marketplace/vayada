"""Persistence for non-booker guests on a reservation (VAY-495 card #4)."""

from app.database import Database


class BookingAdditionalGuestRepository:
    @staticmethod
    async def list_for_booking(booking_id: str) -> list[dict]:
        rows = await Database.fetch(
            """
            SELECT * FROM booking_additional_guests
            WHERE booking_id = $1
            ORDER BY position ASC, created_at ASC
            """,
            booking_id,
        )
        return [dict(r) for r in rows]

    @staticmethod
    async def next_position(booking_id: str) -> int:
        row = await Database.fetchrow(
            """
            SELECT COALESCE(MAX(position), 0) + 1 AS next
            FROM booking_additional_guests
            WHERE booking_id = $1
            """,
            booking_id,
        )
        return int(row["next"])

    @staticmethod
    async def create(booking_id: str, hotel_id: str, position: int, data: dict) -> dict:
        row = await Database.fetchrow(
            """
            INSERT INTO booking_additional_guests (
                booking_id, hotel_id, position,
                first_name, last_name, gender, nationality, date_of_birth,
                email, phone, passport_number, room_position
            ) VALUES (
                $1, $2, $3,
                $4, $5, $6, $7, $8,
                $9, $10, $11, $12
            ) RETURNING *
            """,
            booking_id,
            hotel_id,
            position,
            data.get("first_name", ""),
            data.get("last_name", ""),
            data.get("gender", ""),
            data.get("nationality", ""),
            data.get("date_of_birth"),
            data.get("email", ""),
            data.get("phone", ""),
            data.get("passport_number", ""),
            data.get("room_position"),
        )
        return dict(row)

    @staticmethod
    async def get_by_id(guest_id: str) -> dict | None:
        row = await Database.fetchrow(
            "SELECT * FROM booking_additional_guests WHERE id = $1",
            guest_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def update(guest_id: str, updates: dict) -> dict | None:
        # Build dynamic SET clause from non-None fields the caller supplied.
        cols = [
            "first_name",
            "last_name",
            "gender",
            "nationality",
            "date_of_birth",
            "email",
            "phone",
            "passport_number",
            "room_position",
        ]
        sets = []
        values: list = []
        for col in cols:
            if col in updates:
                values.append(updates[col])
                sets.append(f"{col} = ${len(values)}")
        if not sets:
            return await BookingAdditionalGuestRepository.get_by_id(guest_id)
        values.append(guest_id)
        sets.append("updated_at = NOW()")
        sql = (
            "UPDATE booking_additional_guests "
            f"SET {', '.join(sets)} "
            f"WHERE id = ${len(values)} RETURNING *"
        )
        row = await Database.fetchrow(sql, *values)
        return dict(row) if row else None

    @staticmethod
    async def delete(guest_id: str) -> bool:
        result = await Database.execute(
            "DELETE FROM booking_additional_guests WHERE id = $1",
            guest_id,
        )
        return result.endswith(" 1")
