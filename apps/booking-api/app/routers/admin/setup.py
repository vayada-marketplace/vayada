"""Onboarding setup-status endpoint + marketplace pre-fill.

Pulled out of the property-settings router so the setup wizard's
read-only check sits next to its data sources, not next to property
CRUD."""
import logging

from fastapi import APIRouter, Depends

from app.config import settings
from app.database import MarketplaceDatabase
from app.dependencies import get_current_hotel, require_hotel_admin
from app.models.setup import SetupPrefillData, SetupStatusResponse
from app.repositories.booking_hotel_repo import BookingHotelRepository

logger = logging.getLogger(__name__)

router = APIRouter()

_SETUP_COLUMNS = "name, contact_email, contact_phone, contact_address, timezone, currency"

_SETUP_FIELD_MAP = {
    "name": "property_name",
    "contact_email": "reservation_email",
    "contact_phone": "phone_number",
    "contact_address": "address",
    "timezone": "timezone",
    "currency": "currency",
}

_ALL_SETUP_FIELDS = list(_SETUP_FIELD_MAP.values())


async def _get_marketplace_prefill(user_id: str) -> SetupPrefillData | None:
    if not settings.MARKETPLACE_DATABASE_URL:
        return None
    try:
        row = await MarketplaceDatabase.fetchrow(
            "SELECT name, email, phone, location, picture "
            "FROM hotel_profiles WHERE user_id = $1",
            user_id,
        )
        if not row:
            return None
        return SetupPrefillData(
            property_name=row['name'] or None,
            reservation_email=row['email'] or None,
            phone_number=row['phone'] or None,
            address=row['location'] or None,
            hero_image=row['picture'] or None,
        )
    except Exception as e:
        logger.warning(f"Could not fetch marketplace prefill data: {e}")
        return None


@router.get("/settings/setup-status", response_model=SetupStatusResponse)
async def get_setup_status(
    user_id: str = Depends(require_hotel_admin),
    hotel: dict | None = Depends(get_current_hotel),
):
    if not hotel:
        prefill = await _get_marketplace_prefill(user_id)
        return SetupStatusResponse(setup_complete=False, missing_fields=_ALL_SETUP_FIELDS, prefill_data=prefill)

    hotel_data = await BookingHotelRepository.get_by_id(str(hotel["id"]), columns=_SETUP_COLUMNS)
    if not hotel_data:
        prefill = await _get_marketplace_prefill(user_id)
        return SetupStatusResponse(setup_complete=False, missing_fields=_ALL_SETUP_FIELDS, prefill_data=prefill)

    missing = [api_name for db_col, api_name in _SETUP_FIELD_MAP.items() if not hotel_data.get(db_col)]
    prefill = await _get_marketplace_prefill(user_id) if missing else None

    return SetupStatusResponse(setup_complete=len(missing) == 0, missing_fields=missing, prefill_data=prefill)
