"""
Event repository — records and queries booking funnel events.
"""
import json
import logging
from datetime import date
from app.database import Database

logger = logging.getLogger(__name__)

VALID_EVENT_TYPES = {
    "page_visit",
    "viewed_room",
    "started_booking",
    "completed_booking",
}


class EventRepository:

    @staticmethod
    async def record(hotel_slug: str, event_type: str, session_id: str | None = None, metadata: dict | None = None):
        await Database.execute(
            """
            INSERT INTO booking_events (hotel_slug, event_type, session_id, metadata)
            VALUES ($1, $2, $3, $4)
            """,
            hotel_slug, event_type, session_id, json.dumps(metadata or {}),
        )

    @staticmethod
    async def count_by_type(hotel_slug: str, event_type: str, start: date, end: date) -> int:
        return await Database.fetchval(
            """
            SELECT COUNT(*) FROM booking_events
            WHERE hotel_slug = $1 AND event_type = $2
              AND created_at::date >= $3 AND created_at::date <= $4
            """,
            hotel_slug, event_type, start, end,
        ) or 0

    @staticmethod
    async def count_all_types(hotel_slug: str, start: date, end: date) -> dict[str, int]:
        rows = await Database.fetch(
            """
            SELECT event_type, COUNT(*) as cnt
            FROM booking_events
            WHERE hotel_slug = $1
              AND created_at::date >= $2 AND created_at::date <= $3
            GROUP BY event_type
            """,
            hotel_slug, start, end,
        )
        return {row["event_type"]: row["cnt"] for row in rows}
