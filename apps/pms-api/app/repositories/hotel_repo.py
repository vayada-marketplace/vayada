"""HotelRepository — reads + writes against the PMS ``hotels`` table.

The PMS row is back-of-house metadata. Hotel-identity fields (currency,
slug, payment-method flags, terms text) are owned by
booking_db.booking_hotels — see memory/project_hotel_data_ownership.md.
This repo only owns the PMS schema.
"""

import json

from app.database import Database

_UPDATE_COLUMNS = {
    "slug",
    "name",
    "contact_email",
    "property_type",
    "timezone",
    "country",
    "state",
    "city",
    "address",
    "zip_code",
    "phone",
    "latitude",
    "longitude",
    "instant_book",
    "same_day_bookings_enabled",
    "same_day_booking_cutoff_time",
    "last_minute_discount",
}
_JSONB_COLUMNS = {"last_minute_discount"}

_GUEST_FORM_COLUMNS = {
    "special_requests_enabled",
    "arrival_time_enabled",
    "guest_count_enabled",
}

_CALENDAR_SETTINGS_COLUMNS = {
    "auto_rearrange_enabled",
    "calendar_auto_open_enabled",
    "calendar_auto_open_mode",
    "calendar_auto_open_months",
    "calendar_auto_open_fixed_month",
    "calendar_auto_open_through",
    "calendar_auto_open_last_run_at",
}


