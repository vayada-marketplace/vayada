"""
Repository for consent_history table (AuthDatabase).
"""
from typing import Optional

import asyncpg

from app.database import AuthDatabase


class ConsentRepository:

    @staticmethod
    async def record(
        user_id: str,
        consent_type: str,
        consent_given: bool,
        version: Optional[str] = None,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> None:
        if version is not None:
            query = """
                INSERT INTO consent_history (user_id, consent_type, consent_given, version)
                VALUES ($1, $2, $3, $4)
            """
            args = (user_id, consent_type, consent_given, version)
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
