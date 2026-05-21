"""
Repository for newsletter_preferences table (Business Database).
"""
from typing import Optional, List

from app.database import Database


class NewsletterRepository:

    @staticmethod
    async def get_by_user_id(user_id: str) -> Optional[dict]:
        row = await Database.fetchrow(
            "SELECT * FROM newsletter_preferences WHERE user_id = $1",
            user_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def upsert(
        user_id: str,
        *,
        enabled: Optional[bool] = None,
        country_filter: Optional[List[str]] = None,
        clear_country_filter: bool = False,
    ) -> dict:
        """Create or update newsletter preferences. Returns the row."""
        existing = await NewsletterRepository.get_by_user_id(user_id)

        if existing is None:
            # Insert with defaults, then apply overrides
            e = enabled if enabled is not None else True
            cf = None if clear_country_filter else country_filter
            row = await Database.fetchrow(
                """
                INSERT INTO newsletter_preferences (user_id, enabled, country_filter)
                VALUES ($1, $2, $3)
                RETURNING *
                """,
                user_id, e, cf,
            )
        else:
            sets = ["updated_at = NOW()"]
            params: list = []
            idx = 1

            if enabled is not None:
                sets.append(f"enabled = ${idx}")
                params.append(enabled)
                idx += 1

            if clear_country_filter:
                sets.append("country_filter = NULL")
            elif country_filter is not None:
                sets.append(f"country_filter = ${idx}")
                params.append(country_filter)
                idx += 1

            params.append(user_id)
            query = f"UPDATE newsletter_preferences SET {', '.join(sets)} WHERE user_id = ${idx} RETURNING *"
            row = await Database.fetchrow(query, *params)

        return dict(row)

    @staticmethod
    async def get_all_enabled() -> list:
        """Return all users with newsletter enabled."""
        rows = await Database.fetch(
            "SELECT * FROM newsletter_preferences WHERE enabled = TRUE"
        )
        return [dict(r) for r in rows]
