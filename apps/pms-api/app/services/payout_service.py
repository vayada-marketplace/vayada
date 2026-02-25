import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from app.database import Database
from app.repositories.payout_repo import PayoutRepository
from app.repositories.hotel_payment_settings_repo import HotelPaymentSettingsRepository
from app.repositories.cancellation_policy_repo import CancellationPolicyRepository

logger = logging.getLogger(__name__)


def calculate_split(
    total_amount: float,
    fee_type: str,
    fee_value: float,
    fee_with_affiliate: float,
    has_affiliate: bool,
    affiliate_commission_pct: float = 0.0,
) -> dict:
    """Calculate platform fee, affiliate commission, and property payout."""
    if has_affiliate:
        if fee_type == "flat":
            platform_fee = fee_with_affiliate
        else:
            platform_fee = round(total_amount * fee_with_affiliate / 100, 2)
        affiliate_commission = round(total_amount * affiliate_commission_pct / 100, 2)
    else:
        if fee_type == "flat":
            platform_fee = fee_value
        else:
            platform_fee = round(total_amount * fee_value / 100, 2)
        affiliate_commission = 0.0

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
    # Get cancellation policy to determine payout delay
    policy = await CancellationPolicyRepository.get_by_hotel_id(hotel_id)
    free_days = policy["free_cancellation_days"] if policy else 7

    # Hotel payout: schedule for check-out + cancellation window days
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

    # Affiliate payout: schedule for 1st of month after checkout
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
