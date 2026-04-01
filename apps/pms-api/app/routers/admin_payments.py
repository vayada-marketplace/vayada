import logging

from fastapi import APIRouter, HTTPException, Depends

from app.dependencies import require_hotel_admin
from app.utils import get_hotel_id
from app.database import BookingEngineDatabase
from app.config import settings as app_settings
from app.repositories.hotel_payment_settings_repo import HotelPaymentSettingsRepository
from app.repositories.cancellation_policy_repo import CancellationPolicyRepository
from app.repositories.room_type_repo import RoomTypeRepository
from app.services.currency_service import get_exchange_rate, convert_room_type_rates
from app.models.payment import (
    HotelPaymentSettings,
    HotelPaymentSettingsUpdate,
    CancellationPolicy,
    CancellationPolicyUpdate,
    StripeConnectAccountRequest,
    XenditBankDetailsRequest,
)
from app.services import stripe_service, xendit_service
from app.services.xendit_service import XenditError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["admin-payments"])


async def _get_booking_engine_currency(user_id: str) -> str:
    """Fetch the currency set during onboarding from the booking engine DB."""
    if not app_settings.BOOKING_ENGINE_DATABASE_URL:
        return "EUR"
    try:
        currency = await BookingEngineDatabase.fetchval(
            "SELECT currency FROM booking_hotels WHERE user_id = $1",
            user_id,
        )
        return currency or "EUR"
    except Exception as e:
        logger.warning("Failed to fetch currency from booking engine DB: %s", e)
        return "EUR"


# ── Payment Settings ──────────────────────────────────────────────


