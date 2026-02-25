import logging

from fastapi import APIRouter, HTTPException, Request

from app.services import stripe_service
from app.repositories.payment_repo import PaymentRepository
from app.repositories.booking_repo import BookingRepository
from app.repositories.hotel_payment_settings_repo import HotelPaymentSettingsRepository

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
                logger.info("Stripe Connect account onboarded: %s", account_id)

    return {"status": "ok"}
