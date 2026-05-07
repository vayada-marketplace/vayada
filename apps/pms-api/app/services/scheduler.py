import asyncio
import logging
from datetime import datetime, timezone

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger
from apscheduler.triggers.cron import CronTrigger

from app.config import settings as app_settings
from app.database import Database
from app.repositories.booking_repo import BookingRepository
from app.repositories.booking_draft_repo import BookingDraftRepository
from app.repositories.payout_repo import PayoutRepository
from app.repositories.hotel_payment_settings_repo import HotelPaymentSettingsRepository
from app.repositories.affiliate_repo import AffiliateRepository
from app.repositories.channex_mapping_repo import ChannexConnectionRepository
from app.services import xendit_service
from app.services.booking_service import expire_booking
from app.services.email_service import send_affiliate_payout_notification
from app.services.payout_service import (
    dispatch_stripe_transfer,
    dispatch_xendit_payout,
    handle_payout_failure,
)
from app.services.xendit_service import XenditError
from app.services.channex.inbound import poll_bookings_for_hotel
from app.services.channex.messaging import poll_messages_for_all_hotels
from app.services.channex.orchestrator import push_ari_for_hotel

logger = logging.getLogger(__name__)

scheduler = AsyncIOScheduler()


async def expire_pending_bookings():
    """Find and expire bookings where host hasn't responded in time."""
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
    """Process due hotel payouts via Stripe Connect transfers / Xendit."""
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
            if provider == "vayada":
                # vayada Payment: payouts are handled manually — skip auto-processing
                logger.info("Skipping auto-payout %s for hotel %s (vayada provider, manual payout)", payout_id, hotel_id)
                continue

            await PayoutRepository.update_status(payout_id, "processing")

            if provider == "xendit":
                if not settings.get("xendit_account_number"):
                    logger.warning("No Xendit bank details for hotel %s, skipping payout %s", hotel_id, payout_id)
                    await PayoutRepository.update_status(payout_id, "scheduled")
                    continue
                xendit_id = await dispatch_xendit_payout(
                    payout_id,
                    float(payout["amount"]),
                    payout["currency"],
                    reference_id=f"hotel-{payout_id}",
                    channel_code=settings["xendit_channel_code"],
                    account_number=settings["xendit_account_number"],
                    account_holder_name=settings["xendit_account_holder_name"],
                    description=f"Hotel payout for booking {payout.get('booking_reference', '')}",
                )
                logger.info("Submitted hotel payout %s to Xendit, xendit_id=%s", payout_id, xendit_id)
            else:
                if not settings.get("stripe_connect_account_id"):
                    logger.warning("No Stripe Connect account for hotel %s, skipping payout %s", hotel_id, payout_id)
                    await PayoutRepository.update_status(payout_id, "scheduled")
                    continue
                transfer_id = await dispatch_stripe_transfer(
                    payout_id,
                    float(payout["amount"]),
                    payout["currency"],
                    destination_account=settings["stripe_connect_account_id"],
                    metadata={
                        "payout_id": payout_id,
                        "booking_id": str(payout["booking_id"]),
                    },
                )
                logger.info("Completed hotel payout %s via Stripe, transfer %s", payout_id, transfer_id)

        except Exception as e:
            logger.error("Failed to process payout %s: %s", payout_id, e)
            await handle_payout_failure(
                payout_id, payout.get("retry_count", 0) or 0, e, label="Payout"
            )


async def process_affiliate_payouts():
    """Monthly batch: process affiliate payouts via Stripe Connect / Xendit."""
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
                xendit_id = await dispatch_xendit_payout(
                    payout_id,
                    float(payout["amount"]),
                    payout["currency"],
                    reference_id=f"affiliate-{payout_id}",
                    channel_code=affiliate["xendit_channel_code"],
                    account_number=affiliate["xendit_account_number"],
                    account_holder_name=affiliate["xendit_account_holder_name"],
                    description=f"Affiliate payout for booking {payout.get('booking_reference', '')}",
                )
                logger.info("Submitted affiliate payout %s to Xendit, xendit_id=%s", payout_id, xendit_id)

            elif payment_method == "stripe":
                if not affiliate.get("stripe_connect_account_id") or not affiliate.get("stripe_connect_onboarded"):
                    logger.info("Affiliate %s not Stripe-onboarded, skipping payout %s for manual handling", affiliate_id, payout_id)
                    continue
                await PayoutRepository.update_status(payout_id, "processing")
                transfer_id = await dispatch_stripe_transfer(
                    payout_id,
                    float(payout["amount"]),
                    payout["currency"],
                    destination_account=affiliate["stripe_connect_account_id"],
                    metadata={
                        "payout_id": payout_id,
                        "booking_id": str(payout["booking_id"]),
                        "affiliate_id": affiliate_id,
                    },
                )
                logger.info("Completed affiliate payout %s via Stripe, transfer %s", payout_id, transfer_id)
                await send_affiliate_payout_notification(
                    affiliate_email=affiliate["email"],
                    affiliate_name=affiliate["full_name"],
                    payout_amount=float(payout["amount"]),
                    currency=payout["currency"],
                    payout_method="stripe",
                )

            else:
                # paypal / bank — skip for manual handling
                logger.info("Affiliate %s uses %s, skipping payout %s for manual handling", affiliate_id, payment_method, payout_id)
                continue

        except Exception as e:
            logger.error("Failed to process affiliate payout %s: %s", payout_id, e)
            await handle_payout_failure(
                payout_id, payout.get("retry_count", 0) or 0, e, label="Affiliate payout"
            )