@router.get("/payment-settings")
async def get_payment_settings(
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    settings = await HotelPaymentSettingsRepository.get_by_hotel_id(hotel_id)
    policy = await CancellationPolicyRepository.get_by_hotel_id(hotel_id)

    # If no PMS payment settings exist yet, read currency from booking engine
    if settings:
        currency = settings.get("default_currency", "EUR")
    else:
        currency = await _get_booking_engine_currency(user_id)

    return {
        "paymentSettings": HotelPaymentSettings(
            stripe_connect_account_id=settings["stripe_connect_account_id"] if settings else None,
            stripe_connect_onboarded=settings["stripe_connect_onboarded"] if settings else False,
            platform_fee_type=settings["platform_fee_type"] if settings else "percentage",
            platform_fee_value=float(settings["platform_fee_value"]) if settings else 8.00,
            platform_fee_with_affiliate=float(settings["platform_fee_with_affiliate"]) if settings else 2.00,
            pay_at_property_enabled=settings["pay_at_property_enabled"] if settings else False,
            online_card_payment=settings.get("online_card_payment", False) if settings else False,
            bank_transfer=settings.get("bank_transfer", False) if settings else False,
            xendit_payments_enabled=settings.get("xendit_payments_enabled", False) if settings else False,
            payment_provider=settings["payment_provider"] if settings else "stripe",
            xendit_channel_code=settings.get("xendit_channel_code") if settings else None,
            xendit_account_number=settings.get("xendit_account_number") if settings else None,
            xendit_account_holder_name=settings.get("xendit_account_holder_name") if settings else None,
            default_currency=currency,
        ).model_dump(by_alias=True),
        "cancellationPolicy": CancellationPolicy(
            free_cancellation_days=policy["free_cancellation_days"] if policy else 7,
            partial_refund_pct=float(policy["partial_refund_pct"]) if policy else 0.00,
        ).model_dump(by_alias=True),
    }


@router.patch("/payment-settings")
async def update_payment_settings(
    data: HotelPaymentSettingsUpdate,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    updates = data.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    # When switching to xendit, require all bank details
    if updates.get("payment_provider") == "xendit":
        existing = await HotelPaymentSettingsRepository.get_by_hotel_id(hotel_id)
        final_code = updates.get("xendit_channel_code") or (existing or {}).get("xendit_channel_code")
        final_number = updates.get("xendit_account_number") or (existing or {}).get("xendit_account_number")
        final_name = updates.get("xendit_account_holder_name") or (existing or {}).get("xendit_account_holder_name")
        missing = []
        if not final_code:
            missing.append("xenditChannelCode")
        if not final_number:
            missing.append("xenditAccountNumber")
        if not final_name:
            missing.append("xenditAccountHolderName")
        if missing:
            raise HTTPException(
                status_code=400,
                detail=f"Xendit bank details required: {', '.join(missing)}",
            )

    # Convert room type rates when currency changes
    new_currency = updates.get("default_currency")
    if new_currency:
        existing = await HotelPaymentSettingsRepository.get_by_hotel_id(hotel_id)
        old_currency = existing["default_currency"] if existing else await _get_booking_engine_currency(user_id)
        if old_currency != new_currency:
            try:
                rate = await get_exchange_rate(old_currency, new_currency)
                # Determine decimal places: currencies like IDR, JPY, KRW use 0
                zero_decimal = new_currency in ("IDR", "JPY", "KRW", "VND", "CLP", "GNF", "PYG", "RWF", "UGX", "XOF", "XAF")
                decimals = 0 if zero_decimal else 2
                room_types = await RoomTypeRepository.list_by_hotel_id(hotel_id)
                for rt in room_types:
                    rt_updates = await convert_room_type_rates(rt, rate, decimals)
                    rt_updates["currency"] = new_currency
                    if rt_updates:
                        await RoomTypeRepository.update(str(rt["id"]), rt_updates)
                logger.info(
                    "Converted %d room type rates from %s to %s (rate=%.6f)",
                    len(room_types), old_currency, new_currency, rate,
                )
            except Exception as e:
                logger.error("Failed to convert room rates: %s", e)
                raise HTTPException(
                    status_code=502,
                    detail=f"Failed to fetch exchange rate for {old_currency} → {new_currency}. Currency not updated.",
                )

    await HotelPaymentSettingsRepository.upsert(hotel_id, updates)

    # Sync currency to booking engine
    if new_currency and app_settings.BOOKING_ENGINE_DATABASE_URL:
        try:
            await BookingEngineDatabase.execute(
                "UPDATE booking_hotels SET currency = $2 WHERE user_id = $1",
                user_id, new_currency,
            )
        except Exception as e:
            logger.warning("Failed to sync currency to booking engine: %s", e)

    sync_fields = {
        "pay_at_property_enabled", "online_card_payment", "bank_transfer",
    }
    booking_updates = {k: v for k, v in updates.items() if k in sync_fields}
    if booking_updates and app_settings.BOOKING_ENGINE_DATABASE_URL:
        try:
            sets = ", ".join(f"{k} = ${i+2}" for i, k in enumerate(booking_updates))
            vals = list(booking_updates.values())
            await BookingEngineDatabase.execute(
                f"UPDATE booking_hotels SET {sets} WHERE user_id = $1",
                user_id, *vals,
            )
        except Exception as e:
            logger.warning("Failed to sync payment methods to booking engine: %s", e)

    return {"status": "updated"}


@router.patch("/cancellation-policy")
async def update_cancellation_policy(
    data: CancellationPolicyUpdate,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    updates = data.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    await CancellationPolicyRepository.upsert(hotel_id, updates)
    return {"status": "updated"}


# ── Stripe Connect ────────────────────────────────────────────────


@router.post("/stripe/connect-account")
async def create_stripe_connect_account(
    data: StripeConnectAccountRequest,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    account = await stripe_service.create_connect_account(data.email, data.country)
    await HotelPaymentSettingsRepository.upsert(
        hotel_id, {"stripe_connect_account_id": account["id"]}
    )
    return {"accountId": account["id"]}


@router.get("/stripe/connect-onboarding-link")
async def get_stripe_onboarding_link(
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    settings = await HotelPaymentSettingsRepository.get_by_hotel_id(hotel_id)
    if not settings or not settings.get("stripe_connect_account_id"):
        raise HTTPException(status_code=400, detail="No Stripe Connect account found")

    url = await stripe_service.create_connect_account_link(
        settings["stripe_connect_account_id"],
        return_url="https://pms.vayada.com/settings?stripe=success",
        refresh_url="https://pms.vayada.com/settings?stripe=refresh",
    )
    return {"url": url}


# ── Xendit ────────────────────────────────────────────────────────


@router.post("/xendit/validate-bank-account")
async def validate_xendit_bank_account(
    data: XenditBankDetailsRequest,
    user_id: str = Depends(require_hotel_admin),
):
    """Validate a bank account via Xendit before saving it."""
    try:
        result = await xendit_service.validate_bank_account(
            channel_code=data.channel_code,
            account_number=data.account_number,
        )
    except XenditError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return result


@router.post("/xendit/reconcile-payouts")
async def reconcile_xendit_payouts(
    user_id: str = Depends(require_hotel_admin),
):
    """Manually reconcile all Xendit payouts stuck in 'processing' for this hotel."""
    hotel_id = await get_hotel_id(user_id)
    from app.repositories.payout_repo import PayoutRepository

    stale = await PayoutRepository.list_processing_xendit(older_than_minutes=0)
    # Filter to this hotel's payouts
    hotel_payouts = [p for p in stale if str(p.get("recipient_id")) == hotel_id and p.get("recipient_type") == "hotel"]

    results = []
    for payout in hotel_payouts:
        payout_id = str(payout["id"])
        xendit_id = payout["xendit_payout_id"]
        try:
            status_data = await xendit_service.get_payout(xendit_id)
            xendit_status = status_data["status"]

            if xendit_status == "SUCCEEDED":
                await PayoutRepository.update_status(payout_id, "completed", xendit_payout_id=xendit_id)
                results.append({"payoutId": payout_id, "status": "completed"})
            elif xendit_status in ("FAILED", "REVERSED"):
                await PayoutRepository.update_status(payout_id, "failed")
                results.append({"payoutId": payout_id, "status": "failed"})
            else:
                results.append({"payoutId": payout_id, "status": xendit_status.lower()})
        except XenditError as e:
            results.append({"payoutId": payout_id, "status": "error", "error": str(e)})

    return {"reconciled": len(results), "payouts": results}
