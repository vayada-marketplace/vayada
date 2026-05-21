"""
Repository for notifications table (marketplace Database).
"""

import asyncpg

from app.database import Database


class NotificationRepository:
    @staticmethod
    async def create(
        user_id: str,
        type: str,
        title: str,
        body: str,
        link_url: str | None = None,
        *,
        conn: asyncpg.Connection | None = None,
    ) -> dict:
        query = """
            INSERT INTO notifications (user_id, type, title, body, link_url)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id, user_id, type, title, body, link_url, read_at, created_at
        """
        args = (user_id, type, title, body, link_url)
        if conn:
            row = await conn.fetchrow(query, *args)
        else:
            row = await Database.fetchrow(query, *args)
        return dict(row)

    @staticmethod
    async def list_for_user(
        user_id: str,
        *,
        unread_only: bool = False,
        limit: int = 50,
        conn: asyncpg.Connection | None = None,
    ) -> list[dict]:
        clauses = ["user_id = $1"]
        if unread_only:
            clauses.append("read_at IS NULL")
        query = f"""
            SELECT id, user_id, type, title, body, link_url, read_at, created_at
            FROM notifications
            WHERE {" AND ".join(clauses)}
            ORDER BY created_at DESC
            LIMIT $2
        """
        if conn:
            rows = await conn.fetch(query, user_id, limit)
        else:
            rows = await Database.fetch(query, user_id, limit)
        return [dict(r) for r in rows]

    @staticmethod
    async def count_unread(
        user_id: str,
        *,
        conn: asyncpg.Connection | None = None,
    ) -> int:
        query = "SELECT COUNT(*) AS c FROM notifications WHERE user_id = $1 AND read_at IS NULL"
        if conn:
            row = await conn.fetchrow(query, user_id)
        else:
            row = await Database.fetchrow(query, user_id)
        return int(row["c"]) if row else 0

    @staticmethod
    async def mark_read(
        notification_id: str,
        user_id: str,
        *,
        conn: asyncpg.Connection | None = None,
    ) -> bool:
        """Mark a notification as read. Returns True if a row was updated.

        The user_id check ensures one user cannot read another's notifications.
        """
        query = """
            UPDATE notifications
            SET read_at = now()
            WHERE id = $1 AND user_id = $2 AND read_at IS NULL
        """
        if conn:
            result = await conn.execute(query, notification_id, user_id)
        else:
            result = await Database.execute(query, notification_id, user_id)
        return result == "UPDATE 1"

    @staticmethod
    async def count_by_type_for_user(
        user_id: str,
        type: str,
        *,
        conn: asyncpg.Connection | None = None,
    ) -> int:
        query = "SELECT COUNT(*) AS c FROM notifications WHERE user_id = $1 AND type = $2"
        if conn:
            row = await conn.fetchrow(query, user_id, type)
        else:
            row = await Database.fetchrow(query, user_id, type)
        return int(row["c"]) if row else 0
