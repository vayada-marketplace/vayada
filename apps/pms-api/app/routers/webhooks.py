import hmac
import logging

from fastapi import APIRouter, HTTPException, Request

from app.config import settings
from app.repositories.affiliate_repo import AffiliateRepository
from app.repositories.booking_draft_repo import BookingDraftRepository
from app.repositories.booking_repo import BookingRepository
from app.repositories.channex_webhook_event_repo import ChannexWebhookEventRepository
from app.repositories.hotel_payment_settings_repo import HotelPaymentSettingsRepository
from app.repositories.payment_repo import PaymentRepository
from app.repositories.payout_repo import PayoutRepository
from app.services import stripe_service

logger = logging.getLogger(__name__)

router = APIRouter(tags=["webhooks"])


async def _materialize_or_get_booking_for_pi(pi_id: str, payment_status: str) -> dict | None:
    """Resolve the booking that a Stripe webhook pertains to.

    With VAY-388 the booking row may not exist yet at the time the first
    Stripe event arrives — the create-booking flow leaves a soft-hold
    draft instead. This helper materializes that draft (idempotently)
    if one exists, otherwise falls back to looking up by an existing
    payment row. Returns None when neither path resolves to a booking.
    """
    draft = await BookingDraftRepository.get_by_payment_intent(pi_id)
    if draft:
        from app.services.booking_service import materialize_draft

        booking = await materialize_draft(draft, payment_status=payment_status)
        if booking:
            return booking
        # Lost the race to confirm-authorization — fall through and look
        # up the booking that the other caller just created.

    payment = await PaymentRepository.get_by_stripe_pi(pi_id)
    if payment:
        return await BookingRepository.get_by_id(str(payment["booking_id"]))
    return None


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
        # Payment authorized (hold placed) — request flow.
        pi_id = data["id"]
        booking = await _materialize_or_get_booking_for_pi(pi_id, "authorized")
        if booking is None:
            logger.warning("PI auth webhook with no draft or payment row: %s", pi_id)
        else:
            payment = await PaymentRepository.get_by_stripe_pi(pi_id)
            if payment and payment["status"] != "authorized":
                await PaymentRepository.update_status(str(payment["id"]), "authorized")
            await BookingRepository.update_payment_status(str(booking["id"]), "authorized")
            logger.info("Payment authorized via webhook: %s", pi_id)

    elif event_type == "payment_intent.succeeded":
        # Payment captured — instant-book path (also fires on manual
        # capture later, in which case the booking already exists).
        pi_id = data["id"]
        booking = await _materialize_or_get_booking_for_pi(pi_id, "captured")
        payment = await PaymentRepository.get_by_stripe_pi(pi_id)

        if booking and payment:
            card = (
                data.get("charges", {})
                .get("data", [{}])[0]
                .get("payment_method_details", {})
                .get("card", {})
            )
            if payment["status"] != "captured":
                await PaymentRepository.update_status(
                    str(payment["id"]),
                    "captured",
                    card_last_four=card.get("last4"),
                    card_brand=card.get("brand"),
                )
            logger.info("Payment captured via webhook: %s", pi_id)

            booking_id = str(booking["id"])

            # Instant-book hotels capture automatically — when Stripe confirms
            # the charge the booking should jump straight to confirmed without
            # waiting for a host accept. capture_card=False because Stripe
            # already captured.
            if booking["status"] == "pending":
                from app.database import Database

                hotel_row = await Database.fetchrow(
                    "SELECT instant_book FROM hotels WHERE id = $1",
                    booking["hotel_id"],
                )
                if hotel_row and hotel_row.get("instant_book"):
                    from app.services.booking_service import _finalize_accepted_booking

                    try:
                        await _finalize_accepted_booking(booking_id, capture_card=False)
                    except Exception as e:
                        logger.error("Instant-book finalize failed for %s: %s", booking_id, e)

            # Send payment confirmation email to guest
            if booking.get("guest_email"):
                import asyncio

                from app.services.email_service import send_guest_payment_confirmed

                asyncio.create_task(
                    send_guest_payment_confirmed(
                        booking["guest_email"],
                        booking,
                        float(payment["amount"]),
                        "card",
                    )
                )
        else:
            logger.warning("PI succeeded webhook with no draft or payment row: %s", pi_id)

    elif event_type == "payment_intent.canceled":
        pi_id = data["id"]
        # Drop any pending soft hold so inventory frees up immediately.
        await BookingDraftRepository.delete_by_payment_intent(pi_id)
        payment = await PaymentRepository.get_by_stripe_pi(pi_id)
        if payment:
            await PaymentRepository.update_status(str(payment["id"]), "cancelled")
            logger.info("Payment cancelled via webhook: %s", pi_id)

    elif event_type == "payment_intent.payment_failed":
        pi_id = data["id"]
        # No booking row exists for a failed card draft — drop the soft
        # hold and we're done. Existing bookings (manual-capture failures
        # post-authorization) still flow through the legacy path.
        if await BookingDraftRepository.delete_by_payment_intent(pi_id):
            logger.info("Draft soft hold released after PI failure: %s", pi_id)
        payment = await PaymentRepository.get_by_stripe_pi(pi_id)
        if payment:
            await PaymentRepository.update_status(str(payment["id"]), "failed")
            await BookingRepository.update_payment_status(str(payment["booking_id"]), "failed")
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
        from app.repositories.affiliate_repo import AffiliateRepository
        from app.services.email_service import send_affiliate_payout_notification

        row = await Database.fetchrow(
            "SELECT id, recipient_type, recipient_id, amount, currency FROM payouts WHERE xendit_payout_id = $1",
            xendit_payout_id,
        )
        if row:
            await PayoutRepository.update_status(
                str(row["id"]), "completed", xendit_payout_id=xendit_payout_id
            )
            logger.info("Xendit payout completed: %s", xendit_payout_id)

            if row["recipient_type"] == "affiliate":
                affiliate = await AffiliateRepository.get_by_id(str(row["recipient_id"]))
                if affiliate:
                    await send_affiliate_payout_notification(
                        affiliate_email=affiliate["email"],
                        affiliate_name=affiliate["full_name"],
                        payout_amount=float(row["amount"]),
                        currency=row["currency"],
                        payout_method="xendit",
                    )

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
        # Guest has paid — mark payment as captured.
        await PaymentRepository.update_status(payment_id, "captured")
        await BookingRepository.update_payment_status(booking_id, "authorized")

        booking = await BookingRepository.get_by_id(booking_id)
        if booking:
            from app.database import Database

            hotel = await Database.fetchrow(
                "SELECT contact_email, instant_book FROM hotels WHERE id = $1",
                booking["hotel_id"],
            )
            if hotel and hotel.get("instant_book") and booking["status"] == "pending":
                # Skip the request flow; finalize and email guest+host as accepted.
                from app.services.booking_service import _finalize_accepted_booking

                try:
                    await _finalize_accepted_booking(booking_id, capture_card=False)
                except Exception as e:
                    logger.error("Instant-book finalize failed for %s: %s", booking_id, e)
            elif hotel:
                # Request flow — notify host to accept/reject
                from app.services.email_service import send_booking_request_notification

                asyncio.create_task(
                    send_booking_request_notification(hotel["contact_email"], booking)
                )

        # Send payment confirmation email to guest
        if booking and booking.get("guest_email"):
            from app.services.email_service import send_guest_payment_confirmed

            xendit_label = (
                f"{payment_method}/{payment_channel}"
                if payment_channel
                else (payment_method or "xendit")
            )
            asyncio.create_task(
                send_guest_payment_confirmed(
                    booking["guest_email"],
                    booking,
                    float(payment["amount"]),
                    xendit_label,
                )
            )

        logger.info(
            "Xendit invoice paid: %s method=%s channel=%s booking=%s",
            xendit_invoice_id,
            payment_method,
            payment_channel,
            booking_id,
        )

    elif invoice_status == "EXPIRED":
        await PaymentRepository.update_status(payment_id, "cancelled")
        await BookingRepository.update_payment_status(booking_id, "cancelled")
        await BookingRepository.update_status(booking_id, "cancelled")
        logger.info("Xendit invoice expired: %s booking=%s", xendit_invoice_id, booking_id)

    else:
        logger.debug("Xendit invoice status %s for %s", invoice_status, xendit_invoice_id)


