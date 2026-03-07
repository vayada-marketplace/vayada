import re
import json
import logging

from fastapi import APIRouter, HTTPException, Depends
from app.dependencies import require_hotel_admin, get_current_hotel, require_current_hotel
from app.repositories.booking_hotel_repo import BookingHotelRepository
from app.models.settings import PropertySettingsResponse, PropertySettingsUpdate
from app.models.setup import SetupStatusResponse, SetupPrefillData
from app.database import MarketplaceDatabase
from app.config import settings

logger = logging.getLogger(__name__)

router = APIRouter()

# ── Setup status ───────────────────────────────────────────────────

_SETUP_COLUMNS = "name, contact_email, contact_phone, contact_address, timezone, currency, hero_image, branding_primary_color, branding_accent_color, branding_font_pairing"

_SETUP_FIELD_MAP = {
    "name": "property_name",
    "contact_email": "reservation_email",
    "contact_phone": "phone_number",
    "contact_address": "address",
    "timezone": "timezone",
    "currency": "currency",
    "hero_image": "hero_image",
    "branding_primary_color": "primary_color",
    "branding_accent_color": "accent_color",
    "branding_font_pairing": "font_pairing",
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


# ── Property settings ──────────────────────────────────────────────

_PROPERTY_FIELD_MAP = {
    "property_name": "name",
    "reservation_email": "contact_email",
    "phone_number": "contact_phone",
    "whatsapp_number": "contact_whatsapp",
    "address": "contact_address",
    "timezone": "timezone",
    "default_currency": "currency",
    "supported_currencies": "supported_currencies",
    "supported_languages": "supported_languages",
    "check_in_time": "check_in_time",
    "check_out_time": "check_out_time",
    "pay_at_property_enabled": "pay_at_property_enabled",
    "free_cancellation_days": "free_cancellation_days",
    "email_notifications": "email_notifications",
    "new_booking_alerts": "new_booking_alerts",
    "payment_alerts": "payment_alerts",
    "weekly_reports": "weekly_reports",
}


def _parse_json(val, default=None):
    if default is None:
        default = []
    if isinstance(val, str):
        return json.loads(val)
    return val if val is not None else default


def _hotel_to_property_settings(hotel: dict) -> PropertySettingsResponse:
    return PropertySettingsResponse(
        slug=hotel.get('slug') or '',
        property_name=hotel.get('name') or '',
        reservation_email=hotel.get('contact_email') or '',
        phone_number=hotel.get('contact_phone') or '',
        whatsapp_number=hotel.get('contact_whatsapp') or '',
        address=hotel.get('contact_address') or '',
        timezone=hotel.get('timezone') or 'UTC',
        default_currency=hotel.get('currency') or 'EUR',
        supported_currencies=_parse_json(hotel.get('supported_currencies')),
        supported_languages=_parse_json(hotel.get('supported_languages'), default=['en']),
        check_in_time=hotel.get('check_in_time') or '15:00',
        check_out_time=hotel.get('check_out_time') or '11:00',
        pay_at_property_enabled=hotel.get('pay_at_property_enabled', False),
        free_cancellation_days=hotel.get('free_cancellation_days', 7),
        email_notifications=hotel.get('email_notifications', True),
        new_booking_alerts=hotel.get('new_booking_alerts', True),
        payment_alerts=hotel.get('payment_alerts', True),
        weekly_reports=hotel.get('weekly_reports', False),
    )


_DEFAULT_PROPERTY_SETTINGS = PropertySettingsResponse(
    slug='', property_name='', reservation_email='', phone_number='',
    whatsapp_number='', address='', timezone='UTC', default_currency='EUR',
    supported_currencies=[], supported_languages=['en'],
    check_in_time='15:00', check_out_time='11:00',
    pay_at_property_enabled=False, free_cancellation_days=7,
    email_notifications=True, new_booking_alerts=True,
    payment_alerts=True, weekly_reports=False,
)


@router.get("/settings/property", response_model=PropertySettingsResponse)
async def get_property_settings(
    user_id: str = Depends(require_hotel_admin),
    hotel: dict | None = Depends(get_current_hotel),
):
    if not hotel:
        return _DEFAULT_PROPERTY_SETTINGS
    full_hotel = await BookingHotelRepository.get_by_id(str(hotel["id"]))
    return _hotel_to_property_settings(full_hotel)


def _slugify(text: str) -> str:
    text = text.lower().strip()
    text = re.sub(r'[^\w\s-]', '', text)
    text = re.sub(r'[\s_]+', '-', text)
    text = re.sub(r'-+', '-', text)
    return text or 'my-hotel'


@router.patch("/settings/property", response_model=PropertySettingsResponse)
async def update_property_settings(
    data: PropertySettingsUpdate,
    user_id: str = Depends(require_hotel_admin),
    hotel: dict | None = Depends(get_current_hotel),
):
    if hotel:
        updates = {}
        for api_field, db_col in _PROPERTY_FIELD_MAP.items():
            value = getattr(data, api_field)
            if value is not None:
                updates[db_col] = value

        if updates:
            result = await BookingHotelRepository.partial_update(hotel["id"], updates)
        else:
            result = await BookingHotelRepository.get_by_id(str(hotel["id"]))
    else:
        name = data.property_name or ''
        slug = _slugify(name) if name else f"hotel-{user_id[:8]}"

        result = await BookingHotelRepository.create(
            name=name,
            slug=slug,
            contact_email=data.reservation_email or '',
            contact_phone=data.phone_number or '',
            timezone=data.timezone or 'UTC',
            currency=data.default_currency or 'EUR',
            supported_languages=data.supported_languages or ['en'],
            user_id=user_id,
            supported_currencies=data.supported_currencies or [],
            contact_whatsapp=data.whatsapp_number or '',
            contact_address=data.address or '',
            email_notifications=data.email_notifications if data.email_notifications is not None else True,
            new_booking_alerts=data.new_booking_alerts if data.new_booking_alerts is not None else True,
            payment_alerts=data.payment_alerts if data.payment_alerts is not None else True,
            weekly_reports=data.weekly_reports if data.weekly_reports is not None else False,
        )

    return _hotel_to_property_settings(result)
