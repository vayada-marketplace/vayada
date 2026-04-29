import asyncio
import logging
import math
from datetime import date, datetime, timedelta, timezone
from typing import Optional

import httpx

from app.config import settings
from app.database import Database
from app.repositories.room_type_repo import RoomTypeRepository
from app.repositories.booking_repo import BookingRepository
from app.repositories.payment_repo import PaymentRepository
from app.repositories.payout_repo import PayoutRepository
from app.repositories.hotel_payment_settings_repo import HotelPaymentSettingsRepository
from app.repositories.cancellation_policy_repo import CancellationPolicyRepository
from app.repositories.affiliate_repo import AffiliateRepository
from app.models.booking import BookingCreate, BookingResponse
from app.services import stripe_service, xendit_service
from app.services.availability_service import compute_stay_pricing, remaining_for_stay
from app.services.currency_service import get_exchange_rate
from app.services.payout_service import calculate_split, fetch_billing_config, schedule_payouts
from app.services.room_type_service import resolve_last_minute_discount
from app.services.channex.ari_push import push_availability_for_room_type
from app.services.channex.orchestrator import push_ari_for_booking
from app.services.channex.outbound import handle_vayada_cancellation as channex_handle_cancellation
from app.services.email_service import (
    send_booking_request_notification,
    send_guest_booking_requested,
    send_guest_booking_accepted,
    send_guest_booking_rejected,
    send_guest_booking_expired,
    send_host_booking_withdrawn,
    send_guest_cancellation_refund,
    send_guest_booking_withdrawn,
    send_host_booking_accepted,
    send_host_guest_cancelled,
    send_host_booking_expired,
)
from app.utils import get_hotel_id

logger = logging.getLogger(__name__)

HOST_RESPONSE_HOURS = 24


def _nights(check_in: date, check_out: date) -> int:
    return (check_out - check_in).days


def _booking_to_response(booking: dict) -> BookingResponse:
    ci = booking["check_in"]
    co = booking["check_out"]
    deadline = booking.get("host_response_deadline")
    return BookingResponse(
        id=str(booking["id"]),
        booking_reference=booking["booking_reference"],
        hotel_name=booking["hotel_name"],
        room_name=booking["room_name"],
        guest_first_name=booking["guest_first_name"],
        guest_last_name=booking["guest_last_name"],
        guest_email=booking["guest_email"],
        check_in=str(ci),
        check_out=str(co),
        nights=_nights(ci, co),
        adults=booking["adults"],
        children=booking["children"],
        nightly_rate=float(booking["nightly_rate"]),
        total_amount=float(booking["total_amount"]),
        addon_total=float(booking.get("addon_total") or 0),
        currency=booking["currency"],
        status=booking["status"],
        payment_method=booking.get("payment_method"),
        payment_status=booking.get("payment_status"),
        host_response_deadline=deadline.isoformat() if deadline else None,
        created_at=booking["created_at"].isoformat(),
    )


