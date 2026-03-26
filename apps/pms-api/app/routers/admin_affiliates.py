import logging
import secrets
from typing import Optional

import bcrypt
from fastapi import APIRouter, HTTPException, Depends, Query

from app.dependencies import require_hotel_admin
from app.utils import get_hotel_id
from app.repositories.affiliate_repo import AffiliateRepository
from app.models.affiliate import (
    AffiliateAdminResponse,
    AffiliateStatusUpdate,
    AffiliateCommissionUpdate,
)
from app.models.payment import StripeConnectAccountRequest, XenditBankDetailsRequest
from app.services import stripe_service
from app.services.email_service import send_affiliate_approved, send_affiliate_invite
from app.database import Database, AuthDatabase

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["admin-affiliates"])


def _affiliate_to_admin(a: dict) -> AffiliateAdminResponse:
    revenue = float(a.get("total_revenue", 0) or 0)
    commission_pct = float(a["commission_pct"])
    booking_count = int(a.get("booking_count", 0) or 0)
    click_count = int(a.get("click_count", 0) or 0)
    conversion_rate = round(booking_count / click_count * 100, 2) if click_count > 0 else 0.0
    return AffiliateAdminResponse(
        id=str(a["id"]),
        hotel_id=str(a["hotel_id"]),
        referral_code=a["referral_code"],
        full_name=a["full_name"],
        email=a["email"],
        social_media=a["social_media"],
        user_type=a["user_type"],
        payment_method=a["payment_method"],
        paypal_email=a["paypal_email"],
        bank_iban=a["bank_iban"],
        commission_pct=commission_pct,
        status=a["status"],
        created_at=a["created_at"].isoformat(),
        updated_at=a["updated_at"].isoformat(),
        stripe_connect_account_id=a.get("stripe_connect_account_id"),
        stripe_connect_onboarded=a.get("stripe_connect_onboarded", False),
        xendit_channel_code=a.get("xendit_channel_code"),
        xendit_account_number=a.get("xendit_account_number"),
        xendit_account_holder_name=a.get("xendit_account_holder_name"),
        booking_count=booking_count,
        total_revenue=revenue,
        total_commission=round(revenue * commission_pct / 100, 2),
        click_count=click_count,
        conversion_rate=conversion_rate,
    )


# ── Affiliates ─────────────────────────────────────────────────────


