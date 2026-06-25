import logging

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, EmailStr

from app.database import Database
from app.models.booking import (
    BookingCreate,
    BookingLookup,
    BookingResponse,
    ChangeRequestPayload,
)
from app.repositories.cancellation_policy_repo import CancellationPolicyRepository
from app.repositories.hotel_payment_settings_repo import HotelPaymentSettingsRepository
from app.services import hotel_identity_service
from app.services.booking_change_service import (
    get_change_request_for_guest,
)
from app.services.booking_change_service import (
    preview_change as preview_booking_change,
)
from app.services.booking_change_service import (
    submit_change as submit_booking_change,
)
from app.services.booking_service import (
    confirm_payment_authorized,
    create_booking_request,
    get_booking_status,
    get_cancellation_preview,
    guest_withdraw_booking,
    handle_guest_cancellation,
    lookup_booking,
    quote_booking_request,
)
from app.utils import get_hotel_id_by_slug

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/hotels", tags=["bookings"])


class GuestActionRequest(BaseModel):
    guest_email: EmailStr


def _bank_details_complete(details: dict | None) -> bool:
    if not details:
        return False
    account_type = details.get("payout_account_type") or "iban"
    account_identifier = (
        details.get("payout_account_number")
        if account_type == "account_number"
        else details.get("payout_iban")
    )
    required = [
        details.get("payout_bank_name"),
        details.get("payout_account_holder"),
        account_identifier,
        details.get("payout_swift"),
    ]
    return all(bool(str(value or "").strip()) for value in required)


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


@router.post("/{slug}/bookings/quote")
async def post_booking_quote(slug: str, data: BookingCreate):
    """Return the authoritative final checkout quote before submission."""
    try:
        quote = await quote_booking_request(slug, data)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        logger.error("Error quoting booking for %s: %s", slug, e)
        raise HTTPException(status_code=500, detail="Internal server error") from e
    return quote


@router.post("/{slug}/bookings/{handle}/confirm-authorization")
async def post_confirm_authorization(slug: str, handle: str):
    """Called by frontend after Stripe confirms card authorization.

    ``handle`` is a draft id for the VAY-388 card flow (no booking row
    exists yet at request time) or a legacy booking id; the service
    layer dispatches based on which one matches.
    """
    try:
        result = await confirm_payment_authorized(handle)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("Error confirming authorization for %s: %s", handle, e)
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
        booking = await lookup_booking(slug, data.booking_reference, data.guest_email)
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


