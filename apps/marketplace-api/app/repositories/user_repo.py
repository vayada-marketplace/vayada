"""
Repository for users table (AuthDatabase).
"""

import asyncpg

from app.database import AuthDatabase
from app.repositories._sql import safe_columns


class UserRepository:
    @staticmethod
    async def get_by_email(email: str, *, conn: asyncpg.Connection | None = None) -> dict | None:
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
        conn: asyncpg.Connection | None = None,
    ) -> dict | None:
        query = f"SELECT {safe_columns(columns)} FROM users WHERE id = $1"
        if conn:
            row = await conn.fetchrow(query, user_id)
        else:
            row = await AuthDatabase.fetchrow(query, user_id)
        return dict(row) if row else None

    @staticmethod
    async def exists_by_email(email: str, *, conn: asyncpg.Connection | None = None) -> bool:
        query = "SELECT id FROM users WHERE email = $1"
        if conn:
            row = await conn.fetchrow(query, email)
        else:
            row = await AuthDatabase.fetchrow(query, email)
        return row is not None

    @staticmethod
    async def has_workos_identity(
        user_id: str, *, conn: asyncpg.Connection | None = None
    ) -> bool:
        query = """
            SELECT 1
            FROM identity.external_identities
            WHERE user_id = $1::uuid
              AND provider = 'workos'
            LIMIT 1
        """
        try:
            if conn:
                row = await conn.fetchrow(query, user_id)
            else:
                row = await AuthDatabase.fetchrow(query, user_id)
        except (asyncpg.UndefinedSchemaError, asyncpg.UndefinedTableError):
            return False
        return row is not None

    @staticmethod
    async def create(
        email: str,
        password_hash: str,
        name: str,
        user_type: str,
        terms_version: str,
        privacy_version: str,
        marketing_consent: bool,
        *,
        conn: asyncpg.Connection | None = None,
    ) -> dict:
        query = """
            INSERT INTO users (
                email, password_hash, name, type, status,
                terms_accepted_at, terms_version,
                privacy_accepted_at, privacy_version,
                marketing_consent, marketing_consent_at
            )
            VALUES ($1, $2, $3, $4, 'pending', now(), $5, now(), $6, $7, CASE WHEN $7 THEN now() ELSE NULL END)
            RETURNING id, email, name, type, status
        """
        args = (
            email,
            password_hash,
            name,
            user_type,
            terms_version,
            privacy_version,
            marketing_consent,
        )
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
        conn: asyncpg.Connection | None = None,
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

    @staticmethod
    async def mark_email_verified(email: str, *, conn: asyncpg.Connection | None = None) -> bool:
        query = """
            UPDATE users
            SET email_verified = true
            WHERE email = $1
        """
        if conn:
            result = await conn.execute(query, email)
        else:
            result = await AuthDatabase.execute(query, email)
        return result == "UPDATE 1"

    @staticmethod
    async def delete(user_id: str, *, conn: asyncpg.Connection | None = None) -> None:
        query = "DELETE FROM users WHERE id = $1"
        if conn:
            await conn.execute(query, user_id)
        else:
            await AuthDatabase.execute(query, user_id)

    @staticmethod
    async def update_name(
        user_id: str,
        name: str,
        *,
        conn: asyncpg.Connection | None = None,
    ) -> None:
        query = "UPDATE users SET name = $1, updated_at = now() WHERE id = $2"
        if conn:
            await conn.execute(query, name, user_id)
        else:
            await AuthDatabase.execute(query, name, user_id)

    @staticmethod
    async def update_email(
        user_id: str,
        email: str,
        *,
        conn: asyncpg.Connection | None = None,
    ) -> None:
        query = "UPDATE users SET email = $1, updated_at = now() WHERE id = $2"
        if conn:
            await conn.execute(query, email, user_id)
        else:
            await AuthDatabase.execute(query, email, user_id)

    @staticmethod
    async def get_verified_users(
        *,
        columns: str = "id",
        conn: asyncpg.Connection | None = None,
    ) -> list:
        """Return all users with status = 'verified'."""
        query = f"SELECT {safe_columns(columns)} FROM users WHERE status = 'verified'"
        if conn:
            rows = await conn.fetch(query)
        else:
            rows = await AuthDatabase.fetch(query)
        return [dict(r) for r in rows]

    @staticmethod
    async def batch_get_by_ids(
        user_ids: list[str],
        *,
        columns: str = "id, name, status",
        conn: asyncpg.Connection | None = None,
    ) -> dict:
        """Return {user_id_str: dict} mapping for a list of user IDs."""
        if not user_ids:
            return {}
        query = f"SELECT {safe_columns(columns)} FROM users WHERE id = ANY($1::uuid[])"
        if conn:
            rows = await conn.fetch(query, user_ids)
        else:
            rows = await AuthDatabase.fetch(query, user_ids)
        return {str(row["id"]): dict(row) for row in rows}

    @staticmethod
    async def batch_get_names(
        user_ids: list[str], *, conn: asyncpg.Connection | None = None
    ) -> dict:
        """Return {user_id_str: name} mapping for a list of user IDs."""
        if not user_ids:
            return {}
        query = "SELECT id, name FROM users WHERE id = ANY($1)"
        if conn:
            rows = await conn.fetch(query, user_ids)
        else:
            rows = await AuthDatabase.fetch(query, user_ids)
        return {str(row["id"]): row["name"] for row in rows}
