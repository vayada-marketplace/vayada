import asyncio
import logging
from datetime import datetime, timezone

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger
from apscheduler.triggers.cron import CronTrigger

from app.repositories.booking_repo import BookingRepository
from app.repositories.payout_repo import PayoutRepository
from app.repositories.hotel_payment_settings_repo import HotelPaymentSettingsRepository
from app.services import stripe_service

logger = logging.getLogger(__name__)

scheduler = AsyncIOScheduler()


async def expire_pending_bookings():
    """Find and expire bookings where host hasn't responded in time."""
    from app.services.booking_service import expire_booking

    now = datetime.now(timezone.utc)
    expired = await BookingRepository.list_expired_pending(now)
    for row in expired:
        booking_id = str(row["id"])
        try:
            await expire_booking(booking_id)
            logger.info("Expired booking: %s", booking_id)
        except Exception as e:
            logger.error("Failed to expire booking %s: %s", booking_id, e)


async def process_property_payouts():
    """Process due hotel payouts via Stripe Connect transfers."""
    now = datetime.now(timezone.utc)
    due = await PayoutRepository.list_due_payouts(now)

    for payout in due:
        if payout["recipient_type"] != "hotel":
            continue

        payout_id = str(payout["id"])
        hotel_id = str(payout["recipient_id"])

        try:
            settings = await HotelPaymentSettingsRepository.get_by_hotel_id(hotel_id)
            if not settings or not settings.get("stripe_connect_account_id"):
                logger.warning("No Stripe Connect account for hotel %s, skipping payout %s", hotel_id, payout_id)
                continue

            await PayoutRepository.update_status(payout_id, "processing")

            amount_cents = int(float(payout["amount"]) * 100)
            result = await stripe_service.create_transfer(
                amount=amount_cents,
                currency=payout["currency"],
                destination_account=settings["stripe_connect_account_id"],
                metadata={
                    "payout_id": payout_id,
                    "booking_id": str(payout["booking_id"]),
                },
            )

            await PayoutRepository.update_status(
                payout_id, "completed", stripe_transfer_id=result["id"]
            )
            logger.info("Completed hotel payout %s, transfer %s", payout_id, result["id"])

        except Exception as e:
            logger.error("Failed to process payout %s: %s", payout_id, e)
            await PayoutRepository.update_status(payout_id, "failed")


async def process_affiliate_payouts():
    """Monthly batch: process affiliate payouts for confirmed bookings after checkout."""
    now = datetime.now(timezone.utc)
    # Process previous month
    if now.month == 1:
        month, year = 12, now.year - 1
    else:
        month, year = now.month - 1, now.year

    payouts = await PayoutRepository.list_monthly_affiliate_payouts(month, year)
    for payout in payouts:
        payout_id = str(payout["id"])
        try:
            await PayoutRepository.update_status(payout_id, "completed")
            logger.info("Completed affiliate payout %s", payout_id)
        except Exception as e:
            logger.error("Failed to process affiliate payout %s: %s", payout_id, e)


def setup_scheduler():
    """Configure and return the scheduler with all jobs."""
    scheduler.add_job(
        expire_pending_bookings,
        trigger=IntervalTrigger(minutes=1),
        id="expire_pending_bookings",
        replace_existing=True,
    )

    scheduler.add_job(
        process_property_payouts,
        trigger=IntervalTrigger(hours=1),
        id="process_property_payouts",
        replace_existing=True,
    )

    scheduler.add_job(
        process_affiliate_payouts,
        trigger=CronTrigger(day=1, hour=2, minute=0),
        id="process_affiliate_payouts",
        replace_existing=True,
    )

    return scheduler