async def create_booking_request(slug: str, data: BookingCreate) -> dict:
    """
    New guest-facing flow: creates booking + payment intent (if card).
    Returns booking data + client_secret for Stripe.
    """
    hotel = await Database.fetchrow(
        "SELECT id, name, contact_email, last_minute_discount, instant_book FROM hotels WHERE slug = $1", slug
    )
    if not hotel:
        raise ValueError("Hotel not found")
    instant_book = bool(hotel.get("instant_book"))

    hotel_id = str(hotel["id"])
    room = await RoomTypeRepository.get_by_id(data.room_type_id)
    if not room or str(room["hotel_id"]) != hotel_id:
        raise ValueError("Room type not found")
    if not room["is_active"]:
        raise ValueError("Room type is not available")

    available = await remaining_for_stay(
        data.room_type_id, room["total_rooms"], data.check_in, data.check_out
    )
    if available < data.number_of_rooms:
        raise ValueError("Not enough rooms available for the selected dates")

    nights = _nights(data.check_in, data.check_out)
    if nights <= 0:
        raise ValueError("Check-out must be after check-in")

    seasons = RoomTypeRepository._parse_seasons(room)
    min_stay = RoomTypeRepository._find_season_min_stay(seasons, data.check_in)
    if min_stay and nights < min_stay:
        raise ValueError(
            f"This room requires a minimum stay of {min_stay} nights for the selected dates"
        )

    # Check minimum advance booking days
    min_advance = room.get("minimum_advance_days") or 0
    if min_advance > 0:
        days_until_checkin = (data.check_in - date.today()).days
        if days_until_checkin < min_advance:
            raise ValueError(
                f"This room requires booking at least {min_advance} days in advance"
            )

    # Validate the selected payment method is allowed for this rate. If
    # the room has a `rate_payment_methods` override, enforce it; otherwise
    # fall through to the hotel-level enabled methods (checked further below).
    rate_methods_raw = room.get("rate_payment_methods")
    if rate_methods_raw:
        import json as _j
        rate_methods = _j.loads(rate_methods_raw) if isinstance(rate_methods_raw, str) else rate_methods_raw
        allowed = rate_methods.get(data.rate_type) if isinstance(rate_methods, dict) else None
        if allowed is not None and data.payment_method not in allowed:
            raise ValueError(
                f"Payment method '{data.payment_method}' is not allowed for the "
                f"{data.rate_type} rate on this room. Allowed: {', '.join(allowed) or '(none)'}"
            )

    pricing = compute_stay_pricing(
        room, data.check_in, data.check_out, data.adults, data.rate_type
    )
    room_total = round(pricing.room_total * data.number_of_rooms, 2)

    # Apply last-minute discount (based on days before check-in)
    import json as _json
    lm_discount_pct = 0
    lm_discount_amount = 0.0
    days_before = (data.check_in - date.today()).days
    hotel_lm_raw = hotel.get("last_minute_discount")
    hotel_lm_config = _json.loads(hotel_lm_raw) if isinstance(hotel_lm_raw, str) else hotel_lm_raw if hotel_lm_raw else None
    room_lm_raw = room.get("last_minute_discount")
    room_lm_config = _json.loads(room_lm_raw) if isinstance(room_lm_raw, str) else room_lm_raw if room_lm_raw else None
    pct = resolve_last_minute_discount(hotel_lm_config, room_lm_config, days_before)
    if pct and pct > 0:
        lm_discount_pct = pct
        lm_discount_amount = round(room_total * (pct / 100), 2)
        room_total = round(room_total - lm_discount_amount, 2)

    # Average nightly rate for display/record
    nightly_rate = round(room_total / (nights * data.number_of_rooms), 2)

    # Calculate addon total from booking engine
    addon_total = 0.0
    addon_ids = data.addon_ids or []
    addon_names = []
    addon_quantities = data.addon_quantities or {}
    if addon_ids:
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(
                    f"{settings.BOOKING_ENGINE_API_URL}/api/hotels/{slug}/addons"
                )
                resp.raise_for_status()
                all_addons = resp.json()
        except Exception as e:
            logger.warning("Failed to fetch addons for %s: %s", slug, e)
            all_addons = []

        addon_map = {a["id"]: a for a in all_addons}
        room_currency = (room.get("currency") or "EUR").upper()
        rate_cache: dict = {}
        for aid in addon_ids:
            addon = addon_map.get(aid)
            if not addon:
                continue
            addon_names.append(addon.get("name", "Unknown"))
            price = float(addon["price"])
            if addon.get("perPerson"):
                price *= data.adults
            if addon.get("perNight"):
                qty = addon_quantities.get(aid, nights)
                qty = max(1, min(qty, nights))
                price *= qty
            # Convert addon price to room currency so the booking total
            # matches what the frontend showed the guest. The booking
            # engine frontend does the same conversion in payment/page.tsx.
            addon_currency = (addon.get("currency") or room_currency).upper()
            if addon_currency != room_currency:
                if addon_currency not in rate_cache:
                    try:
                        rate_cache[addon_currency] = await get_exchange_rate(
                            addon_currency, room_currency
                        )
                    except Exception as e:
                        logger.warning(
                            "Failed to fetch addon exchange rate %s -> %s: %s",
                            addon_currency, room_currency, e,
                        )
                        rate_cache[addon_currency] = 1.0
                price = price * rate_cache[addon_currency]
            addon_total += price
        addon_total = round(addon_total, 2)

    subtotal = room_total + addon_total

    # Validate and apply promo code
    promo_discount = 0.0
    promo_code_str = None
    if data.promo_code:
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(
                    f"{settings.BOOKING_ENGINE_API_URL}/api/hotels/{slug}/validate-promo",
                    params={"code": data.promo_code},
                )
                resp.raise_for_status()
                promo_result = resp.json()
        except Exception as e:
            logger.warning("Failed to validate promo for %s: %s", slug, e)
            promo_result = {"valid": False}

        if promo_result.get("valid"):
            promo_code_str = promo_result["code"]
            discount_type = promo_result["discountType"]
            discount_value = float(promo_result["discountValue"])
            if discount_type == "percentage":
                promo_discount = round(subtotal * (discount_value / 100), 2)
            else:
                promo_discount = min(discount_value, subtotal)

    # Handle promo vs last-minute stacking
    stack_with_promo = (hotel_lm_config or {}).get("stackWithPromo", False)
    if not stack_with_promo and lm_discount_amount > 0 and promo_discount > 0:
        # Keep only the larger discount
        if promo_discount > lm_discount_amount:
            # Promo wins — undo last-minute discount
            room_total = round(room_total + lm_discount_amount, 2)
            nightly_rate = round(room_total / (nights * data.number_of_rooms), 2)
            subtotal = room_total + addon_total
            lm_discount_pct = 0
            lm_discount_amount = 0.0
        else:
            # Last-minute wins — drop promo
            promo_discount = 0.0
            promo_code_str = None

    total_amount = round(subtotal - promo_discount, 2)

    # Resolve affiliate
    affiliate_id = None
    if data.referral_code:
        affiliate = await Database.fetchrow(
            "SELECT id FROM affiliates WHERE hotel_id = $1 AND referral_code = $2 AND status = 'approved'",
            hotel_id,
            data.referral_code,
        )
        if affiliate:
            affiliate_id = str(affiliate["id"])

    # Validate payment method
    payment_method = data.payment_method
    if payment_method == "pay_at_property":
        hotel_settings = await HotelPaymentSettingsRepository.get_by_hotel_id(hotel_id)
        if not hotel_settings or not hotel_settings["pay_at_property_enabled"]:
            raise ValueError("Pay at property is not enabled for this hotel")
    elif payment_method == "xendit":
        hotel_settings = await HotelPaymentSettingsRepository.get_by_hotel_id(hotel_id)
        if not hotel_settings or not hotel_settings.get("xendit_payments_enabled"):
            raise ValueError("Xendit payments are not enabled for this hotel")

    # Bank transfer is the only path that always stays in the request flow, even
    # when instant_book is on — there's no money yet, so we can't auto-confirm.
    use_request_flow = (not instant_book) or payment_method == "bank_transfer"
    deadline = (
        datetime.now(timezone.utc) + timedelta(hours=HOST_RESPONSE_HOURS)
        if use_request_flow
        else None
    )

    booking_data = {
        "hotel_id": hotel_id,
        "room_type_id": data.room_type_id,
        "guest_first_name": data.guest_first_name,
        "guest_last_name": data.guest_last_name,
        "guest_email": data.guest_email,
        "guest_phone": data.guest_phone,
        "guest_country": data.guest_country,
        "special_requests": data.special_requests,
        "estimated_arrival_time": data.estimated_arrival_time,
        "number_of_guests": data.number_of_guests,
        "check_in": data.check_in,
        "check_out": data.check_out,
        "adults": data.adults,
        "children": data.children,
        "nightly_rate": nightly_rate,
        "number_of_rooms": data.number_of_rooms,
        "total_amount": total_amount,
        "currency": room["currency"],
        "referral_code": data.referral_code,
        "affiliate_id": affiliate_id,
        "payment_method": payment_method,
        "payment_status": "unpaid",
        "host_response_deadline": deadline,
        "rate_type": data.rate_type,
        "addon_ids": addon_ids,
        "addon_names": addon_names,
        "addon_total": addon_total,
        "addon_quantities": addon_quantities,
        "promo_code": promo_code_str,
        "promo_discount": promo_discount,
        "last_minute_discount_percent": lm_discount_pct,
        "last_minute_discount_amount": lm_discount_amount,
    }
    # Auto-assign an available room unit
    available_room = await Database.fetchrow(
        """
        SELECT r.id FROM rooms r
        WHERE r.room_type_id = $1
          AND r.status = 'available'
          AND r.id NOT IN (
            SELECT b.room_id FROM bookings b
            WHERE b.room_id IS NOT NULL
              AND b.status IN ('pending', 'confirmed')
              AND b.check_in < $3
              AND b.check_out > $2
          )
        ORDER BY r.sort_order,
                 (COALESCE(NULLIF(regexp_replace(r.room_number, '[^0-9].*', '', 'g'), ''), '0'))::int,
                 r.room_number
        LIMIT 1
        """,
        data.room_type_id, data.check_in, data.check_out,
    )
    if available_room:
        booking_data["room_id"] = str(available_room["id"])

    booking_row = await BookingRepository.create(booking_data)
    booking_id = str(booking_row["id"])

    # Increment promo code use count
    if promo_code_str:
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                await client.post(
                    f"{settings.BOOKING_ENGINE_API_URL}/api/hotels/{slug}/increment-promo",
                    params={"code": promo_code_str},
                )
        except Exception as e:
            logger.warning("Failed to increment promo use count: %s", e)

    client_secret = None
    xendit_invoice_url = None

    capture_method = "manual" if use_request_flow else "automatic"

    if payment_method == "card":
        # Get hotel payment settings to determine provider
        hotel_settings = await HotelPaymentSettingsRepository.get_by_hotel_id(hotel_id)
        provider = hotel_settings.get("payment_provider", "stripe") if hotel_settings else "stripe"

        if provider == "vayada":
            # vayada Payment: charge on platform Stripe account (no Connect)
            amount_cents = int(math.ceil(total_amount * 100))
            try:
                pi = await stripe_service.create_payment_intent(
                    amount=amount_cents,
                    currency=room["currency"],
                    metadata={"booking_id": booking_id, "hotel_id": hotel_id},
                    capture_method=capture_method,
                )
            except Exception:
                await Database.execute("DELETE FROM bookings WHERE id = $1", booking_id)
                raise
            client_secret = pi["client_secret"]

            await PaymentRepository.create(
                booking_id=booking_id,
                amount=total_amount,
                currency=room["currency"],
                payment_method="card",
                stripe_pi_id=pi["id"],
            )
        else:
            # Stripe Connect — hotel's own connected account
            stripe_account = None
            if hotel_settings and hotel_settings.get("stripe_connect_account_id"):
                if hotel_settings.get("stripe_connect_onboarded"):
                    stripe_account = hotel_settings["stripe_connect_account_id"]

            if stripe_account:
                # Create Stripe PaymentIntent. Manual capture for the request
                # flow (auth-hold until host accepts), automatic capture under
                # instant-book.
                amount_cents = int(math.ceil(total_amount * 100))
                try:
                    pi = await stripe_service.create_payment_intent(
                        amount=amount_cents,
                        currency=room["currency"],
                        metadata={"booking_id": booking_id, "hotel_id": hotel_id},
                        stripe_account=stripe_account,
                        capture_method=capture_method,
                    )
                except Exception:
                    # Clean up the booking if Stripe fails
                    await Database.execute("DELETE FROM bookings WHERE id = $1", booking_id)
                    raise
                client_secret = pi["client_secret"]

                # Create payment record
                await PaymentRepository.create(
                    booking_id=booking_id,
                    amount=total_amount,
                    currency=room["currency"],
                    payment_method="card",
                    stripe_pi_id=pi["id"],
                )
            else:
                # Don't silently downgrade to pay-at-property: the guest picked
                # "card" specifically, so surfacing a different outcome silently
                # is a trust/UX bug. If the /payment-settings gating is doing
                # its job, this branch is unreachable from the UI.
                await Database.execute("DELETE FROM bookings WHERE id = $1", booking_id)
                raise ValueError("This hotel has not finished setting up online payments. Please contact the hotel or choose another payment method.")

    elif payment_method == "xendit":
        # Create Xendit Invoice — supports QRIS, e-wallets, VA, cards
        booking_ref = booking_row["booking_reference"]
        try:
            invoice = await xendit_service.create_invoice(
                external_id=f"booking-{booking_id}",
                amount=total_amount,
                currency=room["currency"],
                payer_email=data.guest_email,
                description=f"Booking {booking_ref} at {hotel['name']}",
                success_redirect_url=f"{settings.BOOKING_ENGINE_URL}/{hotel['slug']}/booking/{booking_id}/confirmation",
                failure_redirect_url=f"{settings.BOOKING_ENGINE_URL}/{hotel['slug']}/payment?failed=true",
                metadata={"booking_id": booking_id, "hotel_id": hotel_id},
            )
        except Exception:
            await Database.execute("DELETE FROM bookings WHERE id = $1", booking_id)
            raise
        xendit_invoice_url = invoice["invoice_url"]

        await PaymentRepository.create(
            booking_id=booking_id,
            amount=total_amount,
            currency=room["currency"],
            payment_method="xendit",
            xendit_invoice_id=invoice["id"],
            xendit_invoice_url=invoice["invoice_url"],
        )

    elif payment_method == "bank_transfer":
        # Bank transfer — guest transfers directly, hotel verifies manually.
        # Always uses the request flow (no money has moved, so we cannot
        # auto-confirm even when the hotel has instant-book on).
        hotel_settings = await HotelPaymentSettingsRepository.get_by_hotel_id(hotel_id)
        if not hotel_settings or not hotel_settings.get("bank_transfer"):
            raise ValueError("Bank transfer is not enabled for this hotel")
        await PaymentRepository.create(
            booking_id=booking_id,
            amount=total_amount,
            currency=room["currency"],
            payment_method="bank_transfer",
        )
        await BookingRepository.update_payment_status(booking_id, "awaiting_transfer")
        booking = await BookingRepository.get_by_id(booking_id)
        asyncio.create_task(
            send_booking_request_notification(hotel["contact_email"], booking)
        )

    else:
        # Pay at property
        await PaymentRepository.create(
            booking_id=booking_id,
            amount=total_amount,
            currency=room["currency"],
            payment_method="pay_at_property",
        )
        await BookingRepository.update_payment_status(booking_id, "pay_at_property")
        if use_request_flow:
            booking = await BookingRepository.get_by_id(booking_id)
            asyncio.create_task(
                send_booking_request_notification(hotel["contact_email"], booking)
            )
        else:
            # Instant-book: confirm right away. _finalize_accepted_booking
            # sends the host + guest "accepted" emails.
            await _finalize_accepted_booking(booking_id, capture_card=False)

    # Fetch full booking for response
    booking = await BookingRepository.get_by_id(booking_id)
    response = _booking_to_response(booking)

    # Send guest "request received" email only for the request flow.
    # _finalize_accepted_booking handles the equivalent under instant-book.
    if use_request_flow:
        asyncio.create_task(
            send_guest_booking_requested(data.guest_email, booking)
        )

    # Push updated availability to Channex so OTAs reflect the reduced inventory
    asyncio.create_task(push_availability_for_room_type(hotel_id, data.room_type_id))

    return {
        "booking": response.model_dump(by_alias=True),
        "clientSecret": client_secret,
        "xenditInvoiceUrl": xendit_invoice_url,
        "paymentMethod": payment_method,
    }


