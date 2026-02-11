"""
Repository for password_reset_tokens table (AuthDatabase).
"""
from typing import Optional
from datetime import datetime, timedelta, timezone

import asyncpg

from app.database import AuthDatabase


class PasswordResetRepository:

    @staticmethod
    async def create(
        user_id: str,
        token: str,
        expires_in_hours: int = 1,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> None:
        expires_at = datetime.now(timezone.utc) + timedelta(hours=expires_in_hours)
        query = """
            INSERT INTO password_reset_tokens (user_id, token, expires_at)
            VALUES ($1, $2, $3)
        """
        if conn:
            await conn.execute(query, user_id, token, expires_at)
        else:
            await AuthDatabase.execute(query, user_id, token, expires_at)

    @staticmethod
    async def get_valid_token(
        token: str, *, conn: Optional[asyncpg.Connection] = None
    ) -> Optional[dict]:
        query = """
            SELECT prt.id, prt.user_id, prt.expires_at, prt.used, u.email, u.status
            FROM password_reset_tokens prt
            JOIN users u ON u.id = prt.user_id
            WHERE prt.token = $1
        """
        if conn:
            row = await conn.fetchrow(query, token)
        else:
            row = await AuthDatabase.fetchrow(query, token)
        return dict(row) if row else None

    @staticmethod
    async def mark_used(
        token: str, *, conn: Optional[asyncpg.Connection] = None
    ) -> bool:
        query = """
            UPDATE password_reset_tokens
            SET used = true
            WHERE token = $1 AND used = false
        """
        if conn:
            result = await conn.execute(query, token)
        else:
            result = await AuthDatabase.execute(query, token)
        return result == "UPDATE 1"

    @staticmethod
    async def invalidate_all_for_user(
        user_id: str, *, conn: Optional[asyncpg.Connection] = None
    ) -> None:
        query = """
            UPDATE password_reset_tokens
            SET used = true
            WHERE user_id = $1 AND used = false
        """
        if conn:
            await conn.execute(query, user_id)
        else:
            await AuthDatabase.execute(query, user_id)