@router.post("/{slug}/bookings/{booking_id}/change-request/preview")
async def post_change_request_preview(
    slug: str,
    booking_id: str,
    data: ChangeRequestPayload,
):
    """Preview the price diff for a guest's hypothetical change request."""
    try:
        result = await preview_booking_change(
            slug,
            booking_id,
            data.guest_email,
            check_in=data.check_in,
            check_out=data.check_out,
            addon_ids=data.addon_ids,
            addon_quantities=data.addon_quantities,
            addon_dates=data.addon_dates,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("Error previewing change request for %s: %s", booking_id, e)
        raise HTTPException(status_code=500, detail="Internal server error")
    return result


@router.post("/{slug}/bookings/{booking_id}/change-request")
async def post_change_request(
    slug: str,
    booking_id: str,
    data: ChangeRequestPayload,
):
    """Submit a change request for a confirmed booking."""
    try:
        cr = await submit_booking_change(
            slug,
            booking_id,
            data.guest_email,
            check_in=data.check_in,
            check_out=data.check_out,
            addon_ids=data.addon_ids,
            addon_quantities=data.addon_quantities,
            addon_dates=data.addon_dates,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("Error submitting change request for %s: %s", booking_id, e)
        raise HTTPException(status_code=500, detail="Internal server error")
    return _change_request_to_dict(cr)


@router.get("/{slug}/bookings/{booking_id}/change-request")
async def get_change_request(
    slug: str,
    booking_id: str,
    email: str = Query(...),
):
    """Latest change request for the booking, or null when none exists."""
    try:
        cr = await get_change_request_for_guest(slug, booking_id, email)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    if not cr:
        return None
    return _change_request_to_dict(cr)


def _change_request_to_dict(cr: dict) -> dict:
    """Serialize a change_request DB row for guest/admin JSON responses."""
    import json as _json

    def _decode(val, default):
        if val is None:
            return default
        if isinstance(val, str):
            try:
                return _json.loads(val)
            except (TypeError, ValueError):
                return default
        return val

    return {
        "id": str(cr["id"]),
        "bookingId": str(cr["booking_id"]),
        "status": cr["status"],
        "oldCheckIn": str(cr["old_check_in"]),
        "oldCheckOut": str(cr["old_check_out"]),
        "oldAddonIds": _decode(cr.get("old_addon_ids"), []),
        "oldAddonQuantities": _decode(cr.get("old_addon_quantities"), {}),
        "oldAddonDates": _decode(cr.get("old_addon_dates"), {}),
        "oldTotal": float(cr["old_total"]),
        "requestedCheckIn": str(cr["requested_check_in"]),
        "requestedCheckOut": str(cr["requested_check_out"]),
        "requestedAddonIds": _decode(cr.get("requested_addon_ids"), []),
        "requestedAddonQuantities": _decode(cr.get("requested_addon_quantities"), {}),
        "requestedAddonDates": _decode(cr.get("requested_addon_dates"), {}),
        "requestedAddonNames": _decode(cr.get("requested_addon_names"), []),
        "newTotal": float(cr["new_total"]),
        "priceDifference": float(cr["price_difference"]),
        "currency": cr["currency"],
        "declineReason": cr.get("decline_reason"),
        "decidedAt": cr["decided_at"].isoformat() if cr.get("decided_at") else None,
        "createdAt": cr["created_at"].isoformat() if cr.get("created_at") else None,
    }


@router.get("/{slug}/payment-settings")
async def get_payment_settings(slug: str):
    """Public endpoint to check if pay-at-property is enabled and guest form settings."""
    hotel_id = await get_hotel_id_by_slug(slug)
    settings = await HotelPaymentSettingsRepository.get_by_hotel_id(hotel_id)
    policy = await CancellationPolicyRepository.get_by_hotel_id(hotel_id)

    hotel = await Database.fetchrow(
        "SELECT special_requests_enabled, arrival_time_enabled, guest_count_enabled, "
        "same_day_bookings_enabled, same_day_booking_cutoff_time "
        "FROM hotels WHERE id = $1",
        hotel_id,
    )

    # Read payment method flags from booking engine DB (authoritative source —
    # the booking admin settings page writes there). Fall back to PMS settings
    # if the booking engine DB is unavailable (helper logs the failure).
    be_payment_flags = await hotel_identity_service.get_payment_flags_by_slug(slug)

    if be_payment_flags:
        pay_at_property = be_payment_flags.get("pay_at_property_enabled", False)
        online_card = be_payment_flags.get("online_card_payment", False)
        bank_transfer = be_payment_flags.get("bank_transfer", False)
        paypal_enabled = be_payment_flags.get("paypal_enabled", False)
    else:
        pay_at_property = settings["pay_at_property_enabled"] if settings else False
        online_card = settings.get("online_card_payment", False) if settings else False
        bank_transfer = settings.get("bank_transfer", False) if settings else False
        paypal_enabled = False

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
        "paypalEnabled": paypal_enabled,
        "xenditPaymentsEnabled": settings.get("xendit_payments_enabled", False)
        if settings
        else False,
        "freeCancellationDays": policy["free_cancellation_days"] if policy else 7,
        "specialRequestsEnabled": hotel["special_requests_enabled"] if hotel else True,
        "arrivalTimeEnabled": hotel["arrival_time_enabled"] if hotel else False,
        "guestCountEnabled": hotel["guest_count_enabled"] if hotel else False,
        "sameDayBookingsEnabled": hotel["same_day_bookings_enabled"] if hotel else True,
        "sameDayBookingCutoffTime": hotel["same_day_booking_cutoff_time"] if hotel else "18:00",
    }

    # Fetch pay-at-hotel methods, bank details, and policy texts from booking engine DB.
    be_hotel = await hotel_identity_service.get_guest_payment_info_by_slug(slug)
    if be_hotel:
        import json

        methods = be_hotel.get("pay_at_hotel_methods")
        if isinstance(methods, str):
            methods = json.loads(methods)
        result["payAtHotelMethods"] = methods or ["cash", "card"]
        result["termsText"] = be_hotel.get("terms_text") or ""
        result["cancellationPolicyText"] = be_hotel.get("cancellation_policy_text") or ""
        result["paypalEmail"] = (be_hotel.get("paypal_email") or "") if paypal_enabled else ""
        result["paypalPaymentWindowHours"] = (
            (be_hotel.get("paypal_payment_window_hours") or 24) if paypal_enabled else 24
        )
        if bank_transfer and _bank_details_complete(be_hotel):
            result["bankDetails"] = {
                "accountHolder": be_hotel.get("payout_account_holder") or "",
                "accountType": be_hotel.get("payout_account_type") or "iban",
                "iban": be_hotel.get("payout_iban") or "",
                "accountNumber": be_hotel.get("payout_account_number") or "",
                "bankName": be_hotel.get("payout_bank_name") or "",
                "swift": be_hotel.get("payout_swift") or "",
            }
        else:
            result["bankTransfer"] = False
    else:
        result["payAtHotelMethods"] = ["cash", "card"]
        result["termsText"] = ""
        result["cancellationPolicyText"] = ""
        result["paypalEmail"] = ""
        result["paypalPaymentWindowHours"] = 24
        if bank_transfer:
            result["bankTransfer"] = False

    return result
