"""
Repositories for login audit log and per-email rate limiting (auth-db).
"""

from app.database import AuthDatabase

_LOCKOUT_MINUTES = 15
_MAX_FAILURES = 5


class LoginAuditRepository:
    @staticmethod
    async def log(
        *,
        email: str,
        success: bool,
        user_id: str | None = None,
        auth_method: str | None = None,
        failure_reason: str | None = None,
        ip_address: str | None = None,
        user_agent: str | None = None,
    ) -> None:
        await AuthDatabase.execute(
            """
            INSERT INTO login_audit_log
                (user_id, email, success, auth_method, failure_reason, ip_address, user_agent)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            """,
            user_id,
            email,
            success,
            auth_method,
            failure_reason,
            ip_address,
            user_agent,
        )

    @staticmethod
    async def get_recent(user_id: str, limit: int = 20) -> list[dict]:
        rows = await AuthDatabase.fetch(
            """
            SELECT id, email, success, auth_method, failure_reason,
                   ip_address, user_agent, created_at
            FROM login_audit_log
            WHERE user_id = $1
              AND failure_reason IS DISTINCT FROM 'totp_required'
            ORDER BY created_at DESC
            LIMIT $2
            """,
            user_id,
            limit,
        )
        return [dict(r) for r in rows]


class RateLimitRepository:
    @staticmethod
    async def check_locked(email: str) -> dict | None:
        row = await AuthDatabase.fetchrow(
            "SELECT locked_until FROM login_rate_limit WHERE email = $1 AND locked_until > now()",
            email,
        )
        return dict(row) if row else None

    @staticmethod
    async def record_failure(email: str) -> None:
        await AuthDatabase.execute(
            f"""
            INSERT INTO login_rate_limit (email, failed_attempts, last_attempt_at)
            VALUES ($1, 1, now())
            ON CONFLICT (email) DO UPDATE
            SET failed_attempts = login_rate_limit.failed_attempts + 1,
                locked_until = CASE
                    WHEN login_rate_limit.failed_attempts + 1 >= {_MAX_FAILURES}
                    THEN now() + interval '{_LOCKOUT_MINUTES} minutes'
                    ELSE login_rate_limit.locked_until
                END,
                last_attempt_at = now()
            """,
            email,
        )

    @staticmethod
    async def clear(email: str) -> None:
        await AuthDatabase.execute(
            "DELETE FROM login_rate_limit WHERE email = $1",
            email,
        )
