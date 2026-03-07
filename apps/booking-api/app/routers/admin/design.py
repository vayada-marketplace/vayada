from fastapi import APIRouter, Depends
from app.dependencies import require_hotel_admin, get_current_hotel, require_current_hotel
from app.repositories.booking_hotel_repo import BookingHotelRepository
from app.models.design import DesignSettingsResponse, DesignSettingsUpdate
from app.models.utils import parse_json

router = APIRouter()

_DESIGN_COLUMNS = "name, description, hero_image, branding_primary_color, branding_accent_color, branding_font_pairing, booking_filters, custom_filters"

_DESIGN_FIELD_MAP = {
    "hero_image": "hero_image",
    "hero_heading": "name",
    "hero_subtext": "description",
    "primary_color": "branding_primary_color",
    "accent_color": "branding_accent_color",
    "font_pairing": "branding_font_pairing",
    "booking_filters": "booking_filters",
    "custom_filters": "custom_filters",
}

_DESIGN_DEFAULTS = DesignSettingsResponse(
    hero_image='', hero_heading='', hero_subtext='',
    primary_color='', accent_color='', font_pairing='',
    booking_filters=[], custom_filters={},
)


def _hotel_to_design_settings(hotel: dict) -> DesignSettingsResponse:
    return DesignSettingsResponse(
        hero_image=hotel.get('hero_image') or '',
        hero_heading=hotel.get('name') or '',
        hero_subtext=hotel.get('description') or '',
        primary_color=hotel.get('branding_primary_color') or '',
        accent_color=hotel.get('branding_accent_color') or '',
        font_pairing=hotel.get('branding_font_pairing') or '',
        booking_filters=parse_json(hotel.get('booking_filters')),
        custom_filters=parse_json(hotel.get('custom_filters'), default={}),
    )


@router.get("/settings/design", response_model=DesignSettingsResponse)
async def get_design_settings(
    user_id: str = Depends(require_hotel_admin),
    hotel: dict | None = Depends(get_current_hotel),
):
    if not hotel:
        return _DESIGN_DEFAULTS

    hotel_data = await BookingHotelRepository.get_by_id(str(hotel["id"]), columns=_DESIGN_COLUMNS)
    if not hotel_data:
        return _DESIGN_DEFAULTS
    return _hotel_to_design_settings(hotel_data)


@router.patch("/settings/design", response_model=DesignSettingsResponse)
async def update_design_settings(
    data: DesignSettingsUpdate,
    user_id: str = Depends(require_hotel_admin),
    hotel: dict = Depends(require_current_hotel),
):
    updates = {}
    for api_field, db_col in _DESIGN_FIELD_MAP.items():
        value = getattr(data, api_field)
        if value is not None:
            updates[db_col] = value

    if updates:
        await BookingHotelRepository.partial_update(hotel["id"], updates)

    hotel_data = await BookingHotelRepository.get_by_id(str(hotel["id"]), columns=_DESIGN_COLUMNS)
    return _hotel_to_design_settings(hotel_data)
