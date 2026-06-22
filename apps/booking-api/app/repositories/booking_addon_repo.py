"""
Repository for booking_addons table (Database).
"""

import json

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
    async def get_by_id(addon_id: str, hotel_id: str) -> dict | None:
        row = await Database.fetchrow(
            "SELECT * FROM booking_addons WHERE id = $1 AND hotel_id = $2",
            addon_id,
            hotel_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def create(
        hotel_id: str,
        name: str,
        description: str = "",
        price: float = 0,
        currency: str = "EUR",
        category: str = "experience",
        image: str = "",
        duration: str | None = None,
        per_person: bool | None = None,
        per_night: bool | None = None,
        location: str | None = None,
        max_guests: str | None = None,
        highlights: list[str] | None = None,
        included_items: list[str] | None = None,
    ) -> dict:
        row = await Database.fetchrow(
            """
            INSERT INTO booking_addons
                (
                    hotel_id, name, description, price, currency, category, image, duration,
                    per_person, per_night, location, max_guests, highlights, included_items,
                    sort_order
                )
            VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM booking_addons WHERE hotel_id = $1)
            )
            RETURNING *
            """,
            hotel_id,
            name,
            description,
            price,
            currency,
            category,
            image,
            duration,
            per_person,
            per_night,
            location or "",
            max_guests or "",
            json.dumps(highlights or []),
            json.dumps(included_items or []),
        )
        return dict(row)

    @staticmethod
    async def bulk_set_sort_order(hotel_id: str, ordered_ids: list[str]) -> None:
        if not ordered_ids:
            return
        sort_orders = list(range(1, len(ordered_ids) + 1))
        await Database.execute(
            """
            UPDATE booking_addons AS a
            SET sort_order = v.sort_order,
                updated_at = now()
            FROM (
                SELECT UNNEST($2::uuid[]) AS id, UNNEST($3::int[]) AS sort_order
            ) AS v
            WHERE a.id = v.id AND a.hotel_id = $1
            """,
            hotel_id,
            ordered_ids,
            sort_orders,
        )

    @staticmethod
    async def update(addon_id: str, hotel_id: str, updates: dict) -> dict | None:
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
            addon_id,
            hotel_id,
        )
        return result == "DELETE 1"
