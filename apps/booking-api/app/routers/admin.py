"""
Admin routes for hotel management in the booking engine
"""
from fastapi import APIRouter, HTTPException, status, Depends
import logging
import re
import json

from app.dependencies import require_hotel_admin, get_current_hotel, require_current_hotel, require_superadmin
from app.repositories.user_repo import UserRepository
from app.repositories.booking_hotel_repo import BookingHotelRepository
from app.repositories.booking_addon_repo import BookingAddonRepository
from app.models.settings import PropertySettingsResponse, PropertySettingsUpdate
from app.models.design import DesignSettingsResponse, DesignSettingsUpdate
from app.models.setup import SetupStatusResponse, SetupPrefillData
from app.models.hotel import (
    AddonResponse, CreateAddonRequest, UpdateAddonRequest,
    AddonSettingsResponse, AddonSettingsUpdate,
)
from app.database import MarketplaceDatabase
from app.config import settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["admin"])


@router.get("/hotels")
async def list_hotels(user_id: str = Depends(require_hotel_admin)):
    """List all hotels owned by the current admin."""
    try:
        hotels = await BookingHotelRepository.list_by_user_id(user_id)
        return hotels
    except Exception as e:
        logger.error(f"Error listing hotels: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to list hotels"
        )


@router.get("/me")
async def get_admin_profile(user_id: str = Depends(require_hotel_admin)):
    """
    Get the current hotel admin's profile info.
    """
    try:
        user = await UserRepository.get_by_id(
            user_id, columns="id, email, name, type, status, created_at"
        )

        if not user:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="User not found"
            )

        return {
            "id": str(user['id']),
            "email": user['email'],
            "name": user['name'],
            "type": user['type'],
            "status": user['status'],
            "created_at": user['created_at'].isoformat() if user['created_at'] else None,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting admin profile: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get profile"
        )


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

# DB defaults that count as "not set"
_SETUP_DEFAULTS = {}

_ALL_SETUP_FIELDS = list(_SETUP_FIELD_MAP.values())


async def _get_marketplace_prefill(user_id: str) -> SetupPrefillData | None:
    """Try to fetch hotel profile from marketplace DB for pre-filling setup."""
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
    """Check whether the hotel admin has completed onboarding setup."""
    try:
        if not hotel:
            prefill = await _get_marketplace_prefill(user_id)
            return SetupStatusResponse(
                setup_complete=False,
                missing_fields=_ALL_SETUP_FIELDS,
                prefill_data=prefill,
            )

        # Re-fetch with setup columns specifically
        hotel_data = await BookingHotelRepository.get_by_id(
            str(hotel["id"]), columns=_SETUP_COLUMNS
        )

        if not hotel_data:
            prefill = await _get_marketplace_prefill(user_id)
            return SetupStatusResponse(
                setup_complete=False,
                missing_fields=_ALL_SETUP_FIELDS,
                prefill_data=prefill,
            )

        missing = []
        for db_col, api_name in _SETUP_FIELD_MAP.items():
            value = hotel_data.get(db_col)
            if not value or value == _SETUP_DEFAULTS.get(db_col):
                missing.append(api_name)

        prefill = None
        if missing:
            prefill = await _get_marketplace_prefill(user_id)

        return SetupStatusResponse(
            setup_complete=len(missing) == 0,
            missing_fields=missing,
            prefill_data=prefill,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error checking setup status: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to check setup status"
        )


def _hotel_to_property_settings(hotel: dict) -> PropertySettingsResponse:
    languages = hotel.get('supported_languages') or ['en']
    if isinstance(languages, str):
        languages = json.loads(languages)
    currencies = hotel.get('supported_currencies') or []
    if isinstance(currencies, str):
        currencies = json.loads(currencies)
    return PropertySettingsResponse(
        slug=hotel.get('slug') or '',
        property_name=hotel.get('name') or '',
        reservation_email=hotel.get('contact_email') or '',
        phone_number=hotel.get('contact_phone') or '',
        whatsapp_number=hotel.get('contact_whatsapp') or '',
        address=hotel.get('contact_address') or '',
        timezone=hotel.get('timezone') or 'UTC',
        default_currency=hotel.get('currency') or 'EUR',
        supported_currencies=currencies,
        supported_languages=languages,
        email_notifications=hotel.get('email_notifications', True),
        new_booking_alerts=hotel.get('new_booking_alerts', True),
        payment_alerts=hotel.get('payment_alerts', True),
        weekly_reports=hotel.get('weekly_reports', False),
    )


