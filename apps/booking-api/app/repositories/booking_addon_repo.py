"""
Repository for booking_addons table (Database).
"""
from typing import Optional

from app.database import Database


class BookingAddonRepository:

    @staticmethod
    async def list_by_hotel_id(hotel_id: str) -> list[dict]:
        rows = await Database.fetch(
            "SELECT * FROM booking_addons WHERE hotel_id = $1 ORDER BY sort_order, created_at",
            hotel_id,
        )
        return [dict(row) for row in rows]

    @staticmethod
    async def get_by_id(addon_id: str, hotel_id: str) -> Optional[dict]:
        row = await Database.fetchrow(
            "SELECT * FROM booking_addons WHERE id = $1 AND hotel_id = $2",
            addon_id, hotel_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def create(
        hotel_id: str,
        name: str,
        description: str = '',
        price: float = 0,
        currency: str = 'EUR',
        category: str = 'experience',
        image: str = '',
        duration: Optional[str] = None,
        per_person: Optional[bool] = None,
    ) -> dict:
        query = """
            INSERT INTO booking_addons (hotel_id, name, description, price, currency, category, image, duration, per_person)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING *
        """
        row = await Database.fetchrow(query, hotel_id, name, description, price, currency, category, image, duration, per_person)
        return dict(row)

    @staticmethod
    async def update(addon_id: str, hotel_id: str, updates: dict) -> Optional[dict]:
        if not updates:
            return None

        set_clauses = []
        values = []
        idx = 1
        for col, val in updates.items():
            set_clauses.append(f"{col} = ${idx}")
            values.append(val)
            idx += 1

        set_clauses.append("updated_at = now()")
        query = (
            f"UPDATE booking_addons SET {', '.join(set_clauses)} "
            f"WHERE id = ${idx} AND hotel_id = ${idx + 1} "
            f"RETURNING *"
        )
        values.append(addon_id)
        values.append(hotel_id)

        row = await Database.fetchrow(query, *values)
        return dict(row) if row else None

    @staticmethod
    async def delete(addon_id: str, hotel_id: str) -> bool:
        result = await Database.execute(
            "DELETE FROM booking_addons WHERE id = $1 AND hotel_id = $2",
            addon_id, hotel_id,
        )
        return result == "DELETE 1"

    @staticmethod
    async def count_by_hotel_id(hotel_id: str) -> int:
        return await Database.fetchval(
            "SELECT COUNT(*) FROM booking_addons WHERE hotel_id = $1",
            hotel_id,
        )
