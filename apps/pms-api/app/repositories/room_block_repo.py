from typing import Optional, List
from datetime import date
from app.database import Database


class RoomBlockRepository:

    @staticmethod
    async def create(data: dict) -> dict:
        row = await Database.fetchrow(
            """
            INSERT INTO room_blocks (
                hotel_id, room_type_id, room_id, start_date, end_date,
                blocked_count, reason
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *
            """,
            data["hotel_id"],
            data["room_type_id"],
            data.get("room_id"),
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
            SELECT rb.*, rt.name AS room_name, r.room_number AS room_number
            FROM room_blocks rb
            JOIN room_types rt ON rt.id = rb.room_type_id
            LEFT JOIN rooms r ON r.id = rb.room_id
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
    async def find_room_conflict(
        room_id: str,
        start_date: date,
        end_date: date,
        exclude_block_id: Optional[str] = None,
    ) -> Optional[dict]:
        """Return the first existing block on `room_id` that overlaps [start, end)."""
        if exclude_block_id:
            row = await Database.fetchrow(
                """
                SELECT id, start_date, end_date FROM room_blocks
                WHERE room_id = $1 AND start_date < $3 AND end_date > $2
                  AND id <> $4
                LIMIT 1
                """,
                room_id, start_date, end_date, exclude_block_id,
            )
        else:
            row = await Database.fetchrow(
                """
                SELECT id, start_date, end_date FROM room_blocks
                WHERE room_id = $1 AND start_date < $3 AND end_date > $2
                LIMIT 1
                """,
                room_id, start_date, end_date,
            )
        return dict(row) if row else None

    @staticmethod
    async def update(block_id: str, updates: dict) -> Optional[dict]:
        if not updates:
            return await RoomBlockRepository.get_by_id(block_id)

        set_clauses = []
        values = []
        idx = 1
        for col, val in updates.items():
            set_clauses.append(f"{col} = ${idx}")
            values.append(val)
            idx += 1

        query = (
            f"UPDATE room_blocks SET {', '.join(set_clauses)} "
            f"WHERE id = ${idx} RETURNING *"
        )
        values.append(block_id)
        row = await Database.fetchrow(query, *values)
        return dict(row) if row else None

    @staticmethod
    async def delete(block_id: str) -> bool:
        result = await Database.execute(
            "DELETE FROM room_blocks WHERE id = $1", block_id
        )
        return result == "DELETE 1"