async def poll_xendit_processing_payouts():
    """Poll Xendit for payouts stuck in 'processing' in case webhooks failed."""
    stale = await PayoutRepository.list_processing_xendit(older_than_minutes=30)
    for payout in stale:
        payout_id = str(payout["id"])
        xendit_id = payout["xendit_payout_id"]
        try:
            result = await xendit_service.get_payout(xendit_id)
            xendit_status = result["status"]

            if xendit_status == "SUCCEEDED":
                await PayoutRepository.update_status(payout_id, "completed", xendit_payout_id=xendit_id)
                logger.info("Xendit poll: payout %s completed (xendit %s)", payout_id, xendit_id)

                if payout.get("recipient_type") == "affiliate":
                    affiliate = await AffiliateRepository.get_by_id(str(payout["recipient_id"]))
                    if affiliate:
                        await send_affiliate_payout_notification(
                            affiliate_email=affiliate["email"],
                            affiliate_name=affiliate["full_name"],
                            payout_amount=float(payout["amount"]),
                            currency=payout["currency"],
                            payout_method="xendit",
                        )
            elif xendit_status in ("FAILED", "REVERSED"):
                await PayoutRepository.update_status(payout_id, "failed")
                logger.warning("Xendit poll: payout %s failed (xendit %s, status=%s)", payout_id, xendit_id, xendit_status)
            else:
                logger.debug("Xendit poll: payout %s still %s", payout_id, xendit_status)
        except XenditError as e:
            logger.error("Xendit poll error for payout %s: %s", payout_id, e)
        except Exception as e:
            logger.error("Unexpected error polling Xendit payout %s: %s", payout_id, e)


async def cleanup_expired_drafts():
    """Sweep abandoned booking drafts (VAY-388) once their soft hold has
    been expired for an hour. Lazy filtering in count_active_for_stay
    already prevents stale rows from blocking inventory; this just keeps
    the table from growing forever."""
    deleted = await BookingDraftRepository.delete_expired(grace_minutes=60)
    if deleted:
        logger.info("Cleaned up %d expired booking draft(s)", deleted)


async def cancel_stale_unpaid_bookings():
    """Cancel pending bookings where payment was never completed (30+ min old)."""
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


async def poll_channex_bookings():
    """Poll all active Channex connections for new booking revisions."""
    connections = await ChannexConnectionRepository.list_active()
    for conn in connections:
        hotel_id = str(conn["hotel_id"])
        try:
            await poll_bookings_for_hotel(hotel_id)
        except Exception as e:
            logger.error("Failed to poll Channex bookings for hotel %s: %s", hotel_id, e)


async def full_channex_ari_sync():
    """Daily full availability + rates push to Channex for all active connections."""
    connections = await ChannexConnectionRepository.list_active()
    for conn in connections:
        hotel_id = str(conn["hotel_id"])
        try:
            await push_ari_for_hotel(hotel_id)
        except Exception as e:
            logger.error("Failed to sync Channex ARI for hotel %s: %s", hotel_id, e)


async def poll_channex_messages():
    """Manual reconciliation sweep — no longer scheduled. Channex requested we
    stop polling their `BookingMessages` list/feed; we rely on the `message`
    webhook instead. This function remains available for on-demand admin
    recovery if a webhook is suspected to have been missed."""
    try:
        await poll_messages_for_all_hotels()
    except Exception as e:
        logger.error("Channex message sweep failed: %s", e)


def setup_scheduler():
    """Configure and return the scheduler with all jobs."""
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
        cleanup_expired_drafts,
        trigger=IntervalTrigger(minutes=10),
        id="cleanup_expired_drafts",
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
        poll_xendit_processing_payouts,
        trigger=IntervalTrigger(minutes=30),
        id="poll_xendit_processing_payouts",
        replace_existing=True,
    )

    # ── Channex jobs ─────────────────────────────────────────────────
    scheduler.add_job(
        poll_channex_bookings,
        trigger=IntervalTrigger(minutes=app_settings.CHANNEX_POLL_INTERVAL_MINUTES),
        id="poll_channex_bookings",
        replace_existing=True,
    )

    scheduler.add_job(
        full_channex_ari_sync,
        trigger=CronTrigger(hour=app_settings.CHANNEX_FULL_SYNC_HOUR, minute=0),
        id="full_channex_ari_sync",
        replace_existing=True,
    )

    # Channex message polling is disabled — Channex flagged the volume; we now
    # rely on the `message` webhook (handled in routers/webhooks.py). The
    # `poll_channex_messages` function is kept for manual recovery.

    return scheduler
