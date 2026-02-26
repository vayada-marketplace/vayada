import logging
from typing import Optional

import xendit
from xendit.apis import PayoutApi

from app.config import settings

logger = logging.getLogger(__name__)

configuration = xendit.Configuration()
configuration.api_key = {"ApiKeyAuth": settings.XENDIT_SECRET_KEY}
xendit_client = xendit.ApiClient(configuration)
payout_api = PayoutApi(xendit_client)


async def create_payout(
    reference_id: str,
    channel_code: str,
    account_number: str,
    account_holder_name: str,
    amount: int,
    currency: str = "IDR",
    description: str = "",
) -> dict:
    """Create a Xendit payout (disbursement) to a bank account."""
    payout = payout_api.create_payout(
        idempotency_key=reference_id,
        digital_payout_channel_properties={
            "account_holder_name": account_holder_name,
            "account_number": account_number,
            "account_type": "BANK_ACCOUNT",
        },
        amount=amount,
        channel_code=channel_code,
        currency=currency,
        reference_id=reference_id,
        description=description,
    )
    return {
        "id": payout.id,
        "reference_id": payout.reference_id,
        "status": payout.status,
        "amount": payout.amount,
    }


async def get_payout(payout_id: str) -> dict:
    """Get payout status from Xendit."""
    payout = payout_api.get_payout_by_id(id=payout_id)
    return {
        "id": payout.id,
        "reference_id": payout.reference_id,
        "status": payout.status,
        "amount": payout.amount,
    }
