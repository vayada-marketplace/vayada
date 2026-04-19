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
from app.database import Database, BookingEngineDatabase
from app.utils import get_hotel_id_by_slug

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
    """Public endpoint to check if pay-at-property is enabled and guest form settings."""
    hotel_id = await get_hotel_id_by_slug(slug)
    settings = await HotelPaymentSettingsRepository.get_by_hotel_id(hotel_id)
    policy = await CancellationPolicyRepository.get_by_hotel_id(hotel_id)

    hotel = await Database.fetchrow(
        "SELECT special_requests_enabled, arrival_time_enabled, guest_count_enabled "
        "FROM hotels WHERE id = $1", hotel_id,
    )

    # Read payment method flags from booking engine DB (authoritative source —
    # the booking admin settings page writes there). Fall back to PMS settings
    # if the booking engine DB is unavailable.
    be_payment_flags = None
    try:
        be_payment_flags = await BookingEngineDatabase.fetchrow(
            "SELECT pay_at_property_enabled, online_card_payment, bank_transfer "
            "FROM booking_hotels WHERE slug = $1", slug,
        )
    except Exception:
        pass

    if be_payment_flags:
        pay_at_property = be_payment_flags.get("pay_at_property_enabled", False)
        online_card = be_payment_flags.get("online_card_payment", False)
        bank_transfer = be_payment_flags.get("bank_transfer", False)
    else:
        pay_at_property = settings["pay_at_property_enabled"] if settings else False
        online_card = settings.get("online_card_payment", False) if settings else False
        bank_transfer = settings.get("bank_transfer", False) if settings else False

    # Gate onlineCardPayment on the PMS side actually being able to charge.
    # The admin toggle in booking_hotels only says "the hotel *wants* online
    # payments" — it doesn't know whether Stripe Connect onboarding finished.
    # If we surface the flag without this check, guests see a card form but
    # booking fails (or — worse — silently downgrades to pay-at-property).
    # provider='stripe' → requires completed Stripe Connect onboarding
    # provider='vayada' → charges on platform Stripe account, always usable
    if online_card:
        provider = settings.get("payment_provider", "stripe") if settings else "stripe"
        if provider == "vayada":
            pass  # platform account always works
        elif provider == "stripe":
            has_connect = bool(
                settings
                and settings.get("stripe_connect_account_id")
                and settings.get("stripe_connect_onboarded")
            )
            if not has_connect:
                online_card = False
        else:
            online_card = False

    result = {
        "payAtPropertyEnabled": pay_at_property,
        "onlineCardPayment": online_card,
        "bankTransfer": bank_transfer,
        "xenditPaymentsEnabled": settings.get("xendit_payments_enabled", False) if settings else False,
        "freeCancellationDays": policy["free_cancellation_days"] if policy else 7,
        "specialRequestsEnabled": hotel["special_requests_enabled"] if hotel else True,
        "arrivalTimeEnabled": hotel["arrival_time_enabled"] if hotel else False,
        "guestCountEnabled": hotel["guest_count_enabled"] if hotel else False,
    }

    # Fetch pay-at-hotel methods and bank details from booking engine DB
    try:
        be_hotel = await BookingEngineDatabase.fetchrow(
            "SELECT pay_at_hotel_methods, payout_account_holder, payout_iban, "
            "payout_bank_name, payout_swift FROM booking_hotels WHERE slug = $1",
            slug,
        )
        if be_hotel:
            import json
            methods = be_hotel.get("pay_at_hotel_methods")
            if isinstance(methods, str):
                methods = json.loads(methods)
            result["payAtHotelMethods"] = methods or ["cash", "card"]
            if bank_transfer:
                result["bankDetails"] = {
                    "accountHolder": be_hotel.get("payout_account_holder") or "",
                    "iban": be_hotel.get("payout_iban") or "",
                    "bankName": be_hotel.get("payout_bank_name") or "",
                    "swift": be_hotel.get("payout_swift") or "",
                }
    except Exception:
        result["payAtHotelMethods"] = ["cash", "card"]

    return result
