"""
Repository for booking_promo_codes table (Database).
"""
from typing import Optional
from datetime import date

from app.database import Database


class PromoCodeRepository:

    @staticmethod
    async def list_by_hotel_id(hotel_id: str) -> list[dict]:
        rows = await Database.fetch(
            "SELECT * FROM booking_promo_codes WHERE hotel_id = $1 ORDER BY created_at DESC",
            hotel_id,
        )
        return [dict(row) for row in rows]

    @staticmethod
    async def get_by_id(promo_id: str, hotel_id: str) -> Optional[dict]:
        row = await Database.fetchrow(
            "SELECT * FROM booking_promo_codes WHERE id = $1 AND hotel_id = $2",
            promo_id, hotel_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def get_by_code(code: str, hotel_id: str) -> Optional[dict]:
        row = await Database.fetchrow(
            "SELECT * FROM booking_promo_codes WHERE code = $1 AND hotel_id = $2",
            code.upper(), hotel_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def create(
        hotel_id: str,
        code: str,
        discount_type: str = 'percentage',
        discount_value: float = 0,
        valid_from: Optional[date] = None,
        valid_until: Optional[date] = None,
        is_active: bool = True,
        max_uses: Optional[int] = None,
    ) -> dict:
        query = """
            INSERT INTO booking_promo_codes
                (hotel_id, code, discount_type, discount_value, valid_from, valid_until, is_active, max_uses)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING *
        """
        row = await Database.fetchrow(
            query, hotel_id, code.upper(), discount_type, discount_value,
            valid_from, valid_until, is_active, max_uses,
        )
        return dict(row)

    @staticmethod
    async def update(promo_id: str, hotel_id: str, updates: dict) -> Optional[dict]:
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
            f"UPDATE booking_promo_codes SET {', '.join(set_clauses)} "
            f"WHERE id = ${idx} AND hotel_id = ${idx + 1} "
            f"RETURNING *"
        )
        values.append(promo_id)
        values.append(hotel_id)

        row = await Database.fetchrow(query, *values)
        return dict(row) if row else None

    @staticmethod
    async def delete(promo_id: str, hotel_id: str) -> bool:
        result = await Database.execute(
            "DELETE FROM booking_promo_codes WHERE id = $1 AND hotel_id = $2",
            promo_id, hotel_id,
        )
        return result == "DELETE 1"

    @staticmethod
    async def increment_use_count(promo_id: str) -> None:
        await Database.execute(
            "UPDATE booking_promo_codes SET use_count = use_count + 1, updated_at = now() WHERE id = $1",
            promo_id,
        )
