import json
from typing import Optional, List
from datetime import date
from app.database import Database


class RoomTypeRepository:

    @staticmethod
    async def list_by_hotel_id(hotel_id: str, *, active_only: bool = False) -> List[dict]:
        where = "WHERE hotel_id = $1"
        if active_only:
            where += " AND is_active = true"
        rows = await Database.fetch(
            f"SELECT * FROM room_types {where} ORDER BY sort_order, name", hotel_id
        )
        return [dict(r) for r in rows]

    @staticmethod
    async def get_by_id(room_type_id: str) -> Optional[dict]:
        row = await Database.fetchrow(
            "SELECT * FROM room_types WHERE id = $1", room_type_id
        )
        return dict(row) if row else None

    @staticmethod
    async def create(hotel_id: str, data: dict) -> dict:
        row = await Database.fetchrow(
            """
            INSERT INTO room_types (
                hotel_id, name, description, short_description,
                max_occupancy, size, base_rate, currency,
                amenities, images, bed_type, features,
                total_rooms, is_active, sort_order
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8,
                $9::jsonb, $10::jsonb, $11, $12::jsonb,
                $13, $14, $15
            ) RETURNING *
            """,
            hotel_id,
            data["name"],
            data.get("description", ""),
            data.get("short_description", ""),
            data.get("max_occupancy", 2),
            data.get("size", 0),
            data.get("base_rate", 0),
            data.get("currency", "EUR"),
            json.dumps(data.get("amenities", [])),
            json.dumps(data.get("images", [])),
            data.get("bed_type", ""),
            json.dumps(data.get("features", [])),
            data.get("total_rooms", 1),
            data.get("is_active", True),
            data.get("sort_order", 0),
        )
        return dict(row)

    @staticmethod
    async def update(room_type_id: str, updates: dict) -> Optional[dict]:
        if not updates:
            return await RoomTypeRepository.get_by_id(room_type_id)

        set_clauses = []
        values = []
        idx = 1
        for col, val in updates.items():
            if col in ("amenities", "images", "features"):
                set_clauses.append(f"{col} = ${idx}::jsonb")
                values.append(json.dumps(val))
            else:
                set_clauses.append(f"{col} = ${idx}")
                values.append(val)
            idx += 1

        set_clauses.append("updated_at = now()")
        query = (
            f"UPDATE room_types SET {', '.join(set_clauses)} "
            f"WHERE id = ${idx} RETURNING *"
        )
        values.append(room_type_id)
        row = await Database.fetchrow(query, *values)
        return dict(row) if row else None

    @staticmethod
    async def delete(room_type_id: str) -> bool:
        result = await Database.execute(
            "DELETE FROM room_types WHERE id = $1", room_type_id
        )
        return result == "DELETE 1"

    @staticmethod
    async def count_booked(
        room_type_id: str, check_in: date, check_out: date
    ) -> int:
        """Count overlapping non-cancelled bookings for a room type."""
        count = await Database.fetchval(
            """
            SELECT COUNT(*) FROM bookings
            WHERE room_type_id = $1
              AND status IN ('pending', 'confirmed')
              AND check_in < $3
              AND check_out > $2
            """,
            room_type_id,
            check_in,
            check_out,
        )
        return count or 0

    @staticmethod
    async def count_blocked(
        room_type_id: str, start_date: date, end_date: date
    ) -> int:
        """Sum blocked_count for overlapping room blocks."""
        count = await Database.fetchval(
            """
            SELECT COALESCE(SUM(blocked_count), 0) FROM room_blocks
            WHERE room_type_id = $1
              AND start_date < $3
              AND end_date > $2
            """,
            room_type_id,
            start_date,
            end_date,
        )
        return count or 0