@router.get("/settings/property", response_model=PropertySettingsResponse)
async def get_property_settings(
    user_id: str = Depends(require_hotel_admin),
    hotel: dict | None = Depends(get_current_hotel),
):
    """Get property settings for the current hotel admin's hotel."""
    try:
        if not hotel:
            return PropertySettingsResponse(
                slug='',
                property_name='',
                reservation_email='',
                phone_number='',
                whatsapp_number='',
                address='',
                timezone='UTC',
                default_currency='EUR',
                supported_currencies=[],
                supported_languages=['en'],
                email_notifications=True,
                new_booking_alerts=True,
                payment_alerts=True,
                weekly_reports=False,
            )

        full_hotel = await BookingHotelRepository.get_by_id(str(hotel["id"]))
        return _hotel_to_property_settings(full_hotel)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting property settings: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get property settings"
        )


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
    """Update property settings (upsert — creates hotel if none exists)."""
    try:
        if hotel:
            # Build updates dict from provided fields
            updates = {}
            if data.property_name is not None:
                updates["name"] = data.property_name
            if data.reservation_email is not None:
                updates["contact_email"] = data.reservation_email
            if data.phone_number is not None:
                updates["contact_phone"] = data.phone_number
            if data.whatsapp_number is not None:
                updates["contact_whatsapp"] = data.whatsapp_number
            if data.address is not None:
                updates["contact_address"] = data.address
            if data.timezone is not None:
                updates["timezone"] = data.timezone
            if data.default_currency is not None:
                updates["currency"] = data.default_currency
            if data.supported_currencies is not None:
                updates["supported_currencies"] = data.supported_currencies
            if data.supported_languages is not None:
                updates["supported_languages"] = data.supported_languages
            if data.email_notifications is not None:
                updates["email_notifications"] = data.email_notifications
            if data.new_booking_alerts is not None:
                updates["new_booking_alerts"] = data.new_booking_alerts
            if data.payment_alerts is not None:
                updates["payment_alerts"] = data.payment_alerts
            if data.weekly_reports is not None:
                updates["weekly_reports"] = data.weekly_reports

            if updates:
                result = await BookingHotelRepository.partial_update(hotel["id"], updates)
            else:
                result = await BookingHotelRepository.get_by_id(str(hotel["id"]))
        else:
            # INSERT new hotel
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

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating property settings: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update property settings"
        )


# ── Design Settings ──────────────────────────────────────────────────

_DESIGN_COLUMNS = "name, description, hero_image, branding_primary_color, branding_accent_color, branding_font_pairing, booking_filters"

_DESIGN_DEFAULTS = DesignSettingsResponse(
    hero_image='',
    hero_heading='',
    hero_subtext='',
    primary_color='',
    accent_color='',
    font_pairing='',
    booking_filters=[],
)

# API field name → DB column name
_DESIGN_FIELD_MAP = {
    "hero_image": "hero_image",
    "hero_heading": "name",
    "hero_subtext": "description",
    "primary_color": "branding_primary_color",
    "accent_color": "branding_accent_color",
    "font_pairing": "branding_font_pairing",
    "booking_filters": "booking_filters",
}


def _hotel_to_design_settings(hotel: dict) -> DesignSettingsResponse:
    filters = hotel.get('booking_filters') or []
    if isinstance(filters, str):
        filters = json.loads(filters)
    return DesignSettingsResponse(
        hero_image=hotel.get('hero_image') or '',
        hero_heading=hotel.get('name') or '',
        hero_subtext=hotel.get('description') or '',
        primary_color=hotel.get('branding_primary_color') or '',
        accent_color=hotel.get('branding_accent_color') or '',
        font_pairing=hotel.get('branding_font_pairing') or '',
        booking_filters=filters,
    )


@router.get("/settings/design", response_model=DesignSettingsResponse)
async def get_design_settings(
    user_id: str = Depends(require_hotel_admin),
    hotel: dict | None = Depends(get_current_hotel),
):
    """Get design settings for the current hotel admin's hotel."""
    try:
        if not hotel:
            return _DESIGN_DEFAULTS

        hotel_data = await BookingHotelRepository.get_by_id(
            str(hotel["id"]), columns=_DESIGN_COLUMNS
        )
        if not hotel_data:
            return _DESIGN_DEFAULTS
        return _hotel_to_design_settings(hotel_data)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting design settings: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get design settings"
        )


@router.patch("/settings/design", response_model=DesignSettingsResponse)
async def update_design_settings(
    data: DesignSettingsUpdate,
    user_id: str = Depends(require_hotel_admin),
    hotel: dict = Depends(require_current_hotel),
):
    """Update design settings for the current hotel admin's hotel."""
    try:
        updates = {}
        for api_field, db_col in _DESIGN_FIELD_MAP.items():
            value = getattr(data, api_field)
            if value is not None:
                updates[db_col] = value

        if updates:
            await BookingHotelRepository.partial_update(hotel["id"], updates)

        hotel_data = await BookingHotelRepository.get_by_id(
            str(hotel["id"]), columns=_DESIGN_COLUMNS
        )
        return _hotel_to_design_settings(hotel_data)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating design settings: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update design settings"
        )


# ── Addon CRUD ──────────────────────────────────────────────────────


