from typing import Optional, List
from datetime import datetime

from app.database import Database


class ConversationRepository:

    @staticmethod
    async def create(data: dict) -> dict:
        row = await Database.fetchrow(
            """
            INSERT INTO conversations
                (hotel_id, booking_id, channel, guest_name, guest_email, subject,
                 status, beds24_booking_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING *
            """,
            data["hotel_id"],
            data.get("booking_id"),
            data.get("channel", "direct"),
            data.get("guest_name", ""),
            data.get("guest_email", ""),
            data.get("subject", ""),
            data.get("status", "open"),
            data.get("beds24_booking_id"),
        )
        return dict(row)

    @staticmethod
    async def get_by_id(conversation_id: str) -> Optional[dict]:
        row = await Database.fetchrow(
            """
            SELECT c.*,
                   b.booking_reference,
                   COALESCE(rt.name, '') AS room_name
            FROM conversations c
            LEFT JOIN bookings b ON b.id = c.booking_id
            LEFT JOIN room_types rt ON rt.id = b.room_type_id
            WHERE c.id = $1
            """,
            conversation_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def get_by_booking_id(booking_id: str) -> Optional[dict]:
        row = await Database.fetchrow(
            "SELECT * FROM conversations WHERE booking_id = $1",
            booking_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def get_by_beds24_booking_id(beds24_booking_id: str) -> Optional[dict]:
        row = await Database.fetchrow(
            "SELECT * FROM conversations WHERE beds24_booking_id = $1",
            beds24_booking_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def list_by_hotel_id(
        hotel_id: str,
        status: Optional[str] = None,
        channel: Optional[str] = None,
        search: Optional[str] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> List[dict]:
        conditions = ["c.hotel_id = $1"]
        params: list = [hotel_id]
        idx = 2

        if status:
            conditions.append(f"c.status = ${idx}")
            params.append(status)
            idx += 1

        if channel:
            conditions.append(f"c.channel = ${idx}")
            params.append(channel)
            idx += 1

        if search:
            conditions.append(f"(c.guest_name ILIKE ${idx} OR c.guest_email ILIKE ${idx} OR b.booking_reference ILIKE ${idx})")
            params.append(f"%{search}%")
            idx += 1

        where = " AND ".join(conditions)
        params.extend([limit, offset])

        rows = await Database.fetch(
            f"""
            SELECT c.*,
                   b.booking_reference,
                   COALESCE(rt.name, '') AS room_name,
                   (SELECT body FROM messages m
                    WHERE m.conversation_id = c.id
                    ORDER BY m.created_at DESC LIMIT 1) AS last_message_preview
            FROM conversations c
            LEFT JOIN bookings b ON b.id = c.booking_id
            LEFT JOIN room_types rt ON rt.id = b.room_type_id
            WHERE {where}
            ORDER BY c.last_message_at DESC NULLS LAST
            LIMIT ${idx} OFFSET ${idx + 1}
            """,
            *params,
        )
        return [dict(r) for r in rows]

    @staticmethod
    async def count_by_hotel_id(
        hotel_id: str,
        status: Optional[str] = None,
        channel: Optional[str] = None,
        search: Optional[str] = None,
    ) -> int:
        conditions = ["c.hotel_id = $1"]
        params: list = [hotel_id]
        idx = 2

        if status:
            conditions.append(f"c.status = ${idx}")
            params.append(status)
            idx += 1

        if channel:
            conditions.append(f"c.channel = ${idx}")
            params.append(channel)
            idx += 1

        if search:
            conditions.append(f"(c.guest_name ILIKE ${idx} OR c.guest_email ILIKE ${idx} OR b.booking_reference ILIKE ${idx})")
            params.append(f"%{search}%")
            idx += 1

        where = " AND ".join(conditions)
        row = await Database.fetchrow(
            f"""
            SELECT COUNT(*) AS cnt
            FROM conversations c
            LEFT JOIN bookings b ON b.id = c.booking_id
            WHERE {where}
            """,
            *params,
        )
        return row["cnt"]

    @staticmethod
    async def count_unread_by_hotel_id(hotel_id: str) -> int:
        row = await Database.fetchrow(
            "SELECT COALESCE(SUM(unread_count), 0) AS cnt FROM conversations WHERE hotel_id = $1 AND status = 'open'",
            hotel_id,
        )
        return row["cnt"]

    @staticmethod
    async def update_status(conversation_id: str, status: str) -> dict:
        row = await Database.fetchrow(
            """
            UPDATE conversations
            SET status = $2, updated_at = now()
            WHERE id = $1
            RETURNING *
            """,
            conversation_id, status,
        )
        return dict(row) if row else None

    @staticmethod
    async def increment_unread(conversation_id: str) -> None:
        await Database.execute(
            """
            UPDATE conversations
            SET unread_count = unread_count + 1, updated_at = now()
            WHERE id = $1
            """,
            conversation_id,
        )

    @staticmethod
    async def reset_unread(conversation_id: str) -> None:
        await Database.execute(
            """
            UPDATE conversations
            SET unread_count = 0, updated_at = now()
            WHERE id = $1
            """,
            conversation_id,
        )

    @staticmethod
    async def update_last_message(conversation_id: str, timestamp: datetime) -> None:
        await Database.execute(
            """
            UPDATE conversations
            SET last_message_at = $2, updated_at = now()
            WHERE id = $1
            """,
            conversation_id, timestamp,
        )

    @staticmethod
    async def get_or_create_for_booking(
        hotel_id: str,
        booking_id: str,
        channel: str,
        guest_name: str,
        guest_email: str,
        beds24_booking_id: Optional[str] = None,
    ) -> dict:
        existing = await ConversationRepository.get_by_booking_id(booking_id)
        if existing:
            return existing

        return await ConversationRepository.create({
            "hotel_id": hotel_id,
            "booking_id": booking_id,
            "channel": channel,
            "guest_name": guest_name,
            "guest_email": guest_email,
            "beds24_booking_id": beds24_booking_id,
        })


class MessageRepository:

    @staticmethod
    async def create(data: dict) -> dict:
        row = await Database.fetchrow(
            """
            INSERT INTO messages
                (conversation_id, sender_type, sender_name, body, channel, beds24_message_id, is_read)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *
            """,
            data["conversation_id"],
            data["sender_type"],
            data.get("sender_name", ""),
            data["body"],
            data.get("channel", "direct"),
            data.get("beds24_message_id"),
            data.get("is_read", False),
        )
        return dict(row)

    @staticmethod
    async def list_by_conversation(
        conversation_id: str,
        limit: int = 100,
        offset: int = 0,
    ) -> List[dict]:
        rows = await Database.fetch(
            """
            SELECT * FROM messages
            WHERE conversation_id = $1
            ORDER BY created_at ASC
            LIMIT $2 OFFSET $3
            """,
            conversation_id, limit, offset,
        )
        return [dict(r) for r in rows]

    @staticmethod
    async def count_by_conversation(conversation_id: str) -> int:
        row = await Database.fetchrow(
            "SELECT COUNT(*) AS cnt FROM messages WHERE conversation_id = $1",
            conversation_id,
        )
        return row["cnt"]

    @staticmethod
    async def exists_by_beds24_id(beds24_message_id: str) -> bool:
        row = await Database.fetchrow(
            "SELECT 1 FROM messages WHERE beds24_message_id = $1",
            beds24_message_id,
        )
        return row is not None

    @staticmethod
    async def mark_all_read(conversation_id: str) -> None:
        await Database.execute(
            "UPDATE messages SET is_read = true WHERE conversation_id = $1 AND is_read = false",
            conversation_id,
        )


class MessageSyncStateRepository:

    @staticmethod
    async def get_or_create(hotel_id: str) -> dict:
        row = await Database.fetchrow(
            "SELECT * FROM message_sync_state WHERE hotel_id = $1",
            hotel_id,
        )
        if row:
            return dict(row)

        row = await Database.fetchrow(
            """
            INSERT INTO message_sync_state (hotel_id)
            VALUES ($1)
            ON CONFLICT (hotel_id) DO NOTHING
            RETURNING *
            """,
            hotel_id,
        )
        if row:
            return dict(row)

        # Race condition fallback
        row = await Database.fetchrow(
            "SELECT * FROM message_sync_state WHERE hotel_id = $1",
            hotel_id,
        )
        return dict(row)

    @staticmethod
    async def update_last_polled(hotel_id: str, timestamp: datetime) -> None:
        await Database.execute(
            """
            UPDATE message_sync_state
            SET last_polled_at = $2, updated_at = now()
            WHERE hotel_id = $1
            """,
            hotel_id, timestamp,
        )
