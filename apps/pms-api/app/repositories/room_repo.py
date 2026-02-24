from typing import Optional, List
from app.database import Database


class RoomRepository:

    @staticmethod
    async def list_by_hotel_id(hotel_id: str) -> List[dict]:
        rows = await Database.fetch(
            """
            SELECT r.*, rt.name AS room_type_name
            FROM rooms r
            JOIN room_types rt ON rt.id = r.room_type_id
            WHERE r.hotel_id = $1
            ORDER BY rt.sort_order, rt.name, r.sort_order, r.room_number
            """,
            hotel_id,
        )
        return [dict(r) for r in rows]

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
            data.get("sort_order", 0),
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
