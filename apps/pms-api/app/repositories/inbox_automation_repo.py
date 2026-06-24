from __future__ import annotations

from datetime import date, time

from app.database import Database

DEFAULT_TEMPLATES: list[dict] = [
    {
        "name": "Check-in details",
        "category": "pre_arrival",
        "icon": "key",
        "content": "Hi {{guest}}, we look forward to welcoming you to {{property}} on {{checkin_date}}. Check-in starts at {{checkin_time}}. Address: {{address}}. WiFi: {{wifi}}.",
        "sort_order": 10,
    },
    {
        "name": "Airport shuttle",
        "category": "pre_arrival",
        "icon": "shuttle",
        "content": "Hi {{guest}}, would you like us to arrange an airport shuttle to {{property}} for your arrival on {{checkin_date}}? Reply here and we will confirm availability.",
        "sort_order": 20,
    },
    {
        "name": "Restaurant tips",
        "category": "in_stay",
        "icon": "utensils",
        "content": "Hi {{guest}}, here are a few nearby restaurant tips from {{host}}. Let us know what kind of food you are looking for and we will point you in the right direction.",
        "sort_order": 30,
    },
    {
        "name": "Late checkout OK",
        "category": "in_stay",
        "icon": "clock",
        "content": "Hi {{guest}}, late checkout is approved. You can stay until the agreed time. Enjoy the rest of your stay at {{property}}.",
        "sort_order": 40,
    },
    {
        "name": "Review request",
        "category": "post_stay",
        "icon": "star",
        "content": "Hi {{guest}}, thank you for staying with us at {{property}}. If you enjoyed your stay, we would really appreciate a review here: {{review_link}}",
        "sort_order": 50,
    },
    {
        "name": "Refer-a-Guest",
        "category": "post_stay",
        "icon": "gift",
        "content": "Hi {{guest}}, if you know someone who would love {{property}}, share this referral link: {{referral_link}}. Thank you again for staying with us.",
        "sort_order": 60,
    },
]

DEFAULT_AUTOMATIONS: list[dict] = [
    {
        "name": "1 day before arrival",
        "icon": "key",
        "description": "Send check-in details before the guest travels.",
        "trigger_event": "before_check_in",
        "days_offset": 1,
        "send_time": time(10, 0),
        "audience": "all",
        "delivery_channel": "smart",
        "template_name": "Check-in details",
        "is_active": True,
        "sort_order": 10,
    },
    {
        "name": "Morning of arrival",
        "icon": "shuttle",
        "description": "Offer airport transfer and arrival help.",
        "trigger_event": "day_of_check_in",
        "days_offset": 0,
        "send_time": time(9, 0),
        "audience": "all",
        "delivery_channel": "smart",
        "template_name": "Airport shuttle",
        "is_active": True,
        "sort_order": 20,
    },
    {
        "name": "Day after checkout",
        "icon": "star",
        "description": "Ask recent guests for a review.",
        "trigger_event": "after_check_out",
        "days_offset": 1,
        "send_time": time(10, 0),
        "audience": "all",
        "delivery_channel": "email_only",
        "template_name": "Review request",
        "is_active": True,
        "sort_order": 30,
    },
    {
        "name": "Refer-a-Guest follow-up",
        "icon": "gift",
        "description": "Invite happy guests to refer friends.",
        "trigger_event": "after_check_out",
        "days_offset": 14,
        "send_time": time(10, 0),
        "audience": "all",
        "delivery_channel": "email_only",
        "template_name": "Refer-a-Guest",
        "is_active": False,
        "sort_order": 40,
    },
]


