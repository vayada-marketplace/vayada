"""
Repository for chat_messages table (Database).
"""
from typing import Optional

import asyncpg

from app.database import Database


class ChatRepository:

    @staticmethod
    async def create_system_message(
        collaboration_id: str,
        content: str,
        metadata_json: Optional[str] = None,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> None:
        query = """
            INSERT INTO chat_messages (collaboration_id, sender_id, content, message_type, metadata)
            VALUES ($1, NULL, $2, 'system', $3)
        """
        if conn:
            await conn.execute(query, collaboration_id, content, metadata_json)
        else:
            await Database.execute(query, collaboration_id, content, metadata_json)

    @staticmethod
    async def get_conversations(
        user_id: str,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> list:
        """Get all chat threads for a user with latest message and unread count."""
        query = """
            WITH user_collabs AS (
                SELECT
                    c.id as collab_id,
                    c.status as collab_status,
                    c.listing_id,
                    CASE
                        WHEN cr.user_id = $1 THEN 'creator'
                        WHEN hp.user_id = $1 THEN 'hotel'
                    END as my_role,
                    CASE
                        WHEN cr.user_id = $1 THEN hp.user_id
                        ELSE cr.user_id
                    END as partner_user_id
                FROM collaborations c
                JOIN creators cr ON cr.id = c.creator_id
                JOIN hotel_profiles hp ON hp.id = c.hotel_id
                WHERE (cr.user_id = $1 OR hp.user_id = $1)
                  AND c.status != 'pending'
            ),
            latest_messages AS (
                SELECT DISTINCT ON (collaboration_id)
                    collaboration_id, content, created_at, message_type
                FROM chat_messages
                ORDER BY collaboration_id, created_at DESC
            ),
            unread_counts AS (
                SELECT collaboration_id, COUNT(*) as count
                FROM chat_messages
                WHERE read_at IS NULL AND sender_id != $1
                GROUP BY collaboration_id
            )
            SELECT
                uc.collab_id,
                uc.collab_status,
                uc.my_role,
                uc.partner_user_id,
                COALESCE(p_creator.profile_picture, p_hotel.picture) as partner_avatar,
                lm.content as last_message_content,
                lm.created_at as last_message_at,
                lm.message_type as last_message_type,
                COALESCE(un.count, 0) as unread_count,
                l.name as listing_name
            FROM user_collabs uc
            LEFT JOIN creators p_creator ON p_creator.user_id = uc.partner_user_id
            LEFT JOIN hotel_profiles p_hotel ON p_hotel.user_id = uc.partner_user_id
            LEFT JOIN latest_messages lm ON lm.collaboration_id = uc.collab_id
            LEFT JOIN unread_counts un ON un.collaboration_id = uc.collab_id
            LEFT JOIN hotel_listings l ON l.id = uc.listing_id
            ORDER BY COALESCE(lm.created_at, '1970-01-01') DESC
        """
        if conn:
            rows = await conn.fetch(query, user_id)
        else:
            rows = await Database.fetch(query, user_id)
        return [dict(r) for r in rows]

    @staticmethod
    async def get_messages(
        collaboration_id: str,
        before=None,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> list:
        """Fetch chat messages for a collaboration with sender avatars."""
        query = """
            SELECT m.*,
                   CASE
                       WHEN c.profile_picture IS NOT NULL THEN c.profile_picture
                       WHEN hp.picture IS NOT NULL THEN hp.picture
                       ELSE NULL
                   END as sender_avatar
            FROM chat_messages m
            LEFT JOIN creators c ON c.user_id = m.sender_id
            LEFT JOIN hotel_profiles hp ON hp.user_id = m.sender_id
            WHERE m.collaboration_id = $1
        """
        params = [collaboration_id]
        param_idx = 2

        if before:
            query += f" AND m.created_at < ${param_idx}"
            params.append(before)

        query += " ORDER BY m.created_at DESC LIMIT 50"

        if conn:
            rows = await conn.fetch(query, *params)
        else:
            rows = await Database.fetch(query, *params)
        return [dict(r) for r in rows]

    @staticmethod
    async def send_message(
        collaboration_id: str,
        sender_id: str,
        content: str,
        message_type: str,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> dict:
        query = """
            INSERT INTO chat_messages (collaboration_id, sender_id, content, message_type)
            VALUES ($1, $2, $3, $4)
            RETURNING id, created_at
        """
        if conn:
            row = await conn.fetchrow(query, collaboration_id, sender_id, content, message_type)
        else:
            row = await Database.fetchrow(query, collaboration_id, sender_id, content, message_type)
        return dict(row)

    @staticmethod
    async def mark_as_read(
        collaboration_id: str,
        user_id: str,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> None:
        query = """
            UPDATE chat_messages
            SET read_at = NOW()
            WHERE collaboration_id = $1
              AND (sender_id != $2 OR sender_id IS NULL)
              AND read_at IS NULL
        """
        if conn:
            await conn.execute(query, collaboration_id, user_id)
        else:
            await Database.execute(query, collaboration_id, user_id)
