"""
Repository for booking_hotels + booking_hotel_translations tables (Database).
"""
import json
from typing import Optional

from app.database import Database


class BookingHotelRepository:

    @staticmethod
    async def get_by_user_id(
        user_id: str,
        *,
        columns: str = "slug, name, contact_email, contact_phone, contact_whatsapp, contact_address, timezone, currency, supported_currencies, supported_languages, email_notifications, new_booking_alerts, payment_alerts, weekly_reports",
    ) -> Optional[dict]:
        row = await Database.fetchrow(f"SELECT {columns} FROM booking_hotels WHERE user_id = $1", user_id)
        return dict(row) if row else None

    @staticmethod
    async def get_by_slug(slug: str) -> Optional[dict]:
        row = await Database.fetchrow("SELECT * FROM booking_hotels WHERE slug = $1", slug)
        return dict(row) if row else None

    @staticmethod
    async def get_by_custom_domain(domain: str) -> Optional[dict]:
        row = await Database.fetchrow("SELECT * FROM booking_hotels WHERE custom_domain = $1", domain)
        return dict(row) if row else None

    @staticmethod
    async def get_by_slug_translated(slug: str, locale: str) -> Optional[dict]:
        query = """
            SELECT h.*,
                   COALESCE(t.name, h.name) AS t_name,
                   COALESCE(t.description, h.description) AS t_description,
                   COALESCE(t.location, h.location) AS t_location,
                   COALESCE(t.country, h.country) AS t_country,
                   COALESCE(t.contact_address, h.contact_address) AS t_contact_address,
                   COALESCE(t.amenities, h.amenities) AS t_amenities
            FROM booking_hotels h
            LEFT JOIN booking_hotel_translations t
                ON t.hotel_id = h.id AND t.locale = $2
            WHERE h.slug = $1
        """
        row = await Database.fetchrow(query, slug, locale)
        return dict(row) if row else None

    @staticmethod
    async def list_by_user_id(
        user_id: str,
        *,
        columns: str = "id, name, slug, location, country",
    ) -> list[dict]:
        rows = await Database.fetch(
            f"SELECT {columns} FROM booking_hotels WHERE user_id = $1 ORDER BY created_at ASC",
            user_id,
        )
        return [dict(row) for row in rows]

    @staticmethod
    async def get_by_id(hotel_id: str, *, columns: str = "*") -> Optional[dict]:
        row = await Database.fetchrow(f"SELECT {columns} FROM booking_hotels WHERE id = $1", hotel_id)
        return dict(row) if row else None

    @staticmethod
    async def list_all(*, columns: str = "id, name, slug, location, country, user_id") -> list[dict]:
        rows = await Database.fetch(f"SELECT {columns} FROM booking_hotels ORDER BY created_at ASC")
        return [dict(row) for row in rows]

    @staticmethod
    async def get_by_id_and_user_id(
        hotel_id: str,
        user_id: str,
        *,
        columns: str = "*",
    ) -> Optional[dict]:
        row = await Database.fetchrow(
            f"SELECT {columns} FROM booking_hotels WHERE id = $1 AND user_id = $2",
            hotel_id, user_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def create(
        name: str,
        slug: str,
        contact_email: str,
        contact_phone: str,
        timezone: str,
        currency: str,
        supported_languages: list,
        user_id: str,
        *,
        supported_currencies: list | None = None,
        contact_whatsapp: str = '',
        contact_address: str = '',
        email_notifications: bool = True,
        new_booking_alerts: bool = True,
        payment_alerts: bool = True,
        weekly_reports: bool = False,
    ) -> dict:
        query = """
            INSERT INTO booking_hotels (name, slug, contact_email, contact_phone, contact_whatsapp, contact_address, timezone, currency, supported_currencies, supported_languages, user_id, email_notifications, new_booking_alerts, payment_alerts, weekly_reports)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12, $13, $14, $15)
            RETURNING slug, name, contact_email, contact_phone, contact_whatsapp, contact_address, timezone, currency, supported_currencies, supported_languages, email_notifications, new_booking_alerts, payment_alerts, weekly_reports
        """
        row = await Database.fetchrow(
            query,
            name, slug, contact_email, contact_phone, contact_whatsapp, contact_address,
            timezone, currency, json.dumps(supported_currencies or []),
            json.dumps(supported_languages), user_id,
            email_notifications, new_booking_alerts, payment_alerts, weekly_reports,
        )
        return dict(row)

    @staticmethod
    async def partial_update(hotel_id: str, updates: dict) -> Optional[dict]:
        if not updates:
            return None

        set_clauses = []
        values = []
        idx = 1
        json_columns = ("supported_languages", "supported_currencies", "booking_filters", "custom_filters")
        for col, val in updates.items():
            if col in json_columns:
                set_clauses.append(f"{col} = ${idx}::jsonb")
                values.append(json.dumps(val))
            else:
                set_clauses.append(f"{col} = ${idx}")
                values.append(val)
            idx += 1

        set_clauses.append("updated_at = now()")
        query = (
            f"UPDATE booking_hotels SET {', '.join(set_clauses)} "
            f"WHERE id = ${idx} "
            f"RETURNING *"
        )
        values.append(hotel_id)

        row = await Database.fetchrow(query, *values)
        return dict(row) if row else None
