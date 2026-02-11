"""
Admin routes for hotel management in the booking engine
"""
from fastapi import APIRouter, HTTPException, status, Depends
import logging
import re
import json

from app.dependencies import require_hotel_admin
from app.repositories.user_repo import UserRepository
from app.repositories.booking_hotel_repo import BookingHotelRepository
from app.models.settings import PropertySettingsResponse, PropertySettingsUpdate

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["admin"])


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


def _hotel_to_property_settings(hotel: dict) -> PropertySettingsResponse:
    languages = hotel.get('supported_languages') or ['en']
    if isinstance(languages, str):
        languages = json.loads(languages)
    return PropertySettingsResponse(
        property_name=hotel.get('name') or '',
        reservation_email=hotel.get('contact_email') or '',
        phone_number=hotel.get('contact_phone') or '',
        whatsapp_number=hotel.get('contact_whatsapp') or '',
        address=hotel.get('contact_address') or '',
        timezone=hotel.get('timezone') or 'UTC',
        default_currency=hotel.get('currency') or 'EUR',
        supported_languages=languages,
        email_notifications=hotel.get('email_notifications', True),
        new_booking_alerts=hotel.get('new_booking_alerts', True),
        payment_alerts=hotel.get('payment_alerts', True),
        weekly_reports=hotel.get('weekly_reports', False),
    )


@router.get("/settings/property", response_model=PropertySettingsResponse)
async def get_property_settings(user_id: str = Depends(require_hotel_admin)):
    """Get property settings for the current hotel admin's hotel."""
    try:
        hotel = await BookingHotelRepository.get_by_user_id(user_id)

        if not hotel:
            return PropertySettingsResponse(
                property_name='',
                reservation_email='',
                phone_number='',
                whatsapp_number='',
                address='',
                timezone='UTC',
                default_currency='EUR',
                supported_languages=['en'],
                email_notifications=True,
                new_booking_alerts=True,
                payment_alerts=True,
                weekly_reports=False,
            )

        return _hotel_to_property_settings(hotel)

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
):
    """Update property settings (upsert — creates hotel if none exists)."""
    try:
        existing = await BookingHotelRepository.get_by_user_id(user_id, columns="id")

        if existing:
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
                hotel = await BookingHotelRepository.partial_update(user_id, updates)
            else:
                hotel = await BookingHotelRepository.get_by_user_id(user_id)
        else:
            # INSERT new hotel
            name = data.property_name or ''
            slug = _slugify(name) if name else f"hotel-{user_id[:8]}"

            hotel = await BookingHotelRepository.create(
                name=name,
                slug=slug,
                contact_email=data.reservation_email or '',
                contact_phone=data.phone_number or '',
                timezone=data.timezone or 'UTC',
                currency=data.default_currency or 'EUR',
                supported_languages=data.supported_languages or ['en'],
                user_id=user_id,
                contact_whatsapp=data.whatsapp_number or '',
                contact_address=data.address or '',
                email_notifications=data.email_notifications if data.email_notifications is not None else True,
                new_booking_alerts=data.new_booking_alerts if data.new_booking_alerts is not None else True,
                payment_alerts=data.payment_alerts if data.payment_alerts is not None else True,
                weekly_reports=data.weekly_reports if data.weekly_reports is not None else False,
            )

        return _hotel_to_property_settings(hotel)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating property settings: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update property settings"
        )
