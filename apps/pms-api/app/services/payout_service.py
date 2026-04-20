import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from app.config import settings as app_settings
from app.database import BookingEngineDatabase
from app.repositories.payout_repo import PayoutRepository
from app.repositories.cancellation_policy_repo import CancellationPolicyRepository

logger = logging.getLogger(__name__)


# Defaults match the pricing PDF and are used when a hotel row predates the
# pricing_config migration (or in tests where booking_db is not connected).
DEFAULT_BILLING_CONFIG = {
    "active_plan": "commission",
    "booking_engine_fee_pct": 2.00,
    "channel_manager_fee_pct": 3.00,
    "affiliate_platform_fee_pct": 2.00,
}


async def fetch_billing_config(hotel_id: str) -> dict:
    """Read per-hotel platform-fee config from booking_db, falling back to defaults.

    Applies a pending plan switch inline if its effective date has passed — so
    bookings on/after the 1st of the month see the new plan even if nothing
    else has touched this hotel's row yet.
    """
    if not app_settings.BOOKING_ENGINE_DATABASE_URL:
        return dict(DEFAULT_BILLING_CONFIG)
    try:
        row = await BookingEngineDatabase.fetchrow(
            """
            WITH flipped AS (
                UPDATE booking_hotels
                   SET billing_active_plan = billing_pending_switch,
                       billing_pending_switch = NULL,
                       billing_switch_effective_date = NULL
                 WHERE id = $1
                   AND billing_pending_switch IS NOT NULL
                   AND billing_switch_effective_date IS NOT NULL
                   AND billing_switch_effective_date <= CURRENT_DATE
                RETURNING id
            )
            SELECT billing_active_plan,
                   booking_engine_fee_pct,
                   channel_manager_fee_pct,
                   affiliate_platform_fee_pct
              FROM booking_hotels
             WHERE id = $1
            """,
            hotel_id,
        )
    except Exception as exc:
        logger.warning("Failed to fetch billing config from booking_db: %s", exc)
        return dict(DEFAULT_BILLING_CONFIG)
    if not row:
        return dict(DEFAULT_BILLING_CONFIG)
    return {
        "active_plan": row["billing_active_plan"],
        "booking_engine_fee_pct": float(row["booking_engine_fee_pct"]),
        "channel_manager_fee_pct": float(row["channel_manager_fee_pct"]),
        "affiliate_platform_fee_pct": float(row["affiliate_platform_fee_pct"]),
    }


def calculate_split(
    total_amount: float,
    *,
    plan: str,
    channel: str,
    booking_engine_fee_pct: float,
    channel_manager_fee_pct: float,
    affiliate_platform_fee_pct: float,
    has_affiliate: bool,
    effective_affiliate_commission_pct: float = 0.0,
) -> dict:
    """Split a booking total into platform fee, affiliate commission, and property payout.

    Fee matrix:
      Fixed plan:      0% on non-affiliate bookings (covered by monthly base + per-room).
                       +affiliate_platform_fee_pct on affiliate bookings.
      Commission plan: booking_engine_fee_pct on direct bookings,
                       channel_manager_fee_pct on OTA bookings.
                       Affiliate bookings do NOT add the affiliate platform fee — the
                       channel fee (direct or OTA) already covers the platform cut.
      Affiliate commission is additive — paid by the property on top of the platform fee.
    """
    is_channel_booking = channel != "direct"

    platform_fee_pct = 0.0
    if plan == "commission":
        platform_fee_pct += (
            channel_manager_fee_pct if is_channel_booking else booking_engine_fee_pct
        )
    elif has_affiliate:
        platform_fee_pct += affiliate_platform_fee_pct

    platform_fee = round(total_amount * platform_fee_pct / 100, 2)
    affiliate_commission = (
        round(total_amount * effective_affiliate_commission_pct / 100, 2)
        if has_affiliate
        else 0.0
    )
    property_payout = round(total_amount - platform_fee - affiliate_commission, 2)

    return {
        "platform_fee": platform_fee,
        "affiliate_commission": affiliate_commission,
        "property_payout": property_payout,
    }


async def schedule_payouts(
    booking_id: str,
    hotel_id: str,
    total_amount: float,
    currency: str,
    affiliate_id: Optional[str],
    affiliate_commission: float,
    property_payout: float,
    check_out,
) -> None:
    """Schedule hotel payout (after cancellation window) and affiliate payout (monthly batch)."""
    policy = await CancellationPolicyRepository.get_by_hotel_id(hotel_id)
    free_days = policy["free_cancellation_days"] if policy else 7

    hotel_payout_date = datetime.combine(
        check_out, datetime.min.time(), tzinfo=timezone.utc
    ) + timedelta(days=free_days)

    await PayoutRepository.create(
        booking_id=booking_id,
        recipient_type="hotel",
        recipient_id=hotel_id,
        amount=property_payout,
        currency=currency,
        scheduled_for=hotel_payout_date,
    )

    if affiliate_id and affiliate_commission > 0:
        checkout_dt = datetime.combine(
            check_out, datetime.min.time(), tzinfo=timezone.utc
        )
        if checkout_dt.month == 12:
            batch_date = checkout_dt.replace(year=checkout_dt.year + 1, month=1, day=1)
        else:
            batch_date = checkout_dt.replace(month=checkout_dt.month + 1, day=1)

        await PayoutRepository.create(
            booking_id=booking_id,
            recipient_type="affiliate",
            recipient_id=affiliate_id,
            amount=affiliate_commission,
            currency=currency,
            scheduled_for=batch_date,
        )
