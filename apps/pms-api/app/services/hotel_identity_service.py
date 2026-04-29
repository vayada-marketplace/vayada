"""Reads from the booking-engine DB, which owns hotel-identity fields
(currency, slug, payment-method flags, terms text). PMS reads from here
rather than its own ``hotels`` table for those fields — see
memory/project_hotel_data_ownership.md.

Routers should funnel cross-DB lookups through this module so the boundary
stays auditable and fallback behavior is consistent.
"""
import logging

from app.config import settings as app_settings
from app.database import BookingEngineDatabase

logger = logging.getLogger(__name__)

DEFAULT_CURRENCY = "EUR"


async def get_currency(hotel_id: str) -> str:
    """Return the hotel's authoritative currency, or ``DEFAULT_CURRENCY``
    if booking_db is unconfigured / unreachable / the row is missing.

    The fallback is a hedge against an outage, not the expected path —
    hotel ids are unified across PMS and booking_db, so the row should
    exist whenever the connection works.
    """
    if not app_settings.BOOKING_ENGINE_DATABASE_URL:
        return DEFAULT_CURRENCY
    try:
        currency = await BookingEngineDatabase.fetchval(
            "SELECT currency FROM booking_hotels WHERE id = $1",
            hotel_id,
        )
        return currency or DEFAULT_CURRENCY
    except Exception as e:
        logger.warning(
            "booking_db currency lookup failed for hotel %s: %s; using %s",
            hotel_id, e, DEFAULT_CURRENCY,
        )
        return DEFAULT_CURRENCY
