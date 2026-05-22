"""
Repository for TOTP secrets and recovery codes (auth-db).
"""

from app.database import AuthDatabase


class TotpRepository:
    @staticmethod
    async def get_secret(user_id: str) -> dict | None:
        row = await AuthDatabase.fetchrow(
            "SELECT id, secret_encrypted, enrolled FROM totp_secrets WHERE user_id = $1",
            user_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def upsert_secret(user_id: str, secret_encrypted: str) -> None:
        await AuthDatabase.execute(
            """
            INSERT INTO totp_secrets (user_id, secret_encrypted, enrolled)
            VALUES ($1, $2, false)
            ON CONFLICT (user_id) DO UPDATE
            SET secret_encrypted = EXCLUDED.secret_encrypted,
                enrolled = false,
                created_at = now()
            """,
            user_id,
            secret_encrypted,
        )

    @staticmethod
    async def mark_enrolled(user_id: str) -> None:
        await AuthDatabase.execute(
            "UPDATE totp_secrets SET enrolled = true WHERE user_id = $1",
            user_id,
        )

    @staticmethod
    async def is_enrolled(user_id: str) -> bool:
        row = await AuthDatabase.fetchrow(
            "SELECT id FROM totp_secrets WHERE user_id = $1 AND enrolled = true",
            user_id,
        )
        return row is not None

    @staticmethod
    async def delete_recovery_codes(user_id: str) -> None:
        await AuthDatabase.execute(
            "DELETE FROM totp_recovery_codes WHERE user_id = $1",
            user_id,
        )

    @staticmethod
    async def insert_recovery_codes(user_id: str, code_hashes: list[str]) -> None:
        for code_hash in code_hashes:
            await AuthDatabase.execute(
                "INSERT INTO totp_recovery_codes (user_id, code_hash) VALUES ($1, $2)",
                user_id,
                code_hash,
            )

    @staticmethod
    async def get_unused_recovery_codes(user_id: str) -> list[dict]:
        rows = await AuthDatabase.fetch(
            "SELECT id, code_hash FROM totp_recovery_codes WHERE user_id = $1 AND used = false",
            user_id,
        )
        return [dict(r) for r in rows]

    @staticmethod
    async def count_unused_recovery_codes(user_id: str) -> int:
        result = await AuthDatabase.fetchval(
            "SELECT COUNT(*) FROM totp_recovery_codes WHERE user_id = $1 AND used = false",
            user_id,
        )
        return int(result or 0)

    @staticmethod
    async def mark_recovery_code_used(code_id: str) -> None:
        await AuthDatabase.execute(
            "UPDATE totp_recovery_codes SET used = true WHERE id = $1",
            code_id,
        )
