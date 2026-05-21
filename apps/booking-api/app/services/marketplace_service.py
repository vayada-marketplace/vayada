"""Marketplace-DB reads used during onboarding pre-fill.

Routers funnel cross-DB reads through here so the boundary is auditable
and failure semantics (return None on missing/unreachable) are consistent
— mirrors the booking_db helpers in pms-backend's hotel_identity_service.
"""
import logging
from typing import Optional

from app.config import settings as app_settings
from app.database import MarketplaceDatabase
from app.models.setup import SetupPrefillData

logger = logging.getLogger(__name__)


async def get_setup_prefill(user_id: str) -> Optional[SetupPrefillData]:
    """Pre-fill data from the user's marketplace ``hotel_profiles`` row,
    or ``None`` if marketplace_db is unconfigured / unreachable / the row
    is missing. Failures are logged, never propagated."""
    if not app_settings.MARKETPLACE_DATABASE_URL:
        return None
    try:
        row = await MarketplaceDatabase.fetchrow(
            "SELECT name, email, phone, location, picture "
            "FROM hotel_profiles WHERE user_id = $1",
            user_id,
        )
    except Exception as e:
        logger.warning("marketplace_db prefill lookup failed for user %s: %s", user_id, e)
        return None
    if not row:
        return None
    return SetupPrefillData(
        property_name=row['name'] or None,
        reservation_email=row['email'] or None,
        phone_number=row['phone'] or None,
        address=row['location'] or None,
        hero_image=row['picture'] or None,
    )
