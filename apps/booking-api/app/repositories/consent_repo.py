"""
Repository for consent_history table (AuthDatabase).
"""
from typing import Optional

from app.database import AuthDatabase


class ConsentRepository:

    @staticmethod
    async def record(
        user_id: str,
        consent_type: str,
        consent_given: bool,
        version: Optional[str] = None,
    ) -> None:
        if version is not None:
            await AuthDatabase.execute(
                "INSERT INTO consent_history (user_id, consent_type, consent_given, version) VALUES ($1, $2, $3, $4)",
                user_id, consent_type, consent_given, version,
            )
        else:
            await AuthDatabase.execute(
                "INSERT INTO consent_history (user_id, consent_type, consent_given) VALUES ($1, $2, $3)",
                user_id, consent_type, consent_given,
            )
