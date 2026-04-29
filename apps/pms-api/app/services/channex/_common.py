"""Shared constants + helpers for the channex package."""
from datetime import date

from app.database import Database


SYNC_HORIZON_DAYS = 365

# Channel labels used in Channex rate plan titles and plan combinations.
# Airbnb only accepts one rate plan per listing, so we skip non_refundable there.
_CHANNEL_LABELS = {
    "direct": "",
    "booking_com": "BDC",
    "airbnb": "Airbnb",
}
_CHANNELS_WITH_NON_REFUNDABLE = {"direct", "booking_com"}

CHANNEX_SYNC_REASON = "channex_sync"


async def _count_local_blocks(
    room_type_id: str, start_date: date, end_date: date
) -> int:
    """Count blocked rooms excluding channex_sync blocks (to avoid circular push)."""
    count = await Database.fetchval(
        """
        SELECT COALESCE(SUM(blocked_count), 0) FROM room_blocks
        WHERE room_type_id = $1
          AND start_date < $3
          AND end_date > $2
          AND reason != $4
        """,
        room_type_id, start_date, end_date, CHANNEX_SYNC_REASON,
    )
    return count or 0
