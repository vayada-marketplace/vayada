import logging

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, EmailStr

from app.models.booking import BookingCreate, BookingResponse, BookingLookup
from app.services.booking_service import (
    create_booking_request,
    confirm_payment_authorized,
    guest_withdraw_booking,
    get_cancellation_preview,
    handle_guest_cancellation,
    lookup_booking,
    get_booking_status,
)
from app.repositories.hotel_payment_settings_repo import HotelPaymentSettingsRepository
from app.repositories.cancellation_policy_repo import CancellationPolicyRepository
from app.database import Database

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/hotels", tags=["bookings"])


class GuestActionRequest(BaseModel):
    guest_email: EmailStr


@router.post("/{slug}/bookings")
async def post_booking(slug: str, data: BookingCreate):
    """Create a booking request with payment (card or pay-at-property)."""
    try:
        result = await create_booking_request(slug, data)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("Error creating booking for %s: %s", slug, e)
        raise HTTPException(status_code=500, detail="Internal server error")
    return result


@router.post("/{slug}/bookings/{booking_id}/confirm-authorization")
async def post_confirm_authorization(slug: str, booking_id: str):
    """Called by frontend after Stripe confirms card authorization."""
    try:
        result = await confirm_payment_authorized(booking_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("Error confirming authorization for %s: %s", booking_id, e)
        raise HTTPException(status_code=500, detail="Internal server error")
    return result


@router.post("/{slug}/bookings/{booking_id}/withdraw")
async def post_withdraw(slug: str, booking_id: str, data: GuestActionRequest):
    """Guest withdraws a pending booking request."""
    try:
        await guest_withdraw_booking(booking_id, data.guest_email)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("Error withdrawing booking %s: %s", booking_id, e)
        raise HTTPException(status_code=500, detail="Internal server error")
    return {"status": "withdrawn"}


@router.post("/{slug}/bookings/{booking_id}/cancel-preview")
async def post_cancel_preview(slug: str, booking_id: str, data: GuestActionRequest):
    """Preview cancellation refund details without actually cancelling."""
    try:
        result = await get_cancellation_preview(booking_id, data.guest_email)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("Error previewing cancellation for %s: %s", booking_id, e)
        raise HTTPException(status_code=500, detail="Internal server error")
    return result


@router.post("/{slug}/bookings/{booking_id}/cancel")
async def post_cancel(slug: str, booking_id: str, data: GuestActionRequest):
    """Guest cancels a confirmed booking (applies cancellation policy)."""
    try:
        await handle_guest_cancellation(booking_id, data.guest_email)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("Error cancelling booking %s: %s", booking_id, e)
        raise HTTPException(status_code=500, detail="Internal server error")
    return {"status": "cancelled"}


@router.post("/{slug}/bookings/lookup", response_model=BookingResponse)
async def post_booking_lookup(slug: str, data: BookingLookup):
    try:
        booking = await lookup_booking(
            slug, data.booking_reference, data.guest_email
        )
    except Exception as e:
        logger.error("Error looking up booking: %s", e)
        raise HTTPException(status_code=500, detail="Internal server error")

    if not booking:
        raise HTTPException(status_code=404, detail="Booking not found")
    return booking


@router.get("/{slug}/bookings/status")
async def get_status(
    slug: str,
    reference: str = Query(...),
    email: str = Query(...),
):
    """Polling endpoint for frontend to check booking status."""
    result = await get_booking_status(slug, reference, email)
    if not result:
        raise HTTPException(status_code=404, detail="Booking not found")
    return result


@router.get("/{slug}/payment-settings")
async def get_payment_settings(slug: str):
    """Public endpoint to check if pay-at-property is enabled."""
    hotel = await Database.fetchrow(
        "SELECT id FROM hotels WHERE slug = $1", slug
    )
    if not hotel:
        raise HTTPException(status_code=404, detail="Hotel not found")

    hotel_id = str(hotel["id"])
    settings = await HotelPaymentSettingsRepository.get_by_hotel_id(hotel_id)
    policy = await CancellationPolicyRepository.get_by_hotel_id(hotel_id)

    return {
        "payAtPropertyEnabled": settings["pay_at_property_enabled"] if settings else False,
        "freeCancellationDays": policy["free_cancellation_days"] if policy else 7,
    }