def _addon_to_response(row: dict) -> AddonResponse:
    return AddonResponse(
        id=str(row["id"]),
        name=row["name"],
        description=row["description"],
        price=float(row["price"]),
        currency=row["currency"],
        category=row["category"],
        image=row["image"],
        duration=row.get("duration"),
        per_person=row.get("per_person"),
    )


@router.get("/addons", response_model=list[AddonResponse])
async def list_addons(hotel: dict = Depends(require_current_hotel)):
    """List all addons for the current hotel."""
    try:
        rows = await BookingAddonRepository.list_by_hotel_id(str(hotel["id"]))
        return [_addon_to_response(row) for row in rows]
    except Exception as e:
        logger.error(f"Error listing addons: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to list addons"
        )


@router.post("/addons", response_model=AddonResponse, status_code=status.HTTP_201_CREATED)
async def create_addon(
    data: CreateAddonRequest,
    hotel: dict = Depends(require_current_hotel),
):
    """Create a new addon for the current hotel."""
    try:
        row = await BookingAddonRepository.create(
            hotel_id=str(hotel["id"]),
            name=data.name,
            description=data.description,
            price=data.price,
            currency=data.currency,
            category=data.category,
            image=data.image,
            duration=data.duration,
            per_person=data.per_person,
        )
        return _addon_to_response(row)
    except Exception as e:
        logger.error(f"Error creating addon: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create addon"
        )


@router.patch("/addons/{addon_id}", response_model=AddonResponse)
async def update_addon(
    addon_id: str,
    data: UpdateAddonRequest,
    hotel: dict = Depends(require_current_hotel),
):
    """Update an addon for the current hotel."""
    try:
        hotel_id = str(hotel["id"])
        existing = await BookingAddonRepository.get_by_id(addon_id, hotel_id)
        if not existing:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Addon not found"
            )

        updates = {}
        for field in ("name", "description", "price", "currency", "category", "image", "duration", "per_person"):
            value = getattr(data, field)
            if value is not None:
                updates[field] = value

        if updates:
            row = await BookingAddonRepository.update(addon_id, hotel_id, updates)
        else:
            row = existing

        return _addon_to_response(row)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating addon: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update addon"
        )


@router.delete("/addons/{addon_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_addon(
    addon_id: str,
    hotel: dict = Depends(require_current_hotel),
):
    """Delete an addon for the current hotel."""
    try:
        deleted = await BookingAddonRepository.delete(addon_id, str(hotel["id"]))
        if not deleted:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Addon not found"
            )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting addon: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to delete addon"
        )


# ── Addon Display Settings ──────────────────────────────────────────


@router.get("/settings/addons", response_model=AddonSettingsResponse)
async def get_addon_settings(
    hotel: dict = Depends(require_current_hotel),
):
    """Get addon display settings for the current hotel."""
    return AddonSettingsResponse(
        show_addons_step=hotel.get("show_addons_step", True),
        group_addons_by_category=hotel.get("group_addons_by_category", True),
    )


@router.patch("/settings/addons", response_model=AddonSettingsResponse)
async def update_addon_settings(
    data: AddonSettingsUpdate,
    hotel: dict = Depends(require_current_hotel),
):
    """Update addon display settings for the current hotel."""
    try:
        updates = {}
        if data.show_addons_step is not None:
            updates["show_addons_step"] = data.show_addons_step
        if data.group_addons_by_category is not None:
            updates["group_addons_by_category"] = data.group_addons_by_category

        if updates:
            result = await BookingHotelRepository.partial_update(str(hotel["id"]), updates)
        else:
            result = hotel

        return AddonSettingsResponse(
            show_addons_step=result.get("show_addons_step", True),
            group_addons_by_category=result.get("group_addons_by_category", True),
        )
    except Exception as e:
        logger.error(f"Error updating addon settings: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update addon settings"
        )


# ── Super Admin Endpoints ──────────────────────────────────────────


@router.get("/superadmin/check")
async def superadmin_check(user_id: str = Depends(require_superadmin)):
    """Check if the current user is a super admin."""
    return {"is_superadmin": True}


@router.get("/superadmin/hotels")
async def superadmin_list_hotels(user_id: str = Depends(require_superadmin)):
    """List all hotels with owner info. Super admin only."""
    try:
        hotels = await BookingHotelRepository.list_all(
            columns="id, name, slug, location, country, user_id"
        )

        # Enrich with owner info
        result = []
        for hotel in hotels:
            owner = await UserRepository.get_by_id(
                str(hotel["user_id"]), columns="id, name, email"
            )
            result.append({
                "id": str(hotel["id"]),
                "name": hotel["name"],
                "slug": hotel["slug"],
                "location": hotel.get("location") or "",
                "country": hotel.get("country") or "",
                "owner_name": owner["name"] if owner else "",
                "owner_email": owner["email"] if owner else "",
            })

        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error listing all hotels for superadmin: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to list hotels"
        )