class MessageTemplateRepository:
    @staticmethod
    async def ensure_defaults(hotel_id: str) -> None:
        for item in DEFAULT_TEMPLATES:
            exists = await Database.fetchval(
                "SELECT 1 FROM message_templates WHERE hotel_id = $1 AND name = $2",
                hotel_id,
                item["name"],
            )
            if exists:
                continue
            await Database.execute(
                """
                INSERT INTO message_templates (
                    hotel_id, name, category, icon, content, is_default, sort_order
                )
                VALUES ($1, $2, $3, $4, $5, true, $6)
                """,
                hotel_id,
                item["name"],
                item["category"],
                item["icon"],
                item["content"],
                item["sort_order"],
            )

    @staticmethod
    async def list_by_hotel(hotel_id: str) -> list[dict]:
        await MessageTemplateRepository.ensure_defaults(hotel_id)
        rows = await Database.fetch(
            """
            SELECT * FROM message_templates
            WHERE hotel_id = $1
            ORDER BY sort_order, name
            """,
            hotel_id,
        )
        return [dict(r) for r in rows]

    @staticmethod
    async def get_by_id(template_id: str, hotel_id: str) -> dict | None:
        row = await Database.fetchrow(
            "SELECT * FROM message_templates WHERE id = $1 AND hotel_id = $2",
            template_id,
            hotel_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def create(hotel_id: str, data: dict) -> dict:
        row = await Database.fetchrow(
            """
            INSERT INTO message_templates (
                hotel_id, name, category, icon, content, sort_order
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
            """,
            hotel_id,
            data["name"],
            data.get("category", "general"),
            data.get("icon", "chat"),
            data.get("content", ""),
            data.get("sort_order", 0),
        )
        return dict(row)

    @staticmethod
    async def update(template_id: str, hotel_id: str, updates: dict) -> dict | None:
        filtered = {
            k: v
            for k, v in updates.items()
            if k in {"name", "category", "icon", "content", "sort_order"}
        }
        if not filtered:
            return await MessageTemplateRepository.get_by_id(template_id, hotel_id)
        set_clauses = [f"{key} = ${idx}" for idx, key in enumerate(filtered, start=1)]
        values = list(filtered.values())
        values.extend([template_id, hotel_id])
        row = await Database.fetchrow(
            f"""
            UPDATE message_templates
            SET {", ".join(set_clauses)}, updated_at = now()
            WHERE id = ${len(values) - 1} AND hotel_id = ${len(values)}
            RETURNING *
            """,
            *values,
        )
        return dict(row) if row else None

    @staticmethod
    async def delete(template_id: str, hotel_id: str) -> bool:
        result = await Database.execute(
            "DELETE FROM message_templates WHERE id = $1 AND hotel_id = $2",
            template_id,
            hotel_id,
        )
        return isinstance(result, str) and result.endswith(" 1")


class GuestAutomationRepository:
    @staticmethod
    async def ensure_defaults(hotel_id: str) -> None:
        await MessageTemplateRepository.ensure_defaults(hotel_id)
        for item in DEFAULT_AUTOMATIONS:
            exists = await Database.fetchval(
                "SELECT 1 FROM guest_automations WHERE hotel_id = $1 AND name = $2",
                hotel_id,
                item["name"],
            )
            if exists:
                continue
            template_id = await Database.fetchval(
                "SELECT id FROM message_templates WHERE hotel_id = $1 AND name = $2",
                hotel_id,
                item["template_name"],
            )
            await Database.execute(
                """
                INSERT INTO guest_automations (
                    hotel_id, template_id, name, icon, description, trigger_event,
                    days_offset, send_time, audience, delivery_channel, is_active, sort_order
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                """,
                hotel_id,
                template_id,
                item["name"],
                item["icon"],
                item["description"],
                item["trigger_event"],
                item["days_offset"],
                item["send_time"],
                item["audience"],
                item["delivery_channel"],
                item["is_active"],
                item["sort_order"],
            )

    @staticmethod
    async def list_by_hotel(hotel_id: str) -> list[dict]:
        await GuestAutomationRepository.ensure_defaults(hotel_id)
        rows = await Database.fetch(
            """
            SELECT ga.*, mt.name AS template_name
            FROM guest_automations ga
            LEFT JOIN message_templates mt ON mt.id = ga.template_id
            WHERE ga.hotel_id = $1
            ORDER BY ga.sort_order, ga.name
            """,
            hotel_id,
        )
        return [dict(r) for r in rows]

    @staticmethod
    async def list_active() -> list[dict]:
        rows = await Database.fetch(
            """
            SELECT
                ga.*,
                mt.content AS template_content,
                mt.name AS template_name,
                h.timezone,
                h.name AS hotel_name,
                h.contact_email,
                h.address,
                h.wifi_password,
                h.host_contact_name,
                h.google_review_link
            FROM guest_automations ga
            JOIN hotels h ON h.id = ga.hotel_id
            LEFT JOIN message_templates mt ON mt.id = ga.template_id
            WHERE ga.is_active = true
            ORDER BY ga.hotel_id, ga.sort_order, ga.name
            """
        )
        return [dict(r) for r in rows]

    @staticmethod
    async def get_by_id(automation_id: str, hotel_id: str) -> dict | None:
        row = await Database.fetchrow(
            """
            SELECT ga.*, mt.name AS template_name
            FROM guest_automations ga
            LEFT JOIN message_templates mt ON mt.id = ga.template_id
            WHERE ga.id = $1 AND ga.hotel_id = $2
            """,
            automation_id,
            hotel_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def create(hotel_id: str, data: dict) -> dict:
        row = await Database.fetchrow(
            """
            INSERT INTO guest_automations (
                hotel_id, template_id, name, icon, description, trigger_event,
                days_offset, send_time, audience, delivery_channel, is_active, sort_order
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            RETURNING *
            """,
            hotel_id,
            data.get("template_id"),
            data["name"],
            data.get("icon", "calendar"),
            data.get("description", ""),
            data.get("trigger_event", "before_check_in"),
            data.get("days_offset", 1),
            data.get("send_time", time(10, 0)),
            data.get("audience", "all"),
            data.get("delivery_channel", "smart"),
            data.get("is_active", True),
            data.get("sort_order", 0),
        )
        return dict(row)

    @staticmethod
    async def update(automation_id: str, hotel_id: str, updates: dict) -> dict | None:
        filtered = {
            k: v
            for k, v in updates.items()
            if k
            in {
                "template_id",
                "name",
                "icon",
                "description",
                "trigger_event",
                "days_offset",
                "send_time",
                "audience",
                "delivery_channel",
                "is_active",
                "sort_order",
            }
        }
        if not filtered:
            return await GuestAutomationRepository.get_by_id(automation_id, hotel_id)
        set_clauses = [f"{key} = ${idx}" for idx, key in enumerate(filtered, start=1)]
        values = list(filtered.values())
        values.extend([automation_id, hotel_id])
        row = await Database.fetchrow(
            f"""
            UPDATE guest_automations
            SET {", ".join(set_clauses)}, updated_at = now()
            WHERE id = ${len(values) - 1} AND hotel_id = ${len(values)}
            RETURNING *
            """,
            *values,
        )
        return dict(row) if row else None

    @staticmethod
    async def delete(automation_id: str, hotel_id: str) -> bool:
        result = await Database.execute(
            "DELETE FROM guest_automations WHERE id = $1 AND hotel_id = $2",
            automation_id,
            hotel_id,
        )
        return isinstance(result, str) and result.endswith(" 1")


class AutomationSendRepository:
    @staticmethod
    async def reserve(automation_id: str, booking_id: str, delivery_channel: str) -> dict | None:
        row = await Database.fetchrow(
            """
            INSERT INTO automation_sends (automation_id, booking_id, delivery_channel)
            VALUES ($1, $2, $3)
            ON CONFLICT (automation_id, booking_id) DO NOTHING
            RETURNING *
            """,
            automation_id,
            booking_id,
            delivery_channel,
        )
        return dict(row) if row else None

    @staticmethod
    async def mark(
        send_id: str,
        *,
        status: str,
        message_thread_id: str | None = None,
        message_id: str | None = None,
        error: str | None = None,
    ) -> None:
        await Database.execute(
            """
            UPDATE automation_sends
            SET status = $2,
                message_thread_id = COALESCE($3, message_thread_id),
                message_id = COALESCE($4, message_id),
                error = $5,
                sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END,
                updated_at = now()
            WHERE id = $1
            """,
            send_id,
            status,
            message_thread_id,
            message_id,
            error,
        )


async def latest_booking_context(hotel_id: str) -> dict | None:
    row = await Database.fetchrow(
        """
        SELECT
            b.*,
            h.name AS hotel_name,
            h.address AS hotel_address,
            h.contact_email AS hotel_contact_email,
            h.wifi_password,
            h.host_contact_name,
            h.google_review_link
        FROM bookings b
        JOIN hotels h ON h.id = b.hotel_id
        WHERE b.hotel_id = $1
        ORDER BY b.created_at DESC
        LIMIT 1
        """,
        hotel_id,
    )
    return dict(row) if row else None


async def bookings_for_automation(
    hotel_id: str, target_field: str, target_date: date
) -> list[dict]:
    if target_field not in {"check_in", "check_out"}:
        raise ValueError("target_field must be check_in or check_out")
    rows = await Database.fetch(
        f"""
        SELECT
            b.*,
            h.name AS hotel_name,
            h.address AS hotel_address,
            h.contact_email AS hotel_contact_email,
            h.wifi_password,
            h.host_contact_name,
            h.google_review_link,
            mt.id AS channex_thread_id,
            mt.source_thread_id AS channex_source_thread_id,
            mt.channel AS channex_channel
        FROM bookings b
        JOIN hotels h ON h.id = b.hotel_id
        LEFT JOIN message_threads mt
          ON mt.booking_id = b.id
         AND mt.source = 'channex'
        WHERE b.hotel_id = $1
          AND b.{target_field} = $2
          AND b.status NOT IN ('cancelled', 'declined', 'expired', 'no_show')
        ORDER BY b.created_at ASC
        """,
        hotel_id,
        target_date,
    )
    return [dict(r) for r in rows]