class HotelRepository:
    @staticmethod
    async def get_by_id(hotel_id: str) -> dict | None:
        row = await Database.fetchrow("SELECT * FROM hotels WHERE id = $1", hotel_id)
        return dict(row) if row else None

    @staticmethod
    async def get_owned_id(hotel_id: str, user_id: str) -> str | None:
        """Return ``hotel_id`` iff it belongs to ``user_id`` — used to
        verify X-Hotel-Id against the authenticated user."""
        row = await Database.fetchrow(
            "SELECT id FROM hotels WHERE id = $1 AND user_id = $2",
            hotel_id,
            user_id,
        )
        return str(row["id"]) if row else None

    @staticmethod
    async def get_oldest_for_user(user_id: str) -> dict | None:
        """User's oldest hotel by created_at, with the basic shape
        (id, slug, name, contact_email, user_id, created_at)."""
        row = await Database.fetchrow(
            "SELECT id, slug, name, contact_email, user_id, created_at "
            "FROM hotels WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1",
            user_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def update_basic(hotel_id: str, slug: str, name: str, contact_email: str) -> None:
        """Update slug + name + contact_email — used during registration."""
        await Database.execute(
            "UPDATE hotels SET slug = $1, name = $2, contact_email = $3 WHERE id = $4",
            slug,
            name,
            contact_email,
            hotel_id,
        )

    @staticmethod
    async def create(
        slug: str,
        name: str,
        contact_email: str,
        user_id: str,
        hotel_id: str | None = None,
    ) -> dict:
        """Insert a hotel row. ``hotel_id`` pins the PK to the booking_db
        hotel id — required for the multi-hotel-safe registration flow.
        Returns the basic shape (id, slug, name, contact_email, user_id,
        created_at)."""
        if hotel_id:
            row = await Database.fetchrow(
                """INSERT INTO hotels (id, slug, name, contact_email, user_id)
                   VALUES ($1, $2, $3, $4, $5)
                   RETURNING id, slug, name, contact_email, user_id, created_at""",
                hotel_id,
                slug,
                name,
                contact_email,
                user_id,
            )
        else:
            row = await Database.fetchrow(
                """INSERT INTO hotels (slug, name, contact_email, user_id)
                   VALUES ($1, $2, $3, $4)
                   RETURNING id, slug, name, contact_email, user_id, created_at""",
                slug,
                name,
                contact_email,
                user_id,
            )
        return dict(row)

    @staticmethod
    async def update_fields(hotel_id: str, fields: dict) -> dict | None:
        """Update an allow-listed subset of columns and return the full
        updated row. Columns in ``_JSONB_COLUMNS`` are pre-serialized
        and cast."""
        filtered = {k: v for k, v in fields.items() if k in _UPDATE_COLUMNS}
        if not filtered:
            return await HotelRepository.get_by_id(hotel_id)

        set_clauses = []
        values = []
        for i, (col, val) in enumerate(filtered.items(), start=1):
            if col in _JSONB_COLUMNS:
                set_clauses.append(f"{col} = ${i}::jsonb")
                values.append(json.dumps(val) if val is not None else None)
            else:
                set_clauses.append(f"{col} = ${i}")
                values.append(val)

        values.append(hotel_id)
        sql = f"UPDATE hotels SET {', '.join(set_clauses)} WHERE id = ${len(values)} RETURNING *"
        row = await Database.fetchrow(sql, *values)
        return dict(row) if row else None

    @staticmethod
    async def count_room_types(hotel_id: str) -> int:
        return (
            await Database.fetchval("SELECT COUNT(*) FROM room_types WHERE hotel_id = $1", hotel_id)
            or 0
        )

    @staticmethod
    async def count_upcoming_bookings(hotel_id: str) -> int:
        """Count non-cancelled bookings whose check-in is today or later.
        Used by the Manage Properties delete-warning dialog."""
        return (
            await Database.fetchval(
                """
            SELECT COUNT(*) FROM bookings
            WHERE hotel_id = $1
              AND check_in >= CURRENT_DATE
              AND status NOT IN ('cancelled', 'declined', 'expired')
            """,
                hotel_id,
            )
            or 0
        )

    @staticmethod
    async def count_active_channel_connections(hotel_id: str) -> int:
        """Count active channel-manager connections — one row max per
        provider, so the result is the number of distinct providers
        wired up. Currently only Channex; Beds24 was dropped in
        migration 029."""
        channex = (
            await Database.fetchval(
                "SELECT COUNT(*) FROM channex_connections WHERE hotel_id = $1 AND is_active = true",
                hotel_id,
            )
            or 0
        )
        return int(channex)

    @staticmethod
    async def delete(hotel_id: str) -> bool:
        """Delete the PMS row. FKs cascade to room_types, rooms, bookings,
        room_blocks, channex_connections, beds24_connections, payment
        settings, etc. Returns True if a row was deleted."""
        result = await Database.execute(
            "DELETE FROM hotels WHERE id = $1",
            hotel_id,
        )
        return isinstance(result, str) and result.endswith(" 1")

    @staticmethod
    async def get_benefits_raw(hotel_id: str):
        """Raw JSONB (string or list depending on driver). Caller should
        parse with ``app.utils.parse_jsonb``."""
        return await Database.fetchval("SELECT benefits FROM hotels WHERE id = $1", hotel_id)

    @staticmethod
    async def update_benefits(hotel_id: str, benefits: list) -> None:
        await Database.execute(
            "UPDATE hotels SET benefits = $1::jsonb WHERE id = $2",
            json.dumps(benefits),
            hotel_id,
        )

    @staticmethod
    async def get_guest_form_settings(hotel_id: str) -> dict | None:
        row = await Database.fetchrow(
            "SELECT special_requests_enabled, arrival_time_enabled, guest_count_enabled "
            "FROM hotels WHERE id = $1",
            hotel_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def update_guest_form_settings(hotel_id: str, fields: dict) -> None:
        filtered = {k: v for k, v in fields.items() if k in _GUEST_FORM_COLUMNS}
        if not filtered:
            return
        set_clauses = ", ".join(f"{k} = ${i + 1}" for i, k in enumerate(filtered))
        values = list(filtered.values())
        values.append(hotel_id)
        await Database.execute(
            f"UPDATE hotels SET {set_clauses} WHERE id = ${len(values)}",
            *values,
        )

    @staticmethod
    async def get_auto_rearrange_enabled(hotel_id: str) -> bool:
        """Whether the calendar auto-rearrange solver runs for this hotel.

        Defaults TRUE for any row that doesn't have the column yet (covers
        a brief window after the migration but before container restart);
        the column itself defaults TRUE so new hotels are opted in.
        """
        val = await Database.fetchval(
            "SELECT auto_rearrange_enabled FROM hotels WHERE id = $1",
            hotel_id,
        )
        return True if val is None else bool(val)

    @staticmethod
    async def set_auto_rearrange_enabled(hotel_id: str, enabled: bool) -> None:
        await Database.execute(
            "UPDATE hotels SET auto_rearrange_enabled = $2 WHERE id = $1",
            hotel_id,
            enabled,
        )

    @staticmethod
    async def get_calendar_settings(hotel_id: str) -> dict | None:
        row = await Database.fetchrow(
            """
            SELECT
                auto_rearrange_enabled,
                calendar_auto_open_enabled,
                calendar_auto_open_mode,
                calendar_auto_open_months,
                calendar_auto_open_fixed_month,
                calendar_auto_open_through,
                calendar_auto_open_last_run_at,
                timezone
            FROM hotels
            WHERE id = $1
            """,
            hotel_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def update_calendar_settings(hotel_id: str, fields: dict) -> dict | None:
        filtered = {k: v for k, v in fields.items() if k in _CALENDAR_SETTINGS_COLUMNS}
        if not filtered:
            return await HotelRepository.get_calendar_settings(hotel_id)

        set_clauses = ", ".join(f"{k} = ${i + 1}" for i, k in enumerate(filtered))
        values = list(filtered.values())
        values.append(hotel_id)
        row = await Database.fetchrow(
            f"""
            UPDATE hotels
            SET {set_clauses}
            WHERE id = ${len(values)}
            RETURNING
                auto_rearrange_enabled,
                calendar_auto_open_enabled,
                calendar_auto_open_mode,
                calendar_auto_open_months,
                calendar_auto_open_fixed_month,
                calendar_auto_open_through,
                calendar_auto_open_last_run_at,
                timezone
            """,
            *values,
        )
        return dict(row) if row else None

    @staticmethod
    async def list_rolling_auto_open_hotels() -> list[dict]:
        rows = await Database.fetch(
            """
            SELECT
                id,
                timezone,
                calendar_auto_open_months,
                calendar_auto_open_through
            FROM hotels
            WHERE calendar_auto_open_enabled = true
              AND calendar_auto_open_mode = 'rolling'
            """
        )
        return [dict(r) for r in rows]