async def confirm_payment_authorized(booking_id: str) -> dict:
    """Called after Stripe confirms the card authorization."""
    booking = await BookingRepository.get_by_id(booking_id)
    if not booking:
        raise ValueError("Booking not found")
    if booking["status"] != "pending":
        raise ValueError("Booking is not in pending state")

    # Update payment status
    payment = await PaymentRepository.get_by_booking_id(booking_id)
    if payment:
        await PaymentRepository.update_status(str(payment["id"]), "authorized")

    await BookingRepository.update_payment_status(booking_id, "authorized")

    # Notify host with accept/reject
    hotel = await Database.fetchrow(
        "SELECT contact_email FROM hotels WHERE id = $1", booking["hotel_id"]
    )
    if hotel:
        asyncio.create_task(
            send_booking_request_notification(hotel["contact_email"], booking)
        )

    return {"status": "authorized"}


async def _finalize_accepted_booking(booking_id: str, *, capture_card: bool = True) -> dict:
    """Shared accept path: capture payment if needed, compute split, schedule
    payouts, mark booking confirmed, send accepted-emails, push Channex.

    Used by host_accept_booking (request flow) and by the instant-book branch
    in create_booking_request / payment webhooks. ``capture_card=False`` skips
    the manual Stripe capture step (e.g. when the PaymentIntent was created
    with automatic capture and Stripe captured at confirm time).
    """
    booking = await BookingRepository.get_by_id(booking_id)
    if not booking:
        raise ValueError("Booking not found")

    hotel_id = str(booking["hotel_id"])
    payment_method = booking.get("payment_method", "card")

    if payment_method == "card" and capture_card:
        payment = await PaymentRepository.get_by_booking_id(booking_id)
        if payment and payment.get("stripe_payment_intent_id"):
            await stripe_service.capture_payment_intent(
                payment["stripe_payment_intent_id"]
            )
            await PaymentRepository.update_status(
                str(payment["id"]), "captured", captured_at=datetime.now(timezone.utc)
            )
    elif payment_method == "xendit":
        # Xendit Invoice payments are already captured when guest pays —
        # just make sure the row reflects that.
        payment = await PaymentRepository.get_by_booking_id(booking_id)
        if payment and payment["status"] != "captured":
            await PaymentRepository.update_status(
                str(payment["id"]), "captured", captured_at=datetime.now(timezone.utc)
            )

    billing = await fetch_billing_config(hotel_id)

    has_affiliate = booking.get("affiliate_id") is not None
    affiliate_commission_pct = 0.0
    affiliate_id = None
    if has_affiliate:
        affiliate_id = str(booking["affiliate_id"])
        effective = await AffiliateRepository.get_effective_commission_pct(affiliate_id)
        if effective is not None:
            affiliate_commission_pct = effective

    total_amount = float(booking["total_amount"])
    split = calculate_split(
        total_amount,
        plan=billing["active_plan"],
        channel=booking.get("channel", "direct"),
        booking_engine_fee_pct=billing["booking_engine_fee_pct"],
        channel_manager_fee_pct=billing["channel_manager_fee_pct"],
        affiliate_platform_fee_pct=billing["affiliate_platform_fee_pct"],
        has_affiliate=has_affiliate,
        effective_affiliate_commission_pct=affiliate_commission_pct,
    )

    if payment_method in ("card", "xendit"):
        new_payment_status = "captured"
    else:
        new_payment_status = "pay_at_property"
    await BookingRepository.update_booking_accepted(
        booking_id,
        platform_fee=split["platform_fee"],
        affiliate_commission=split["affiliate_commission"],
        property_payout=split["property_payout"],
        payment_status=new_payment_status,
    )

    if payment_method in ("card", "xendit"):
        await schedule_payouts(
            booking_id=booking_id,
            hotel_id=hotel_id,
            total_amount=total_amount,
            currency=booking["currency"],
            affiliate_id=affiliate_id,
            affiliate_commission=split["affiliate_commission"],
            property_payout=split["property_payout"],
            check_out=booking["check_out"],
        )

    updated = await BookingRepository.get_by_id(booking_id)
    asyncio.create_task(
        send_guest_booking_accepted(updated["guest_email"], updated)
    )
    hotel = await Database.fetchrow(
        "SELECT contact_email FROM hotels WHERE id = $1", booking["hotel_id"]
    )
    if hotel:
        asyncio.create_task(
            send_host_booking_accepted(hotel["contact_email"], updated)
        )

    asyncio.create_task(push_ari_for_booking(booking_id))

    return updated