@router.post("/webhooks/channex")
async def channex_webhook(request: Request):
    """Handle Channex webhook events. Channex doesn't sign webhooks natively —
    we register the webhook with a custom X-Vayada-Webhook-Token header set to
    settings.CHANNEX_WEBHOOK_SECRET, and verify it here.

    Phase 1 only handles the `message` event; other events are logged but not
    processed yet (see /admin/channex/webhook-events/summary)."""
    if not settings.CHANNEX_WEBHOOK_SECRET:
        logger.error("Channex webhook hit but CHANNEX_WEBHOOK_SECRET not configured")
        raise HTTPException(status_code=503, detail="Webhook not configured")

    token = request.headers.get("x-vayada-webhook-token", "")
    if not hmac.compare_digest(token, settings.CHANNEX_WEBHOOK_SECRET):
        logger.warning("Channex webhook auth failed (token mismatch)")
        raise HTTPException(status_code=401, detail="Invalid webhook token")

    import json

    payload = await request.body()
    try:
        event = json.loads(payload)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    event_type = event.get("event") or "unknown"
    event_payload = event.get("payload") or {}
    property_id = event.get("property_id") or event_payload.get("property_id")

    # Always log the receipt — gives us "did the message webhook fire today?"
    # observability now that the safety-net poll is gone.
    try:
        event_id = await ChannexWebhookEventRepository.insert(
            event_type=event_type,
            property_id=str(property_id) if property_id else None,
            payload=event,
        )
    except Exception as e:
        # Never let logging failure break webhook ingest — Channel retries
        # cause cascading volume.
        logger.exception("Failed to log Channex webhook event: %s", e)
        event_id = None

    if event_type == "message":
        from app.services.channex.messaging import process_inbound_message_event

        ok, err = True, None
        try:
            await process_inbound_message_event(event_payload, event)
        except Exception as e:
            logger.exception("Failed to process Channex message event: %s", e)
            ok, err = False, str(e)[:500]
        if event_id:
            try:
                await ChannexWebhookEventRepository.mark_processed(event_id, ok, err)
            except Exception:
                logger.exception("Failed to mark Channex webhook event processed")
        # Still 200 even on failure — Channex retries indefinitely otherwise.
        return {"status": "ok" if ok else "error_logged"}

    logger.debug("Ignoring Channex webhook event=%r", event_type)
    return {"status": "ignored", "event": event_type}
