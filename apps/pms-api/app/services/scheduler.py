import asyncio
import logging
from datetime import datetime, timezone

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger
from apscheduler.triggers.cron import CronTrigger

from app.repositories.booking_repo import BookingRepository
from app.repositories.payout_repo import PayoutRepository
from app.repositories.hotel_payment_settings_repo import HotelPaymentSettingsRepository
from app.repositories.affiliate_repo import AffiliateRepository
from app.services import stripe_service
from app.services import xendit_service

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
            if not settings:
                logger.warning("No payment settings for hotel %s, skipping payout %s", hotel_id, payout_id)
                continue

            provider = settings.get("payment_provider", "stripe")
            await PayoutRepository.update_status(payout_id, "processing")

            if provider == "xendit":
                if not settings.get("xendit_account_number"):
                    logger.warning("No Xendit bank details for hotel %s, skipping payout %s", hotel_id, payout_id)
                    await PayoutRepository.update_status(payout_id, "scheduled")
                    continue

                amount = int(float(payout["amount"]))
                result = await xendit_service.create_payout(
                    reference_id=f"hotel-{payout_id}",
                    channel_code=settings["xendit_channel_code"],
                    account_number=settings["xendit_account_number"],
                    account_holder_name=settings["xendit_account_holder_name"],
                    amount=amount,
                    currency=payout["currency"],
                    description=f"Hotel payout for booking {payout.get('booking_reference', '')}",
                )

                await PayoutRepository.update_status(
                    payout_id, "completed", xendit_payout_id=result["id"]
                )
                logger.info("Completed hotel payout %s via Xendit, payout %s", payout_id, result["id"])
            else:
                if not settings.get("stripe_connect_account_id"):
                    logger.warning("No Stripe Connect account for hotel %s, skipping payout %s", hotel_id, payout_id)
                    await PayoutRepository.update_status(payout_id, "scheduled")
                    continue

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
                logger.info("Completed hotel payout %s via Stripe, transfer %s", payout_id, result["id"])

        except Exception as e:
            logger.error("Failed to process payout %s: %s", payout_id, e)
            await PayoutRepository.update_status(payout_id, "failed")


async def process_affiliate_payouts():
    """Monthly batch: process affiliate payouts via Stripe Connect transfers."""
    now = datetime.now(timezone.utc)
    # Process previous month
    if now.month == 1:
        month, year = 12, now.year - 1
    else:
        month, year = now.month - 1, now.year

    payouts = await PayoutRepository.list_monthly_affiliate_payouts(month, year)
    for payout in payouts:
        payout_id = str(payout["id"])
        affiliate_id = str(payout["recipient_id"])

        try:
            affiliate = await AffiliateRepository.get_by_id(affiliate_id)
            if not affiliate:
                logger.warning("Affiliate %s not found, skipping payout %s", affiliate_id, payout_id)
                continue

            payment_method = affiliate.get("payment_method")

            if payment_method == "xendit":
                if not affiliate.get("xendit_account_number"):
                    logger.info("Affiliate %s missing Xendit bank details, skipping payout %s", affiliate_id, payout_id)
                    continue

                await PayoutRepository.update_status(payout_id, "processing")

                amount = int(float(payout["amount"]))
                result = await xendit_service.create_payout(
                    reference_id=f"affiliate-{payout_id}",
                    channel_code=affiliate["xendit_channel_code"],
                    account_number=affiliate["xendit_account_number"],
                    account_holder_name=affiliate["xendit_account_holder_name"],
                    amount=amount,
                    currency=payout["currency"],
                    description=f"Affiliate payout for booking {payout.get('booking_reference', '')}",
                )

                await PayoutRepository.update_status(
                    payout_id, "completed", xendit_payout_id=result["id"]
                )
                logger.info("Completed affiliate payout %s via Xendit, payout %s", payout_id, result["id"])

            elif payment_method == "stripe":
                if not affiliate.get("stripe_connect_account_id") or not affiliate.get("stripe_connect_onboarded"):
                    logger.info("Affiliate %s not Stripe-onboarded, skipping payout %s for manual handling", affiliate_id, payout_id)
                    continue

                await PayoutRepository.update_status(payout_id, "processing")

                amount_cents = int(float(payout["amount"]) * 100)
                result = await stripe_service.create_transfer(
                    amount=amount_cents,
                    currency=payout["currency"],
                    destination_account=affiliate["stripe_connect_account_id"],
                    metadata={
                        "payout_id": payout_id,
                        "booking_id": str(payout["booking_id"]),
                        "affiliate_id": affiliate_id,
                    },
                )

                await PayoutRepository.update_status(
                    payout_id, "completed", stripe_transfer_id=result["id"]
                )
                logger.info("Completed affiliate payout %s via Stripe, transfer %s", payout_id, result["id"])

            else:
                # paypal / bank — skip for manual handling
                logger.info("Affiliate %s uses %s, skipping payout %s for manual handling", affiliate_id, payment_method, payout_id)
                continue

        except Exception as e:
            logger.error("Failed to process affiliate payout %s: %s", payout_id, e)
            await PayoutRepository.update_status(payout_id, "failed")