async def host_accept_booking(booking_id: str, user_id: str) -> dict:
    """Host accepts a pending booking — captures payment if card."""
    hotel_id = await _get_hotel_id_for_user(user_id)
    booking = await BookingRepository.get_by_id(booking_id)
    if not booking or str(booking["hotel_id"]) != hotel_id:
        raise ValueError("Booking not found")
    if booking["status"] != "pending":
        raise ValueError("Booking is not in pending state")
    return await _finalize_accepted_booking(booking_id, capture_card=True)


async def host_reject_booking(booking_id: str, user_id: str, reason: str | None = None) -> dict:
    """Host rejects a pending booking — releases hold if card, expires invoice if xendit."""
    hotel_id = await _get_hotel_id_for_user(user_id)
    booking = await BookingRepository.get_by_id(booking_id)
    if not booking or str(booking["hotel_id"]) != hotel_id:
        raise ValueError("Booking not found")
    if booking["status"] != "pending":
        raise ValueError("Booking is not in pending state")

    # Release payment hold / expire invoice
    payment = await PaymentRepository.get_by_booking_id(booking_id)
    if booking.get("payment_method") == "card":
        if payment and payment.get("stripe_payment_intent_id"):
            try:
                await stripe_service.cancel_payment_intent(
                    payment["stripe_payment_intent_id"]
                )
            except Exception as e:
                logger.warning("Failed to cancel PI for booking %s: %s", booking_id, e)
            await PaymentRepository.update_status(str(payment["id"]), "cancelled")
    elif booking.get("payment_method") == "xendit":
        if payment and payment.get("xendit_invoice_id"):
            try:
                await xendit_service.expire_invoice(payment["xendit_invoice_id"])
            except Exception as e:
                logger.warning("Failed to expire Xendit invoice for booking %s: %s", booking_id, e)
            await PaymentRepository.update_status(str(payment["id"]), "cancelled")

    await BookingRepository.update_status(booking_id, "cancelled")
    await BookingRepository.update_payment_status(booking_id, "cancelled")
    await PayoutRepository.cancel_by_booking(booking_id)

    # Notify guest
    updated = await BookingRepository.get_by_id(booking_id)
    asyncio.create_task(
        send_guest_booking_rejected(updated["guest_email"], updated, reason=reason)
    )

    # Sync cancellation and availability to Channex (fire-and-forget)
    asyncio.create_task(channex_handle_cancellation(booking_id))
    asyncio.create_task(push_ari_for_booking(booking_id))

    return updated


