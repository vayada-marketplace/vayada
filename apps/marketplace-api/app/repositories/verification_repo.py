"""
Repository for email_verification_codes and email_verification_tokens tables (AuthDatabase).
"""
from typing import Optional
from datetime import datetime, timedelta, timezone

import asyncpg

from app.database import AuthDatabase


class VerificationRepository:

    # ── email_verification_codes ──

    @staticmethod
    async def invalidate_codes_for_email(
        email: str, *, conn: Optional[asyncpg.Connection] = None
    ) -> None:
        query = """
            UPDATE email_verification_codes
            SET used = true
            WHERE email = $1 AND used = false AND expires_at > now()
        """
        if conn:
            await conn.execute(query, email)
        else:
            await AuthDatabase.execute(query, email)

    @staticmethod
    async def create_code(
        email: str,
        code: str,
        expires_in_minutes: int = 15,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> None:
        expires_at = datetime.now(timezone.utc) + timedelta(minutes=expires_in_minutes)
        query = """
            INSERT INTO email_verification_codes (email, code, expires_at)
            VALUES ($1, $2, $3)
        """
        if conn:
            await conn.execute(query, email, code, expires_at)
        else:
            await AuthDatabase.execute(query, email, code, expires_at)

    @staticmethod
    async def get_valid_code(
        email: str,
        code: str,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> Optional[dict]:
        query = """
            SELECT id, expires_at, used, created_at
            FROM email_verification_codes
            WHERE email = $1
              AND code = $2
              AND used = false
              AND expires_at > now()
            ORDER BY created_at DESC
            LIMIT 1
        """
        if conn:
            row = await conn.fetchrow(query, email, code)
        else:
            row = await AuthDatabase.fetchrow(query, email, code)
        return dict(row) if row else None

    @staticmethod
    async def mark_code_used(
        code_id, *, conn: Optional[asyncpg.Connection] = None
    ) -> None:
        query = """
            UPDATE email_verification_codes
            SET used = true
            WHERE id = $1
        """
        if conn:
            await conn.execute(query, code_id)
        else:
            await AuthDatabase.execute(query, code_id)

    # ── email_verification_tokens ──

    @staticmethod
    async def invalidate_tokens_for_user(
        user_id: str, *, conn: Optional[asyncpg.Connection] = None
    ) -> None:
        query = """
            UPDATE email_verification_tokens
            SET used = true
            WHERE user_id = $1 AND used = false AND expires_at > now()
        """
        if conn:
            await conn.execute(query, user_id)
        else:
            await AuthDatabase.execute(query, user_id)

    @staticmethod
    async def create_token(
        user_id: str,
        token: str,
        expires_in_hours: int = 48,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> None:
        expires_at = datetime.now(timezone.utc) + timedelta(hours=expires_in_hours)
        query = """
            INSERT INTO email_verification_tokens (user_id, token, expires_at)
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
            SELECT evt.id, evt.user_id, evt.expires_at, evt.used, u.email, u.status
            FROM email_verification_tokens evt
            JOIN users u ON u.id = evt.user_id
            WHERE evt.token = $1
        """
        if conn:
            row = await conn.fetchrow(query, token)
        else:
            row = await AuthDatabase.fetchrow(query, token)
        return dict(row) if row else None

    @staticmethod
    async def mark_token_used(
        token: str, *, conn: Optional[asyncpg.Connection] = None
    ) -> bool:
        query = """
            UPDATE email_verification_tokens
            SET used = true
            WHERE token = $1 AND used = false
        """
        if conn:
            result = await conn.execute(query, token)
        else:
            result = await AuthDatabase.execute(query, token)
        return result == "UPDATE 1"
