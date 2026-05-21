"""
Repository for email_change_tokens table (AuthDatabase).
"""

from datetime import UTC, datetime, timedelta

from app.database import AuthDatabase


class EmailChangeRepository:
    @staticmethod
    async def create(user_id: str, new_email: str, token: str, expires_in_hours: int = 1) -> None:
        expires_at = datetime.now(UTC) + timedelta(hours=expires_in_hours)
        # Invalidate any existing unused tokens for this user
        await AuthDatabase.execute(
            "UPDATE email_change_tokens SET used = true WHERE user_id = $1 AND used = false",
            user_id,
        )
        await AuthDatabase.execute(
            "INSERT INTO email_change_tokens (user_id, new_email, token, expires_at) VALUES ($1, $2, $3, $4)",
            user_id,
            new_email,
            token,
            expires_at,
        )

    @staticmethod
    async def get_valid_token(token: str) -> dict | None:
        query = """
            SELECT ect.id, ect.user_id, ect.new_email, ect.expires_at, ect.used, u.email, u.status
            FROM email_change_tokens ect
            JOIN users u ON u.id = ect.user_id
            WHERE ect.token = $1
        """
        row = await AuthDatabase.fetchrow(query, token)
        return dict(row) if row else None

    @staticmethod
    async def mark_used(token: str) -> bool:
        result = await AuthDatabase.execute(
            "UPDATE email_change_tokens SET used = true WHERE token = $1 AND used = false",
            token,
        )
        return result == "UPDATE 1"
