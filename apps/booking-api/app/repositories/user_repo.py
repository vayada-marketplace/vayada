"""
Repository for users table (AuthDatabase).
"""
from typing import Optional

import asyncpg

from app.database import AuthDatabase


class UserRepository:

    @staticmethod
    async def get_by_email(
        email: str, *, conn: Optional[asyncpg.Connection] = None
    ) -> Optional[dict]:
        query = "SELECT * FROM users WHERE email = $1"
        if conn:
            row = await conn.fetchrow(query, email)
        else:
            row = await AuthDatabase.fetchrow(query, email)
        return dict(row) if row else None

    @staticmethod
    async def get_by_id(
        user_id: str,
        *,
        columns: str = "*",
        conn: Optional[asyncpg.Connection] = None,
    ) -> Optional[dict]:
        query = f"SELECT {columns} FROM users WHERE id = $1"
        if conn:
            row = await conn.fetchrow(query, user_id)
        else:
            row = await AuthDatabase.fetchrow(query, user_id)
        return dict(row) if row else None

    @staticmethod
    async def exists_by_email(
        email: str, *, conn: Optional[asyncpg.Connection] = None
    ) -> bool:
        query = "SELECT id FROM users WHERE email = $1"
        if conn:
            row = await conn.fetchrow(query, email)
        else:
            row = await AuthDatabase.fetchrow(query, email)
        return row is not None

    @staticmethod
    async def create(
        email: str,
        password_hash: str,
        name: str,
        terms_version: str,
        privacy_version: str,
        marketing_consent: bool,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> dict:
        query = """
            INSERT INTO users (
                email, password_hash, name, type, status,
                terms_accepted_at, terms_version,
                privacy_accepted_at, privacy_version,
                marketing_consent, marketing_consent_at
            )
            VALUES ($1, $2, $3, 'hotel', 'pending', now(), $4, now(), $5, $6, CASE WHEN $6 THEN now() ELSE NULL END)
            RETURNING id, email, name, type, status
        """
        args = (email, password_hash, name, terms_version, privacy_version, marketing_consent)
        if conn:
            row = await conn.fetchrow(query, *args)
        else:
            row = await AuthDatabase.fetchrow(query, *args)
        return dict(row)

    @staticmethod
    async def update_password(
        user_id: str,
        password_hash: str,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> None:
        query = """
            UPDATE users
            SET password_hash = $1, updated_at = now()
            WHERE id = $2
        """
        if conn:
            await conn.execute(query, password_hash, user_id)
        else:
            await AuthDatabase.execute(query, password_hash, user_id)
