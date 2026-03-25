import logging

from fastapi import APIRouter, HTTPException, Depends

from app.dependencies import require_hotel_admin
from app.utils import get_hotel_id
from app.repositories.hotel_payment_settings_repo import HotelPaymentSettingsRepository
from app.repositories.cancellation_policy_repo import CancellationPolicyRepository
from app.models.payment import (
    HotelPaymentSettings,
    HotelPaymentSettingsUpdate,
    CancellationPolicy,
    CancellationPolicyUpdate,
    StripeConnectAccountRequest,
)
from app.services import stripe_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["admin-payments"])


# ── Payment Settings ──────────────────────────────────────────────


@router.get("/payment-settings")
async def get_payment_settings(
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    settings = await HotelPaymentSettingsRepository.get_by_hotel_id(hotel_id)
    policy = await CancellationPolicyRepository.get_by_hotel_id(hotel_id)

    return {
        "paymentSettings": HotelPaymentSettings(
            stripe_connect_account_id=settings["stripe_connect_account_id"] if settings else None,
            stripe_connect_onboarded=settings["stripe_connect_onboarded"] if settings else False,
            platform_fee_type=settings["platform_fee_type"] if settings else "percentage",
            platform_fee_value=float(settings["platform_fee_value"]) if settings else 8.00,
            platform_fee_with_affiliate=float(settings["platform_fee_with_affiliate"]) if settings else 2.00,
            pay_at_property_enabled=settings["pay_at_property_enabled"] if settings else False,
            payment_provider=settings["payment_provider"] if settings else "stripe",
            xendit_channel_code=settings.get("xendit_channel_code") if settings else None,
            xendit_account_number=settings.get("xendit_account_number") if settings else None,
            xendit_account_holder_name=settings.get("xendit_account_holder_name") if settings else None,
            default_currency=settings.get("default_currency", "EUR") if settings else "EUR",
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
    await HotelPaymentSettingsRepository.upsert(hotel_id, updates)
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