async def guest_withdraw_booking(booking_id: str, guest_email: str) -> dict:
    """Guest withdraws a pending booking request."""
    booking = await BookingRepository.get_by_id(booking_id)
    if not booking:
        raise ValueError("Booking not found")
    if booking["status"] != "pending":
        raise ValueError("Booking is not in pending state")
    if booking["guest_email"].lower() != guest_email.lower():
        raise ValueError("Email does not match booking")

    # Release payment hold if card
    if booking.get("payment_method") == "card":
        payment = await PaymentRepository.get_by_booking_id(booking_id)
        if payment and payment.get("stripe_payment_intent_id"):
            try:
                await stripe_service.cancel_payment_intent(
                    payment["stripe_payment_intent_id"]
                )
            except Exception as e:
                logger.warning("Failed to cancel PI for booking %s: %s", booking_id, e)
            await PaymentRepository.update_status(str(payment["id"]), "cancelled")

    await BookingRepository.update_status(booking_id, "cancelled")
    await BookingRepository.update_payment_status(booking_id, "cancelled")
    await Database.execute(
        "UPDATE bookings SET guest_withdrawn = true WHERE id = $1", booking_id
    )

    # Notify host and guest
    hotel = await Database.fetchrow(
        "SELECT contact_email FROM hotels WHERE id = $1", booking["hotel_id"]
    )
    updated = await BookingRepository.get_by_id(booking_id)
    if hotel:
        asyncio.create_task(
            send_host_booking_withdrawn(hotel["contact_email"], updated)
        )
    asyncio.create_task(
        send_guest_booking_withdrawn(updated["guest_email"], updated)
    )

    # Sync cancellation and availability to Channex (fire-and-forget)
    asyncio.create_task(channex_handle_cancellation(booking_id))
    asyncio.create_task(push_ari_for_booking(booking_id))

    return updated


