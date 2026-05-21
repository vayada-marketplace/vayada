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

# Meal-plan rate variants only push to OTAs. Direct keeps a single room-only
# rate; meal options on direct stays remain a separate concern.
_CHANNELS_WITH_MEAL_PLANS = {"booking_com"}

# Display labels for meal_plan_code values used in rate-plan titles.
MEAL_PLAN_LABELS = {
    0: "",
    1: "Breakfast",
    3: "Half Board",
    4: "Full Board",
    9: "All Inclusive",
}

CHANNEX_SYNC_REASON = "channex_sync"


async def _count_local_blocks(room_type_id: str, start_date: date, end_date: date) -> int:
    """Count blocked rooms excluding channex_sync blocks (to avoid circular push)."""
    count = await Database.fetchval(
        """
        SELECT COALESCE(SUM(blocked_count), 0) FROM room_blocks
        WHERE room_type_id = $1
          AND start_date < $3
          AND end_date > $2
          AND reason != $4
        """,
        room_type_id,
        start_date,
        end_date,
        CHANNEX_SYNC_REASON,
    )
    return count or 0