async def cancel_stale_unpaid_bookings():
    """Cancel pending bookings where payment was never completed (30+ min old)."""
    from app.database import Database

    result = await Database.fetch(
        """
        UPDATE bookings
        SET status = 'cancelled'
        WHERE status = 'pending'
          AND payment_status = 'unpaid'
          AND payment_method = 'card'
          AND created_at < NOW() - INTERVAL '30 minutes'
        RETURNING id
        """
    )
    for row in result:
        logger.info("Cancelled stale unpaid booking: %s", row["id"])


async def poll_beds24_bookings():
    """Poll all active Beds24 connections for new/modified bookings."""
    from app.repositories.beds24_mapping_repo import Beds24ConnectionRepository
    from app.services.beds24_sync_service import poll_bookings_for_hotel

    connections = await Beds24ConnectionRepository.list_active()
    for conn in connections:
        hotel_id = str(conn["hotel_id"])
        try:
            await poll_bookings_for_hotel(hotel_id)
        except Exception as e:
            logger.error("Failed to poll Beds24 bookings for hotel %s: %s", hotel_id, e)


async def full_beds24_availability_sync():
    """Daily full availability push to Beds24 for all active connections."""
    from app.repositories.beds24_mapping_repo import Beds24ConnectionRepository
    from app.services.beds24_sync_service import push_availability_for_hotel

    connections = await Beds24ConnectionRepository.list_active()
    for conn in connections:
        hotel_id = str(conn["hotel_id"])
        try:
            await push_availability_for_hotel(hotel_id)
        except Exception as e:
            logger.error("Failed to sync Beds24 availability for hotel %s: %s", hotel_id, e)


def setup_scheduler():
    """Configure and return the scheduler with all jobs."""
    from app.config import settings as app_settings

    scheduler.add_job(
        expire_pending_bookings,
        trigger=IntervalTrigger(minutes=1),
        id="expire_pending_bookings",
        replace_existing=True,
    )

    scheduler.add_job(
        cancel_stale_unpaid_bookings,
        trigger=IntervalTrigger(minutes=10),
        id="cancel_stale_unpaid_bookings",
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

    scheduler.add_job(
        poll_beds24_bookings,
        trigger=IntervalTrigger(minutes=app_settings.BEDS24_POLL_INTERVAL_MINUTES),
        id="poll_beds24_bookings",
        replace_existing=True,
    )

    scheduler.add_job(
        full_beds24_availability_sync,
        trigger=CronTrigger(hour=app_settings.BEDS24_FULL_SYNC_HOUR, minute=0),
        id="full_beds24_availability_sync",
        replace_existing=True,
    )

    return scheduler