async def _compute_cancellation_refund(booking: dict) -> tuple[float, float, int]:
    """Compute (refund_amount, refund_pct, free_days_for_display) for a booking.

    Non-refundable rate plans always return 0 refund — the guest accepted that
    in exchange for the discounted price. For flexible bookings with the room's
    flexible_cancellation_type set to 'partial_refund', the room's own
    (window, percent) overrides the hotel-wide cancellation policy. Otherwise
    the hotel-wide policy applies.
    """
    hotel_id = str(booking["hotel_id"])
    policy = await CancellationPolicyRepository.get_by_hotel_id(hotel_id)
    free_days = policy["free_cancellation_days"] if policy else 7
    partial_pct = float(policy["partial_refund_pct"]) if policy else 0.0

    if booking.get("rate_type") == "nonrefundable":
        return 0.0, 0.0, free_days

    check_in = booking["check_in"]
    days_until = (check_in - date.today()).days
    total_amount = float(booking["total_amount"])

    if booking.get("rate_type") == "flexible":
        room_type = await RoomTypeRepository.get_by_id(str(booking["room_type_id"]))
        if room_type and room_type.get("flexible_cancellation_type") == "partial_refund":
            window = room_type.get("partial_refund_cancel_window_days") or 30
            percent = float(room_type.get("partial_refund_amount_percent") or 50)
            if days_until >= window:
                return round(total_amount * percent / 100, 2), percent, window
            return 0.0, 0.0, window

    if days_until >= free_days:
        return total_amount, 100.0, free_days
    if partial_pct > 0:
        return round(total_amount * partial_pct / 100, 2), partial_pct, free_days
    return 0.0, 0.0, free_days


