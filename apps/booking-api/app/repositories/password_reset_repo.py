"""
Repository for password_reset_tokens table (AuthDatabase).
"""
from typing import Optional
from datetime import datetime, timedelta, timezone

from app.database import AuthDatabase


class PasswordResetRepository:

    @staticmethod
    async def create(user_id: str, token: str, expires_in_hours: int = 1) -> None:
        expires_at = datetime.now(timezone.utc) + timedelta(hours=expires_in_hours)
        await AuthDatabase.execute(
            "INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)",
            user_id, token, expires_at,
        )

    @staticmethod
    async def get_valid_token(token: str) -> Optional[dict]:
        query = """
            SELECT prt.id, prt.user_id, prt.expires_at, prt.used, u.email, u.status
            FROM password_reset_tokens prt
            JOIN users u ON u.id = prt.user_id
            WHERE prt.token = $1
        """
        row = await AuthDatabase.fetchrow(query, token)
        return dict(row) if row else None

    @staticmethod
    async def mark_used(token: str) -> bool:
        result = await AuthDatabase.execute(
            "UPDATE password_reset_tokens SET used = true WHERE token = $1 AND used = false",
            token,
        )
        return result == "UPDATE 1"

    @staticmethod
    async def invalidate_all_for_user(user_id: str) -> None:
        await AuthDatabase.execute(
            "UPDATE password_reset_tokens SET used = true WHERE user_id = $1 AND used = false",
            user_id,
        )
