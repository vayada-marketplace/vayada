"""
System-message helpers for the collaboration chat.

System messages are emitted by the backend (not by a user) when a
collaboration changes state — accept, counter-offer, complete, etc.
"""
import json
from typing import Optional

import asyncpg

from app.repositories.chat_repo import ChatRepository


async def create_system_message(
    collaboration_id: str,
    content: str,
    metadata: Optional[dict] = None,
    *,
    conn: Optional[asyncpg.Connection] = None,
) -> None:
    """Insert a system message into a collaboration's chat thread."""
    await ChatRepository.create_system_message(
        collaboration_id,
        content,
        json.dumps(metadata) if metadata else None,
        conn=conn,
    )