async def get_cancellation_preview(booking_id: str, guest_email: str) -> dict:
    """Calculate refund details without actually cancelling."""
    booking = await BookingRepository.get_by_id(booking_id)
    if not booking:
        raise ValueError("Booking not found")
    if booking["status"] != "confirmed":
        raise ValueError("Only confirmed bookings can be previewed for cancellation")
    if booking["guest_email"].lower() != guest_email.lower():
        raise ValueError("Email does not match booking")

    refund_amount, refund_pct, free_days = await _compute_cancellation_refund(booking)
    days_until = (booking["check_in"] - date.today()).days

    return {
        "refundAmount": refund_amount,
        "refundPercentage": refund_pct,
        "freeCancellationDays": free_days,
        "daysUntilCheckIn": days_until,
        "currency": booking["currency"],
    }


async def handle_guest_cancellation(booking_id: str, guest_email: str) -> dict:
    """Guest cancels a confirmed booking — applies cancellation policy."""
    booking = await BookingRepository.get_by_id(booking_id)
    if not booking:
        raise ValueError("Booking not found")
    if booking["status"] != "confirmed":
        raise ValueError("Only confirmed bookings can be cancelled")
    if booking["guest_email"].lower() != guest_email.lower():
        raise ValueError("Email does not match booking")

    refund_amount, refund_pct, _ = await _compute_cancellation_refund(booking)

    # Process refund if card payment
    if booking.get("payment_method") == "card" and refund_amount > 0:
        payment = await PaymentRepository.get_by_booking_id(booking_id)
        if payment and payment.get("stripe_payment_intent_id"):
            try:
                refund_cents = int(math.ceil(refund_amount * 100)) if refund_pct < 100 else None
                await stripe_service.create_refund(
                    payment["stripe_payment_intent_id"],
                    amount=refund_cents,
                )
                new_status = "refunded" if refund_pct >= 100 else "partially_refunded"
                await PaymentRepository.update_status(
                    str(payment["id"]),
                    new_status,
                    refunded_at=datetime.now(timezone.utc),
                    refund_amount=refund_amount,
                )
            except Exception as e:
                logger.error("Failed to refund booking %s: %s", booking_id, e)

    await BookingRepository.update_status(booking_id, "cancelled")
    new_payment_status = "refunded" if refund_pct >= 100 else (
        "partially_refunded" if refund_amount > 0 else booking.get("payment_status", "captured")
    )
    await BookingRepository.update_payment_status(booking_id, new_payment_status)
    await PayoutRepository.cancel_by_booking(booking_id)

    updated = await BookingRepository.get_by_id(booking_id)
    asyncio.create_task(
        send_guest_cancellation_refund(
            updated["guest_email"], updated, refund_amount, refund_pct
        )
    )
    hotel = await Database.fetchrow(
        "SELECT contact_email FROM hotels WHERE id = $1", booking["hotel_id"]
    )
    if hotel:
        asyncio.create_task(
            send_host_guest_cancelled(hotel["contact_email"], updated)
        )

    # Sync cancellation and availability to Channex (fire-and-forget)
    asyncio.create_task(channex_handle_cancellation(booking_id))
    asyncio.create_task(push_ari_for_booking(booking_id))

    return updated


