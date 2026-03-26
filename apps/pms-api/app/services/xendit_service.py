import logging

import httpx
import xendit
from xendit.apis import PayoutApi
from xendit.exceptions import ApiException

from app.config import settings

logger = logging.getLogger(__name__)

VALID_CHANNEL_CODES = {
    "ID_BCA", "ID_MANDIRI", "ID_BNI", "ID_BRI", "ID_PERMATA", "ID_CIMB",
}

configuration = xendit.Configuration()
configuration.api_key = {"ApiKeyAuth": settings.XENDIT_SECRET_KEY}
xendit_client = xendit.ApiClient(configuration)
payout_api = PayoutApi(xendit_client)


class XenditError(Exception):
    """Raised when a Xendit API call fails."""

    def __init__(self, message: str, status_code: int | None = None, error_code: str | None = None):
        self.status_code = status_code
        self.error_code = error_code
        super().__init__(message)


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
    if channel_code not in VALID_CHANNEL_CODES:
        raise XenditError(f"Invalid channel code: {channel_code}")
    if not account_number or not account_number.strip():
        raise XenditError("Account number is required")
    if not account_holder_name or not account_holder_name.strip():
        raise XenditError("Account holder name is required")
    if amount <= 0:
        raise XenditError(f"Amount must be positive, got {amount}")

    logger.info(
        "Creating Xendit payout: ref=%s channel=%s amount=%s %s",
        reference_id, channel_code, amount, currency,
    )

    try:
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
    except ApiException as e:
        logger.error(
            "Xendit API error creating payout ref=%s: status=%s body=%s",
            reference_id, e.status, e.body,
        )
        raise XenditError(
            f"Xendit API error: {e.body}",
            status_code=e.status,
            error_code=getattr(e, "error_code", None),
        ) from e

    logger.info(
        "Xendit payout created: ref=%s xendit_id=%s status=%s",
        reference_id, payout.id, payout.status,
    )
    return {
        "id": payout.id,
        "reference_id": payout.reference_id,
        "status": payout.status,
        "amount": payout.amount,
    }


async def validate_bank_account(
    channel_code: str,
    account_number: str,
) -> dict:
    """Validate a bank account via Xendit's bank account inquiry API.

    Returns account holder name if valid, raises XenditError otherwise.
    """
    if channel_code not in VALID_CHANNEL_CODES:
        raise XenditError(f"Invalid channel code: {channel_code}")
    if not account_number or not account_number.strip():
        raise XenditError("Account number is required")

    logger.info(
        "Validating bank account: channel=%s account=%s",
        channel_code, account_number,
    )

    # Strip the "ID_" prefix for the inquiry API (e.g. ID_BCA -> BCA)
    bank_code = channel_code.replace("ID_", "")

    async with httpx.AsyncClient() as client:
        try:
            resp = await client.post(
                "https://api.xendit.co/bank_account_data/inquiries",
                json={
                    "bank_code": bank_code,
                    "account_number": account_number.strip(),
                },
                auth=(settings.XENDIT_SECRET_KEY, ""),
                timeout=15.0,
            )
        except httpx.RequestError as e:
            logger.error("Network error validating bank account: %s", e)
            raise XenditError(f"Network error: {e}") from e

    if resp.status_code != 200:
        logger.warning(
            "Xendit bank validation failed: status=%s body=%s",
            resp.status_code, resp.text,
        )
        raise XenditError(
            f"Bank account validation failed: {resp.text}",
            status_code=resp.status_code,
        )

    data = resp.json()
    logger.info(
        "Bank account validated: channel=%s holder=%s",
        channel_code, data.get("account_holder"),
    )
    return {
        "account_holder": data.get("account_holder", ""),
        "status": data.get("status", ""),
    }


async def get_payout(payout_id: str) -> dict:
    """Get payout status from Xendit."""
    try:
        payout = payout_api.get_payout_by_id(id=payout_id)
    except ApiException as e:
        logger.error(
            "Xendit API error fetching payout %s: status=%s body=%s",
            payout_id, e.status, e.body,
        )
        raise XenditError(
            f"Xendit API error: {e.body}",
            status_code=e.status,
        ) from e

    return {
        "id": payout.id,
        "reference_id": payout.reference_id,
        "status": payout.status,
        "amount": payout.amount,
    }
