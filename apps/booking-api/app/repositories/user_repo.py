"""
Repository for users table (AuthDatabase).
"""
from typing import Optional

from app.database import AuthDatabase


class UserRepository:

    @staticmethod
    async def get_by_email(email: str, *, columns: str = "*") -> Optional[dict]:
        row = await AuthDatabase.fetchrow(f"SELECT {columns} FROM users WHERE email = $1", email)
        return dict(row) if row else None

    @staticmethod
    async def get_by_id(user_id: str, *, columns: str = "*") -> Optional[dict]:
        row = await AuthDatabase.fetchrow(f"SELECT {columns} FROM users WHERE id = $1", user_id)
        return dict(row) if row else None

    @staticmethod
    async def exists_by_email(email: str) -> bool:
        row = await AuthDatabase.fetchrow("SELECT id FROM users WHERE email = $1", email)
        return row is not None

    @staticmethod
    async def create(
        email: str,
        password_hash: str,
        name: str,
        terms_version: str,
        privacy_version: str,
        marketing_consent: bool,
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
        row = await AuthDatabase.fetchrow(query, email, password_hash, name, terms_version, privacy_version, marketing_consent)
        return dict(row)

    @staticmethod
    async def update_password(user_id: str, password_hash: str) -> None:
        await AuthDatabase.execute(
            "UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2",
            password_hash, user_id,
        )

    @staticmethod
    async def update_email(user_id: str, new_email: str) -> Optional[dict]:
        row = await AuthDatabase.fetchrow(
            "UPDATE users SET email = $1, updated_at = now() WHERE id = $2 RETURNING id, email, name, type, status",
            new_email, user_id,
        )
        return dict(row) if row else None
