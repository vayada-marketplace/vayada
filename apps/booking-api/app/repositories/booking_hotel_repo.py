"""
Repository for booking_hotels + booking_hotel_translations tables (Database).
"""

import json

from app.database import Database
from app.models.settings import HOTEL_FIELD_DEFAULTS as _D


class BookingHotelRepository:
    @staticmethod
    async def get_by_user_id(
        user_id: str,
        *,
        columns: str = "slug, name, contact_email, contact_phone, contact_whatsapp, contact_address, timezone, currency, supported_currencies, supported_languages, email_notifications, new_booking_alerts, payment_alerts, ota_booking_alerts, weekly_reports",
    ) -> dict | None:
        row = await Database.fetchrow(
            f"SELECT {columns} FROM booking_hotels WHERE user_id = $1", user_id
        )
        return dict(row) if row else None

    @staticmethod
    async def get_by_slug(slug: str) -> dict | None:
        row = await Database.fetchrow("SELECT * FROM booking_hotels WHERE slug = $1", slug)
        return dict(row) if row else None

    @staticmethod
    async def get_by_previous_slug(slug: str) -> dict | None:
        """Look up a hotel by a slug it used before being renamed. Callers
        use this to issue a 301 to the canonical slug instead of 404ing
        links shared on the old subdomain."""
        row = await Database.fetchrow(
            "SELECT * FROM booking_hotels WHERE $1 = ANY(previous_slugs)",
            slug,
        )
        return dict(row) if row else None

    @staticmethod
    async def get_by_custom_domain(domain: str) -> dict | None:
        row = await Database.fetchrow(
            "SELECT * FROM booking_hotels WHERE custom_domain = lower($1)",
            domain,
        )
        return dict(row) if row else None

    @staticmethod
    async def get_by_slug_translated(slug: str, locale: str) -> dict | None:
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
    async def get_by_id(hotel_id: str, *, columns: str = "*") -> dict | None:
        row = await Database.fetchrow(
            f"SELECT {columns} FROM booking_hotels WHERE id = $1", hotel_id
        )
        return dict(row) if row else None

    @staticmethod
    async def list_all(
        *, columns: str = "id, name, slug, location, country, user_id"
    ) -> list[dict]:
        rows = await Database.fetch(
            f"SELECT {columns} FROM booking_hotels ORDER BY created_at DESC"
        )
        return [dict(row) for row in rows]

    @staticmethod
    async def delete(hotel_id: str) -> bool:
        result = await Database.execute("DELETE FROM booking_hotels WHERE id = $1", hotel_id)
        # asyncpg returns a status string like "DELETE 1"
        return isinstance(result, str) and result.endswith(" 1")

    @staticmethod
    async def get_by_id_and_user_id(
        hotel_id: str,
        user_id: str,
        *,
        columns: str = "*",
    ) -> dict | None:
        row = await Database.fetchrow(
            f"SELECT {columns} FROM booking_hotels WHERE id = $1 AND user_id = $2",
            hotel_id,
            user_id,
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
        # Defaults sourced from app.models.settings.HOTEL_FIELD_DEFAULTS so
        # the canonical values live in exactly one place. Adding a new
        # column with a non-empty default = update the dict only.
        default_language: str = _D["default_language"],
        supported_currencies: list | None = None,
        contact_whatsapp: str = "",
        contact_address: str = "",
        check_in_time: str = _D["check_in_time"],
        check_out_time: str = _D["check_out_time"],
        check_in_from: str = "",
        check_in_until: str = "",
        check_out_from: str = "",
        check_out_until: str = "",
        pay_at_property_enabled: bool = _D["pay_at_property_enabled"],
        online_card_payment: bool = _D["online_card_payment"],
        bank_transfer: bool = _D["bank_transfer"],
        free_cancellation_days: int = _D["free_cancellation_days"],
        email_notifications: bool = _D["email_notifications"],
        new_booking_alerts: bool = _D["new_booking_alerts"],
        payment_alerts: bool = _D["payment_alerts"],
        ota_booking_alerts: bool = _D["ota_booking_alerts"],
        weekly_reports: bool = _D["weekly_reports"],
        special_requests_enabled: bool = _D["special_requests_enabled"],
        arrival_time_enabled: bool = _D["arrival_time_enabled"],
        guest_count_enabled: bool = _D["guest_count_enabled"],
        refer_a_guest_enabled: bool = _D["refer_a_guest_enabled"],
        social_instagram: str = "",
        social_facebook: str = "",
        social_tiktok: str = "",
        social_youtube: str = "",
        payout_account_holder: str = "",
        payout_account_type: str = _D["payout_account_type"],
        payout_iban: str = "",
        payout_account_number: str = "",
        payout_bank_name: str = "",
        payout_swift: str = "",
    ) -> dict:
        query = """
            INSERT INTO booking_hotels (
                name, slug, contact_email, contact_phone, contact_whatsapp, contact_address,
                timezone, currency, default_language, supported_currencies, supported_languages, user_id,
                check_in_time, check_out_time,
                check_in_from, check_in_until, check_out_from, check_out_until,
                pay_at_property_enabled, online_card_payment, bank_transfer, free_cancellation_days,
                email_notifications, new_booking_alerts, payment_alerts, ota_booking_alerts, weekly_reports,
                special_requests_enabled, arrival_time_enabled, guest_count_enabled, refer_a_guest_enabled,
                social_instagram, social_facebook, social_tiktok, social_youtube,
                payout_account_holder, payout_account_type, payout_iban, payout_account_number,
                payout_bank_name, payout_swift
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12,
                $13, $14, $15, $16, $17, $18,
                $19, $20, $21, $22, $23, $24, $25, $26, $27,
                $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39, $40, $41
            ) RETURNING *
        """
        row = await Database.fetchrow(
            query,
            name,
            slug,
            contact_email,
            contact_phone,
            contact_whatsapp,
            contact_address,
            timezone,
            currency,
            default_language,
            json.dumps(supported_currencies or []),
            json.dumps(supported_languages),
            user_id,
            check_in_time,
            check_out_time,
            check_in_from,
            check_in_until,
            check_out_from,
            check_out_until,
            pay_at_property_enabled,
            online_card_payment,
            bank_transfer,
            free_cancellation_days,
            email_notifications,
            new_booking_alerts,
            payment_alerts,
            ota_booking_alerts,
            weekly_reports,
            special_requests_enabled,
            arrival_time_enabled,
            guest_count_enabled,
            refer_a_guest_enabled,
            social_instagram,
            social_facebook,
            social_tiktok,
            social_youtube,
            payout_account_holder,
            payout_account_type,
            payout_iban,
            payout_account_number,
            payout_bank_name,
            payout_swift,
        )
        return dict(row)

    @staticmethod
    async def partial_update(hotel_id: str, updates: dict) -> dict | None:
        if not updates:
            return None

        set_clauses = []
        values = []
        idx = 1
        json_columns = (
            "supported_languages",
            "supported_currencies",
            "booking_filters",
            "custom_filters",
            "filter_rooms",
            "pay_at_hotel_methods",
            "benefits",
        )
        for col, val in updates.items():
            if col in json_columns:
                set_clauses.append(f"{col} = ${idx}::jsonb")
                values.append(json.dumps(val))
            else:
                set_clauses.append(f"{col} = ${idx}")
                values.append(val)
            idx += 1

        set_clauses.append("updated_at = now()")
        query = f"UPDATE booking_hotels SET {', '.join(set_clauses)} WHERE id = ${idx} RETURNING *"
        values.append(hotel_id)

        row = await Database.fetchrow(query, *values)
        return dict(row) if row else None
