"""Onboarding setup-status endpoint + marketplace pre-fill.

Pulled out of the property-settings router so the setup wizard's
read-only check sits next to its data sources, not next to property
CRUD."""
import logging

from fastapi import APIRouter, Depends

from app.dependencies import get_current_hotel, require_hotel_admin
from app.models.setup import SetupStatusResponse
from app.repositories.booking_hotel_repo import BookingHotelRepository
from app.services.marketplace_service import get_setup_prefill

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


@router.get("/settings/setup-status", response_model=SetupStatusResponse)
async def get_setup_status(
    user_id: str = Depends(require_hotel_admin),
    hotel: dict | None = Depends(get_current_hotel),
):
    if not hotel:
        prefill = await get_setup_prefill(user_id)
        return SetupStatusResponse(setup_complete=False, missing_fields=_ALL_SETUP_FIELDS, prefill_data=prefill)

    hotel_data = await BookingHotelRepository.get_by_id(str(hotel["id"]), columns=_SETUP_COLUMNS)
    if not hotel_data:
        prefill = await get_setup_prefill(user_id)
        return SetupStatusResponse(setup_complete=False, missing_fields=_ALL_SETUP_FIELDS, prefill_data=prefill)

    missing = [api_name for db_col, api_name in _SETUP_FIELD_MAP.items() if not hotel_data.get(db_col)]
    prefill = await get_setup_prefill(user_id) if missing else None

    return SetupStatusResponse(setup_complete=len(missing) == 0, missing_fields=missing, prefill_data=prefill)
