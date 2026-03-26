import hmac
import hashlib
import logging

from fastapi import APIRouter, HTTPException, Request

from app.config import settings
from app.services import stripe_service
from app.repositories.payment_repo import PaymentRepository
from app.repositories.booking_repo import BookingRepository
from app.repositories.payout_repo import PayoutRepository
from app.repositories.hotel_payment_settings_repo import HotelPaymentSettingsRepository
from app.repositories.affiliate_repo import AffiliateRepository

logger = logging.getLogger(__name__)

router = APIRouter(tags=["webhooks"])


@router.post("/webhooks/stripe")
async def stripe_webhook(request: Request):
    """Handle Stripe webhook events."""
    payload = await request.body()
    sig = request.headers.get("stripe-signature")

    if not sig:
        raise HTTPException(status_code=400, detail="Missing stripe-signature header")

    try:
        event = stripe_service.construct_webhook_event(payload, sig)
    except Exception as e:
        logger.warning("Webhook signature verification failed: %s", e)
        raise HTTPException(status_code=400, detail="Invalid signature")

    event_type = event["type"]
    data = event["data"]["object"]

    if event_type == "payment_intent.amount_capturable_updated":
        # Payment authorized (hold placed)
        pi_id = data["id"]
        payment = await PaymentRepository.get_by_stripe_pi(pi_id)
        if payment:
            await PaymentRepository.update_status(str(payment["id"]), "authorized")
            await BookingRepository.update_payment_status(
                str(payment["booking_id"]), "authorized"
            )
            logger.info("Payment authorized via webhook: %s", pi_id)

    elif event_type == "payment_intent.succeeded":
        # Payment captured
        pi_id = data["id"]
        payment = await PaymentRepository.get_by_stripe_pi(pi_id)
        if payment:
            card = data.get("charges", {}).get("data", [{}])[0].get("payment_method_details", {}).get("card", {})
            await PaymentRepository.update_status(
                str(payment["id"]),
                "captured",
                card_last_four=card.get("last4"),
                card_brand=card.get("brand"),
            )
            logger.info("Payment captured via webhook: %s", pi_id)

    elif event_type == "payment_intent.canceled":
        pi_id = data["id"]
        payment = await PaymentRepository.get_by_stripe_pi(pi_id)
        if payment:
            await PaymentRepository.update_status(str(payment["id"]), "cancelled")
            logger.info("Payment cancelled via webhook: %s", pi_id)

    elif event_type == "payment_intent.payment_failed":
        pi_id = data["id"]
        payment = await PaymentRepository.get_by_stripe_pi(pi_id)
        if payment:
            await PaymentRepository.update_status(str(payment["id"]), "failed")
            await BookingRepository.update_payment_status(
                str(payment["booking_id"]), "failed"
            )
            logger.info("Payment failed via webhook: %s", pi_id)

    elif event_type == "account.updated":
        # Stripe Connect account status update
        account_id = data["id"]
        charges_enabled = data.get("charges_enabled", False)
        if charges_enabled:
            # Mark hotel as onboarded
            from app.database import Database
            row = await Database.fetchrow(
                "SELECT hotel_id FROM hotel_payment_settings WHERE stripe_connect_account_id = $1",
                account_id,
            )
            if row:
                await HotelPaymentSettingsRepository.upsert(
                    str(row["hotel_id"]),
                    {"stripe_connect_onboarded": True},
                )
                logger.info("Stripe Connect account onboarded (hotel): %s", account_id)
            else:
                # Check if this is an affiliate Connect account
                affiliate = await AffiliateRepository.get_by_stripe_account_id(account_id)
                if affiliate:
                    await AffiliateRepository.mark_stripe_onboarded(account_id)
                    logger.info("Stripe Connect account onboarded (affiliate): %s", account_id)

    return {"status": "ok"}


@router.post("/webhooks/beds24")
async def beds24_webhook(request: Request):
    """Handle Beds24 webhook events for booking notifications."""
    import asyncio
    import json

    payload = await request.body()
    token = request.headers.get("x-beds24-token")

    if not token:
        raise HTTPException(status_code=400, detail="Missing x-beds24-token header")

    if not hmac.compare_digest(token, settings.BEDS24_WEBHOOK_SECRET):
        logger.warning("Beds24 webhook token verification failed")
        raise HTTPException(status_code=400, detail="Invalid webhook token")

    data = json.loads(payload)

    # Normalize to list (Beds24 may send single booking or array)
    bookings = data if isinstance(data, list) else [data]

    for b24_booking in bookings:
        property_id = str(b24_booking.get("propertyId", ""))
        if not property_id:
            continue

        from app.repositories.beds24_mapping_repo import Beds24ConnectionRepository
        conn = await Beds24ConnectionRepository.get_by_property_id(property_id)
        if not conn:
            logger.warning("No Beds24 connection for property %s", property_id)
            continue

        hotel_id = str(conn["hotel_id"])

        from app.services.beds24_sync_service import (
            process_inbound_booking,
            push_availability_for_booking,
        )
        await process_inbound_booking(b24_booking, hotel_id)

        # If a booking was created, push updated availability
        from app.repositories.beds24_mapping_repo import Beds24BookingMappingRepository
        mapping = await Beds24BookingMappingRepository.get_by_beds24_id(
            str(b24_booking.get("id", ""))
        )
        if mapping:
            asyncio.create_task(
                push_availability_for_booking(str(mapping["booking_id"]))
            )

    return {"status": "ok"}