@router.get("/affiliates")
async def list_affiliates(
    status: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    affiliates = await AffiliateRepository.list_by_hotel_id(
        hotel_id, status=status, limit=limit, offset=offset
    )
    total = await AffiliateRepository.count_by_hotel_id(hotel_id, status=status)
    return {
        "affiliates": [_affiliate_to_admin(a) for a in affiliates],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


@router.get("/affiliates/{affiliate_id}", response_model=AffiliateAdminResponse)
async def get_affiliate(
    affiliate_id: str,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    affiliate = await AffiliateRepository.get_by_id(affiliate_id)
    if not affiliate or str(affiliate["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Affiliate not found")
    # Fetch with stats
    affiliates = await AffiliateRepository.list_by_hotel_id(hotel_id, limit=1000)
    matched = next((a for a in affiliates if str(a["id"]) == affiliate_id), None)
    if not matched:
        raise HTTPException(status_code=404, detail="Affiliate not found")
    return _affiliate_to_admin(matched)


@router.patch("/affiliates/{affiliate_id}/status", response_model=AffiliateAdminResponse)
async def update_affiliate_status(
    affiliate_id: str,
    data: AffiliateStatusUpdate,
    user_id: str = Depends(require_hotel_admin),
):
    if data.status not in ("approved", "rejected", "suspended"):
        raise HTTPException(
            status_code=400,
            detail="Status must be 'approved', 'rejected', or 'suspended'",
        )

    hotel_id = await get_hotel_id(user_id)
    affiliate = await AffiliateRepository.get_by_id(affiliate_id)
    if not affiliate or str(affiliate["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Affiliate not found")

    await AffiliateRepository.update_status(affiliate_id, data.status)

    if data.status == "approved":
        hotel = await Database.fetchrow("SELECT name, slug FROM hotels WHERE id = $1", hotel_id)
        hotel_name = hotel["name"] if hotel else "the hotel"
        hotel_slug = hotel["slug"] if hotel else ""
        await send_affiliate_approved(
            affiliate["email"],
            affiliate["full_name"],
            hotel_name,
            affiliate["referral_code"],
        )

        # Create affiliate user account if one doesn't exist for this email
        existing_user = await AuthDatabase.fetchrow(
            "SELECT id FROM users WHERE email = $1", affiliate["email"]
        )
        if not existing_user:
            # Create a password reset token so the affiliate can set their password
            reset_token = secrets.token_urlsafe(32)
            temp_password = secrets.token_urlsafe(24)
            password_hash = bcrypt.hashpw(temp_password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")

            new_user = await AuthDatabase.fetchrow(
                """
                INSERT INTO users (email, password_hash, name, type, status, email_verified)
                VALUES ($1, $2, $3, 'affiliate', 'verified', true)
                RETURNING id
                """,
                affiliate["email"],
                password_hash,
                affiliate["full_name"],
            )
            user_id_val = str(new_user["id"])

            # Store password reset token (expires in 24h)
            await AuthDatabase.execute(
                """
                INSERT INTO password_reset_tokens (user_id, token, expires_at)
                VALUES ($1, $2, now() + interval '24 hours')
                """,
                user_id_val,
                reset_token,
            )

            # Link affiliate record to the new user
            await Database.execute(
                "UPDATE affiliates SET user_id = $1 WHERE id = $2",
                user_id_val,
                affiliate_id,
            )

            set_password_url = f"https://affiliate.vayada.com/set-password?token={reset_token}"
            await send_affiliate_invite(
                affiliate["email"],
                affiliate["full_name"],
                hotel_name,
                set_password_url,
            )
        else:
            # Link existing user to this affiliate record
            await Database.execute(
                "UPDATE affiliates SET user_id = $1 WHERE id = $2",
                str(existing_user["id"]),
                affiliate_id,
            )

    # Re-fetch with stats
    affiliates = await AffiliateRepository.list_by_hotel_id(hotel_id, limit=1000)
    matched = next((a for a in affiliates if str(a["id"]) == affiliate_id), None)
    return _affiliate_to_admin(matched)


@router.patch("/affiliates/{affiliate_id}/commission", response_model=AffiliateAdminResponse)
async def update_affiliate_commission(
    affiliate_id: str,
    data: AffiliateCommissionUpdate,
    user_id: str = Depends(require_hotel_admin),
):
    if data.commission_pct < 0 or data.commission_pct > 100:
        raise HTTPException(
            status_code=400, detail="Commission must be between 0 and 100"
        )

    hotel_id = await get_hotel_id(user_id)
    affiliate = await AffiliateRepository.get_by_id(affiliate_id)
    if not affiliate or str(affiliate["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Affiliate not found")

    await AffiliateRepository.update_commission(affiliate_id, data.commission_pct)
    # Re-fetch with stats
    affiliates = await AffiliateRepository.list_by_hotel_id(hotel_id, limit=1000)
    matched = next((a for a in affiliates if str(a["id"]) == affiliate_id), None)
    return _affiliate_to_admin(matched)


@router.post("/affiliates/{affiliate_id}/stripe/connect-account")
async def create_affiliate_stripe_account(
    affiliate_id: str,
    data: StripeConnectAccountRequest,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    affiliate = await AffiliateRepository.get_by_id(affiliate_id)
    if not affiliate or str(affiliate["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Affiliate not found")

    if affiliate["status"] != "approved":
        raise HTTPException(status_code=400, detail="Affiliate must be approved before setting up Stripe")

    if affiliate.get("stripe_connect_account_id"):
        raise HTTPException(status_code=409, detail="Stripe account already exists for this affiliate")

    account = await stripe_service.create_connect_account(data.email, data.country)
    await AffiliateRepository.update_stripe_connect(affiliate_id, account["id"])
    return {"accountId": account["id"]}


@router.get("/affiliates/{affiliate_id}/stripe/connect-onboarding-link")
async def get_affiliate_stripe_onboarding_link(
    affiliate_id: str,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    affiliate = await AffiliateRepository.get_by_id(affiliate_id)
    if not affiliate or str(affiliate["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Affiliate not found")

    if not affiliate.get("stripe_connect_account_id"):
        raise HTTPException(status_code=400, detail="No Stripe Connect account found for this affiliate")

    url = await stripe_service.create_connect_account_link(
        affiliate["stripe_connect_account_id"],
        return_url=f"https://pms.vayada.com/affiliates/{affiliate_id}?stripe=success",
        refresh_url=f"https://pms.vayada.com/affiliates/{affiliate_id}?stripe=refresh",
    )
    return {"url": url}


@router.post("/affiliates/{affiliate_id}/xendit/bank-details", response_model=AffiliateAdminResponse)
async def save_affiliate_xendit_bank_details(
    affiliate_id: str,
    data: XenditBankDetailsRequest,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    affiliate = await AffiliateRepository.get_by_id(affiliate_id)
    if not affiliate or str(affiliate["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Affiliate not found")

    if affiliate["status"] != "approved":
        raise HTTPException(status_code=400, detail="Affiliate must be approved before setting up Xendit")

    await AffiliateRepository.update_xendit_details(
        affiliate_id, data.channel_code, data.account_number, data.account_holder_name
    )
    # Re-fetch with stats
    affiliates = await AffiliateRepository.list_by_hotel_id(hotel_id, limit=1000)
    matched = next((a for a in affiliates if str(a["id"]) == affiliate_id), None)
    return _affiliate_to_admin(matched)
