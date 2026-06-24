from datetime import datetime

from app.database import Database


class MessageThreadRepository:
    @staticmethod
    async def get_by_source_thread_id(source: str, source_thread_id: str) -> dict | None:
        row = await Database.fetchrow(
            "SELECT * FROM message_threads WHERE source = $1 AND source_thread_id = $2",
            source,
            source_thread_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def get_by_id(thread_id: str, hotel_id: str) -> dict | None:
        row = await Database.fetchrow(
            """
            SELECT mt.*, b.booking_reference, b.check_in, b.check_out
            FROM message_threads mt
            LEFT JOIN bookings b ON b.id = mt.booking_id
            WHERE mt.id = $1 AND mt.hotel_id = $2
            """,
            thread_id,
            hotel_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def upsert_from_source(
        *,
        hotel_id: str,
        source: str,
        source_thread_id: str,
        channel: str | None,
        guest_name: str | None,
        guest_email: str | None,
        source_booking_id: str | None,
        booking_id: str | None,
        status: str = "open",
    ) -> dict:
        """Insert if missing, update mutable fields if present. Returns the row.
        Does NOT touch unread_count or last_message_* — those are managed by
        message inserts."""
        row = await Database.fetchrow(
            """
            INSERT INTO message_threads (
                hotel_id, source, source_thread_id, channel,
                guest_name, guest_email, source_booking_id, booking_id, status
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::thread_status)
            ON CONFLICT (source, source_thread_id) DO UPDATE SET
                channel = COALESCE(EXCLUDED.channel, message_threads.channel),
                guest_name = COALESCE(EXCLUDED.guest_name, message_threads.guest_name),
                guest_email = COALESCE(EXCLUDED.guest_email, message_threads.guest_email),
                source_booking_id = COALESCE(EXCLUDED.source_booking_id, message_threads.source_booking_id),
                booking_id = COALESCE(EXCLUDED.booking_id, message_threads.booking_id),
                status = EXCLUDED.status,
                updated_at = now()
            RETURNING *
            """,
            hotel_id,
            source,
            source_thread_id,
            channel,
            guest_name,
            guest_email,
            source_booking_id,
            booking_id,
            status,
        )
        return dict(row)

    @staticmethod
    async def list_by_hotel(
        hotel_id: str,
        *,
        status: str | None = None,
        limit: int = 50,
        before: datetime | None = None,
    ) -> list[dict]:
        if status and before:
            rows = await Database.fetch(
                """
                SELECT mt.*, b.booking_reference, b.check_in, b.check_out
                FROM message_threads mt
                LEFT JOIN bookings b ON b.id = mt.booking_id
                WHERE mt.hotel_id = $1
                  AND mt.status = $2::thread_status
                  AND mt.last_message_at < $3
                ORDER BY mt.last_message_at DESC NULLS LAST
                LIMIT $4
                """,
                hotel_id,
                status,
                before,
                limit,
            )
        elif status:
            rows = await Database.fetch(
                """
                SELECT mt.*, b.booking_reference, b.check_in, b.check_out
                FROM message_threads mt
                LEFT JOIN bookings b ON b.id = mt.booking_id
                WHERE mt.hotel_id = $1 AND mt.status = $2::thread_status
                ORDER BY mt.last_message_at DESC NULLS LAST
                LIMIT $3
                """,
                hotel_id,
                status,
                limit,
            )
        elif before:
            rows = await Database.fetch(
                """
                SELECT mt.*, b.booking_reference, b.check_in, b.check_out
                FROM message_threads mt
                LEFT JOIN bookings b ON b.id = mt.booking_id
                WHERE mt.hotel_id = $1 AND mt.last_message_at < $2
                ORDER BY mt.last_message_at DESC NULLS LAST
                LIMIT $3
                """,
                hotel_id,
                before,
                limit,
            )
        else:
            rows = await Database.fetch(
                """
                SELECT mt.*, b.booking_reference, b.check_in, b.check_out
                FROM message_threads mt
                LEFT JOIN bookings b ON b.id = mt.booking_id
                WHERE mt.hotel_id = $1
                ORDER BY mt.last_message_at DESC NULLS LAST
                LIMIT $2
                """,
                hotel_id,
                limit,
            )
        return [dict(r) for r in rows]

    @staticmethod
    async def update_status(thread_id: str, hotel_id: str, status: str) -> dict | None:
        row = await Database.fetchrow(
            """
            UPDATE message_threads
            SET status = $3::thread_status, updated_at = now()
            WHERE id = $1 AND hotel_id = $2
            RETURNING *
            """,
            thread_id,
            hotel_id,
            status,
        )
        return dict(row) if row else None

    @staticmethod
    async def mark_all_read(thread_id: str, hotel_id: str) -> dict | None:
        """Zero unread_count and stamp read_at on every unread inbound message.
        Single CTE keeps both updates in one statement."""
        row = await Database.fetchrow(
            """
            WITH msg_update AS (
                UPDATE messages
                SET read_at = now()
                WHERE thread_id = $1
                  AND direction = 'inbound'
                  AND read_at IS NULL
                RETURNING 1
            )
            UPDATE message_threads
            SET unread_count = 0, updated_at = now()
            WHERE id = $1 AND hotel_id = $2
            RETURNING *
            """,
            thread_id,
            hotel_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def hotel_unread_count(hotel_id: str) -> int:
        row = await Database.fetchrow(
            "SELECT COALESCE(SUM(unread_count), 0)::int AS n "
            "FROM message_threads WHERE hotel_id = $1",
            hotel_id,
        )
        return int(row["n"]) if row else 0


class MessageRepository:
    @staticmethod
    async def get_by_source_message_id(thread_id: str, source_message_id: str) -> dict | None:
        row = await Database.fetchrow(
            "SELECT * FROM messages WHERE thread_id = $1 AND source_message_id = $2",
            thread_id,
            source_message_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def insert_and_update_thread(
        *,
        thread_id: str,
        source_message_id: str,
        direction: str,
        sender_name: str | None,
        body: str,
        sent_at: datetime,
        raw_payload: dict | None = None,
        automated: bool = False,
    ) -> dict | None:
        """Insert message + update parent thread's last_message_* and unread_count
        in one CTE. Returns None if a row with (thread_id, source_message_id)
        already existed (idempotent against webhook re-delivery)."""
        import json

        payload_json = json.dumps(raw_payload) if raw_payload is not None else None
        preview = (body or "")[:200]
        unread_delta = 1 if direction == "inbound" else 0
        row = await Database.fetchrow(
            """
            WITH inserted AS (
                INSERT INTO messages (
                    thread_id, source_message_id, direction, sender_name,
                    body, sent_at, raw_payload, automated
                )
                VALUES ($1, $2, $3::message_direction, $4, $5, $6, $7::jsonb, $10)
                ON CONFLICT (thread_id, source_message_id) DO NOTHING
                RETURNING *
            ), thread_update AS (
                UPDATE message_threads
                SET last_message_at = GREATEST(COALESCE(last_message_at, $6), $6),
                    last_message_preview = $8,
                    last_message_direction = $3::message_direction,
                    unread_count = unread_count + $9,
                    updated_at = now()
                WHERE id = $1 AND EXISTS (SELECT 1 FROM inserted)
                RETURNING 1
            )
            SELECT * FROM inserted
            """,
            thread_id,
            source_message_id,
            direction,
            sender_name,
            body,
            sent_at,
            payload_json,
            preview,
            unread_delta,
            automated,
        )
        return dict(row) if row else None

    @staticmethod
    async def list_by_thread(thread_id: str) -> list[dict]:
        rows = await Database.fetch(
            "SELECT * FROM messages WHERE thread_id = $1 ORDER BY sent_at ASC",
            thread_id,
        )
        return [dict(r) for r in rows]


class MessageAttachmentRepository:
    @staticmethod
    async def add(
        *,
        message_id: str,
        s3_key: str | None = None,
        source_url: str | None = None,
        filename: str | None = None,
        content_type: str | None = None,
        size_bytes: int | None = None,
        source_attachment_id: str | None = None,
    ) -> dict:
        row = await Database.fetchrow(
            """
            INSERT INTO message_attachments (
                message_id, s3_key, source_url, filename,
                content_type, size_bytes, source_attachment_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *
            """,
            message_id,
            s3_key,
            source_url,
            filename,
            content_type,
            size_bytes,
            source_attachment_id,
        )
        return dict(row)

    @staticmethod
    async def list_by_message(message_id: str) -> list[dict]:
        rows = await Database.fetch(
            "SELECT * FROM message_attachments WHERE message_id = $1 ORDER BY created_at ASC",
            message_id,
        )
        return [dict(r) for r in rows]

    @staticmethod
    async def list_by_thread(thread_id: str) -> list[dict]:
        rows = await Database.fetch(
            """
            SELECT a.* FROM message_attachments a
            JOIN messages m ON m.id = a.message_id
            WHERE m.thread_id = $1
            ORDER BY a.created_at ASC
            """,
            thread_id,
        )
        return [dict(r) for r in rows]
