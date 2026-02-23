"""
Repository for booking_hotels + booking_hotel_translations tables (Database).
"""
import json
from typing import Optional

import asyncpg

from app.database import Database


class BookingHotelRepository:

    @staticmethod
    async def get_by_user_id(
        user_id: str,
        *,
        columns: str = "slug, name, contact_email, contact_phone, contact_whatsapp, contact_address, timezone, currency, supported_currencies, supported_languages, email_notifications, new_booking_alerts, payment_alerts, weekly_reports",
        conn: Optional[asyncpg.Connection] = None,
    ) -> Optional[dict]:
        query = f"SELECT {columns} FROM booking_hotels WHERE user_id = $1"
        if conn:
            row = await conn.fetchrow(query, user_id)
        else:
            row = await Database.fetchrow(query, user_id)
        return dict(row) if row else None

    @staticmethod
    async def get_by_slug(
        slug: str, *, conn: Optional[asyncpg.Connection] = None
    ) -> Optional[dict]:
        query = "SELECT * FROM booking_hotels WHERE slug = $1"
        if conn:
            row = await conn.fetchrow(query, slug)
        else:
            row = await Database.fetchrow(query, slug)
        return dict(row) if row else None

    @staticmethod
    async def get_by_slug_translated(
        slug: str, locale: str, *, conn: Optional[asyncpg.Connection] = None
    ) -> Optional[dict]:
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
        if conn:
            row = await conn.fetchrow(query, slug, locale)
        else:
            row = await Database.fetchrow(query, slug, locale)
        return dict(row) if row else None

    @staticmethod
    async def list_by_user_id(
        user_id: str,
        *,
        columns: str = "id, name, slug, location, country",
        conn: Optional[asyncpg.Connection] = None,
    ) -> list[dict]:
        query = f"SELECT {columns} FROM booking_hotels WHERE user_id = $1 ORDER BY created_at ASC"
        if conn:
            rows = await conn.fetch(query, user_id)
        else:
            rows = await Database.fetch(query, user_id)
        return [dict(row) for row in rows]

    @staticmethod
    async def get_by_id_and_user_id(
        hotel_id: str,
        user_id: str,
        *,
        columns: str = "*",
        conn: Optional[asyncpg.Connection] = None,
    ) -> Optional[dict]:
        query = f"SELECT {columns} FROM booking_hotels WHERE id = $1 AND user_id = $2"
        if conn:
            row = await conn.fetchrow(query, hotel_id, user_id)
        else:
            row = await Database.fetchrow(query, hotel_id, user_id)
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
        conn: Optional[asyncpg.Connection] = None,
    ) -> dict:
        query = """
            INSERT INTO booking_hotels (name, slug, contact_email, contact_phone, contact_whatsapp, contact_address, timezone, currency, supported_currencies, supported_languages, user_id, email_notifications, new_booking_alerts, payment_alerts, weekly_reports)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12, $13, $14, $15)
            RETURNING slug, name, contact_email, contact_phone, contact_whatsapp, contact_address, timezone, currency, supported_currencies, supported_languages, email_notifications, new_booking_alerts, payment_alerts, weekly_reports
        """
        currencies_json = json.dumps(supported_currencies or [])
        languages_json = json.dumps(supported_languages)
        args = (name, slug, contact_email, contact_phone, contact_whatsapp, contact_address, timezone, currency, currencies_json, languages_json, user_id, email_notifications, new_booking_alerts, payment_alerts, weekly_reports)
        if conn:
            row = await conn.fetchrow(query, *args)
        else:
            row = await Database.fetchrow(query, *args)
        return dict(row)

    @staticmethod
    async def partial_update(
        hotel_id: str,
        updates: dict,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> Optional[dict]:
        """
        Dynamically build an UPDATE from the provided dict.
        Keys are column names, values are the new values.
        Returns the updated row or None if no hotel found.
        """
        if not updates:
            return None

        set_clauses = []
        values = []
        idx = 1
        for col, val in updates.items():
            if col in ("supported_languages", "supported_currencies", "booking_filters"):
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

        if conn:
            row = await conn.fetchrow(query, *values)
        else:
            row = await Database.fetchrow(query, *values)
        return dict(row) if row else None