@router.post("/webhooks/xendit")
async def xendit_webhook(request: Request):
    """Handle Xendit webhook events for payouts and invoice payments."""
    payload = await request.body()
    callback_token = request.headers.get("x-callback-token")

    if not callback_token:
        raise HTTPException(status_code=400, detail="Missing x-callback-token header")

    if not hmac.compare_digest(callback_token, settings.XENDIT_WEBHOOK_SECRET):
        logger.warning("Xendit webhook token verification failed")
        raise HTTPException(status_code=400, detail="Invalid callback token")

    import json
    data = json.loads(payload)
    event_type = data.get("event")

    # ── Invoice callbacks (payment acceptance) ────────────────────
    # Xendit Invoice callbacks have top-level "id", "status", "external_id"
    if data.get("external_id") and data.get("id") and not event_type:
        await _handle_invoice_callback(data)
        return {"status": "ok"}

    # ── Payout callbacks ─────────────────────────────────────────
    payout_data = data.get("data", {})
    xendit_payout_id = payout_data.get("id")
    status = payout_data.get("status")

    if not xendit_payout_id:
        return {"status": "ok"}

    if event_type == "payout.succeeded" or status == "SUCCEEDED":
        from app.database import Database
        row = await Database.fetchrow(
            "SELECT id FROM payouts WHERE xendit_payout_id = $1",
            xendit_payout_id,
        )
        if row:
            await PayoutRepository.update_status(
                str(row["id"]), "completed", xendit_payout_id=xendit_payout_id
            )
            logger.info("Xendit payout completed: %s", xendit_payout_id)

    elif event_type == "payout.failed" or status == "FAILED":
        from app.database import Database
        row = await Database.fetchrow(
            "SELECT id FROM payouts WHERE xendit_payout_id = $1",
            xendit_payout_id,
        )
        if row:
            await PayoutRepository.update_status(str(row["id"]), "failed")
            logger.warning("Xendit payout failed: %s", xendit_payout_id)

    return {"status": "ok"}


async def _handle_invoice_callback(data: dict):
    """Handle Xendit Invoice payment callback (guest paid via QRIS/ewallet/VA)."""
    import asyncio

    xendit_invoice_id = data.get("id")
    invoice_status = data.get("status")
    external_id = data.get("external_id", "")
    payment_method = data.get("payment_method")
    payment_channel = data.get("payment_channel")

    payment = await PaymentRepository.get_by_xendit_invoice(xendit_invoice_id)
    if not payment:
        logger.warning("No payment found for Xendit invoice %s", xendit_invoice_id)
        return

    payment_id = str(payment["id"])
    booking_id = str(payment["booking_id"])

    if invoice_status == "PAID":
        # Guest has paid — mark payment as captured and notify host
        await PaymentRepository.update_status(payment_id, "captured")
        await BookingRepository.update_payment_status(booking_id, "authorized")

        # Notify host to accept/reject
        booking = await BookingRepository.get_by_id(booking_id)
        if booking:
            from app.database import Database
            hotel = await Database.fetchrow(
                "SELECT contact_email FROM hotels WHERE id = $1", booking["hotel_id"]
            )
            if hotel:
                from app.services.email_service import send_booking_request_notification
                asyncio.create_task(
                    send_booking_request_notification(hotel["contact_email"], booking)
                )

        logger.info(
            "Xendit invoice paid: %s method=%s channel=%s booking=%s",
            xendit_invoice_id, payment_method, payment_channel, booking_id,
        )

    elif invoice_status == "EXPIRED":
        await PaymentRepository.update_status(payment_id, "cancelled")
        await BookingRepository.update_payment_status(booking_id, "cancelled")
        await BookingRepository.update_status(booking_id, "cancelled")
        logger.info("Xendit invoice expired: %s booking=%s", xendit_invoice_id, booking_id)

    else:
        logger.debug("Xendit invoice status %s for %s", invoice_status, xendit_invoice_id)