async def expire_booking(booking_id: str) -> None:
    """Called by scheduler when host doesn't respond within 24h."""
    booking = await BookingRepository.get_by_id(booking_id)
    if not booking or booking["status"] != "pending":
        return

    # Release payment hold / expire invoice
    payment = await PaymentRepository.get_by_booking_id(booking_id)
    if booking.get("payment_method") == "card":
        if payment and payment.get("stripe_payment_intent_id"):
            try:
                await stripe_service.cancel_payment_intent(
                    payment["stripe_payment_intent_id"]
                )
            except Exception as e:
                logger.warning("Failed to cancel PI for expired booking %s: %s", booking_id, e)
            await PaymentRepository.update_status(str(payment["id"]), "cancelled")
    elif booking.get("payment_method") == "xendit":
        if payment and payment.get("xendit_invoice_id"):
            try:
                await xendit_service.expire_invoice(payment["xendit_invoice_id"])
            except Exception as e:
                logger.warning("Failed to expire Xendit invoice for expired booking %s: %s", booking_id, e)
            await PaymentRepository.update_status(str(payment["id"]), "cancelled")

    await BookingRepository.update_status(booking_id, "expired")
    await BookingRepository.update_payment_status(booking_id, "cancelled")

    # Notify both parties
    hotel = await Database.fetchrow(
        "SELECT contact_email FROM hotels WHERE id = $1", booking["hotel_id"]
    )
    updated = await BookingRepository.get_by_id(booking_id)
    asyncio.create_task(send_guest_booking_expired(updated["guest_email"], updated))
    if hotel:
        asyncio.create_task(send_host_booking_expired(hotel["contact_email"], updated))


async def lookup_booking(
    slug: str, booking_reference: str, guest_email: str
) -> BookingResponse | None:
    booking = await BookingRepository.lookup(booking_reference, guest_email)
    if not booking:
        return None
    hotel = await Database.fetchrow(
        "SELECT id FROM hotels WHERE slug = $1", slug
    )
    if not hotel or str(booking["hotel_id"]) != str(hotel["id"]):
        return None
    return _booking_to_response(booking)


async def get_booking_status(slug: str, booking_reference: str, guest_email: str) -> Optional[dict]:
    """Get booking status for frontend polling."""
    booking = await BookingRepository.lookup(booking_reference, guest_email)
    if not booking:
        return None
    hotel = await Database.fetchrow(
        "SELECT id FROM hotels WHERE slug = $1", slug
    )
    if not hotel or str(booking["hotel_id"]) != str(hotel["id"]):
        return None
    return {
        "status": booking["status"],
        "paymentStatus": booking.get("payment_status"),
        "hostResponseDeadline": booking["host_response_deadline"].isoformat() if booking.get("host_response_deadline") else None,
    }


async def _get_hotel_id_for_user(user_id: str) -> str:
    """Delegate to the central get_hotel_id helper so that the
    X-Hotel-Id header is honored for admin-created bookings too.
    Previously this bypassed the helper and always picked the
    first hotel row — fine for single-hotel accounts, a silent
    data-routing bug for multi-hotel accounts."""
    try:
        return await get_hotel_id(user_id)
    except Exception:
        raise ValueError("No hotel found for this account")
