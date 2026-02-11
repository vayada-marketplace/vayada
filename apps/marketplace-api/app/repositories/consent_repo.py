"""
Repository for consent_history, cookie_consent tables (AuthDatabase).
"""
from typing import Optional

import asyncpg

from app.database import AuthDatabase


class ConsentRepository:

    # ── consent_history ──

    @staticmethod
    async def record(
        user_id,
        consent_type: str,
        consent_given: bool,
        version: Optional[str] = None,
        ip_address: Optional[str] = None,
        user_agent: Optional[str] = None,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> None:
        if version is not None and ip_address is not None:
            query = """
                INSERT INTO consent_history (user_id, consent_type, consent_given, version, ip_address, user_agent)
                VALUES ($1, $2, $3, $4, $5, $6)
            """
            args = (user_id, consent_type, consent_given, version, ip_address, user_agent)
        elif version is not None:
            query = """
                INSERT INTO consent_history (user_id, consent_type, consent_given, version)
                VALUES ($1, $2, $3, $4)
            """
            args = (user_id, consent_type, consent_given, version)
        elif ip_address is not None:
            query = """
                INSERT INTO consent_history (user_id, consent_type, consent_given, ip_address, user_agent)
                VALUES ($1, $2, $3, $4, $5)
            """
            args = (user_id, consent_type, consent_given, ip_address, user_agent)
        else:
            query = """
                INSERT INTO consent_history (user_id, consent_type, consent_given)
                VALUES ($1, $2, $3)
            """
            args = (user_id, consent_type, consent_given)

        if conn:
            await conn.execute(query, *args)
        else:
            await AuthDatabase.execute(query, *args)

    @staticmethod
    async def get_history(
        user_id: str,
        limit: int = 50,
        offset: int = 0,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> list:
        query = """
            SELECT id, consent_type, consent_given, version, created_at
            FROM consent_history
            WHERE user_id = $1
            ORDER BY created_at DESC
            LIMIT $2 OFFSET $3
        """
        if conn:
            rows = await conn.fetch(query, user_id, limit, offset)
        else:
            rows = await AuthDatabase.fetch(query, user_id, limit, offset)
        return [dict(r) for r in rows]

    @staticmethod
    async def count_history(
        user_id: str,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> int:
        query = "SELECT COUNT(*) as total FROM consent_history WHERE user_id = $1"
        if conn:
            row = await conn.fetchrow(query, user_id)
        else:
            row = await AuthDatabase.fetchrow(query, user_id)
        return row['total'] if row else 0

    @staticmethod
    async def get_all_history(
        user_id: str,
        *,
        columns: str = "*",
        conn: Optional[asyncpg.Connection] = None,
    ) -> list:
        """Return all consent history records (no pagination) for GDPR export."""
        query = f"SELECT {columns} FROM consent_history WHERE user_id = $1 ORDER BY created_at DESC"
        if conn:
            rows = await conn.fetch(query, user_id)
        else:
            rows = await AuthDatabase.fetch(query, user_id)
        return [dict(r) for r in rows]

    # ── cookie_consent ──

    @staticmethod
    async def get_cookie_consent(
        visitor_id: str,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> Optional[dict]:
        query = """
            SELECT id, visitor_id, user_id, necessary, functional, analytics, marketing, created_at, updated_at
            FROM cookie_consent WHERE visitor_id = $1
        """
        if conn:
            row = await conn.fetchrow(query, visitor_id)
        else:
            row = await AuthDatabase.fetchrow(query, visitor_id)
        return dict(row) if row else None

    @staticmethod
    async def get_cookie_consents_by_user_id(
        user_id: str,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> list:
        query = "SELECT * FROM cookie_consent WHERE user_id = $1"
        if conn:
            rows = await conn.fetch(query, user_id)
        else:
            rows = await AuthDatabase.fetch(query, user_id)
        return [dict(r) for r in rows]

    @staticmethod
    async def upsert_cookie_consent(
        visitor_id: str,
        user_id: Optional[str],
        necessary: bool,
        functional: bool,
        analytics: bool,
        marketing: bool,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> dict:
        """Insert or update cookie consent, returning the resulting row."""
        # Check if exists
        existing = await ConsentRepository.get_cookie_consent(visitor_id, conn=conn)

        if existing:
            query = """
                UPDATE cookie_consent
                SET user_id = COALESCE($1, user_id),
                    necessary = $2,
                    functional = $3,
                    analytics = $4,
                    marketing = $5,
                    updated_at = now()
                WHERE visitor_id = $6
                RETURNING id, visitor_id, user_id, necessary, functional, analytics, marketing, created_at, updated_at
            """
            args = (user_id, necessary, functional, analytics, marketing, visitor_id)
        else:
            query = """
                INSERT INTO cookie_consent (visitor_id, user_id, necessary, functional, analytics, marketing)
                VALUES ($1, $2, $3, $4, $5, $6)
                RETURNING id, visitor_id, user_id, necessary, functional, analytics, marketing, created_at, updated_at
            """
            args = (visitor_id, user_id, necessary, functional, analytics, marketing)

        if conn:
            row = await conn.fetchrow(query, *args)
        else:
            row = await AuthDatabase.fetchrow(query, *args)
        return dict(row)

    # ── marketing consent (users table) ──

    @staticmethod
    async def update_marketing_consent(
        user_id: str,
        marketing_consent: bool,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> Optional[dict]:
        query = """
            UPDATE users
            SET marketing_consent = $1,
                marketing_consent_at = now(),
                updated_at = now()
            WHERE id = $2
            RETURNING marketing_consent, marketing_consent_at
        """
        if conn:
            row = await conn.fetchrow(query, marketing_consent, user_id)
        else:
            row = await AuthDatabase.fetchrow(query, marketing_consent, user_id)
        return dict(row) if row else None

    @staticmethod
    async def get_consent_status(
        user_id: str,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> Optional[dict]:
        query = """
            SELECT
                terms_accepted_at,
                terms_version,
                privacy_accepted_at,
                privacy_version,
                marketing_consent,
                marketing_consent_at
            FROM users
            WHERE id = $1
        """
        if conn:
            row = await conn.fetchrow(query, user_id)
        else:
            row = await AuthDatabase.fetchrow(query, user_id)
        return dict(row) if row else None
