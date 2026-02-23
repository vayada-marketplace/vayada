from typing import Optional, List
from datetime import date
from app.database import Database


class RoomBlockRepository:

    @staticmethod
    async def create(data: dict) -> dict:
        row = await Database.fetchrow(
            """
            INSERT INTO room_blocks (
                hotel_id, room_type_id, start_date, end_date,
                blocked_count, reason
            ) VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
            """,
            data["hotel_id"],
            data["room_type_id"],
            data["start_date"],
            data["end_date"],
            data.get("blocked_count", 1),
            data.get("reason", ""),
        )
        return dict(row)

    @staticmethod
    async def list_by_hotel_in_range(
        hotel_id: str, start_date: date, end_date: date
    ) -> List[dict]:
        rows = await Database.fetch(
            """
            SELECT rb.*, rt.name AS room_name
            FROM room_blocks rb
            JOIN room_types rt ON rt.id = rb.room_type_id
            WHERE rb.hotel_id = $1
              AND rb.start_date < $3
              AND rb.end_date > $2
            ORDER BY rb.start_date
            """,
            hotel_id,
            start_date,
            end_date,
        )
        return [dict(r) for r in rows]

    @staticmethod
    async def get_by_id(block_id: str) -> Optional[dict]:
        row = await Database.fetchrow(
            "SELECT * FROM room_blocks WHERE id = $1", block_id
        )
        return dict(row) if row else None

    @staticmethod
    async def delete(block_id: str) -> bool:
        result = await Database.execute(
            "DELETE FROM room_blocks WHERE id = $1", block_id
        )
        return result == "DELETE 1"
