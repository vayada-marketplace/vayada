"""
Affiliate-facing dashboard routes — requires affiliate auth.
"""
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, ConfigDict

from app.dependencies import require_affiliate
from app.repositories.affiliate_repo import AffiliateRepository
from app.database import Database, AuthDatabase

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/affiliate", tags=["affiliate-dashboard"])


def to_camel(string: str) -> str:
    parts = string.split("_")
    return parts[0] + "".join(w.capitalize() for w in parts[1:])


# ── Response models ───────────────────────────────────────────────


class AffiliateProfile(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    user_id: str
    name: str
    email: str


class PropertyStats(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    affiliate_id: str
    hotel_id: str
    hotel_name: str
    hotel_slug: str
    referral_code: str
    commission_pct: float
    status: str
    booking_count: int = 0
    total_revenue: float = 0.0
    total_commission: float = 0.0
    click_count: int = 0
    conversion_rate: float = 0.0
    payment_method: str = ""
    stripe_connect_onboarded: bool = False


class DashboardStats(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    total_earned: float
    total_bookings: int
    total_clicks: int
    conversion_rate: float
    property_count: int
    outstanding_balance: float


class PayoutEntry(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    date: str
    amount: float
    status: str
    method: str


class ProfileUpdate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    payment_method: Optional[str] = None
    paypal_email: Optional[str] = None
    bank_iban: Optional[str] = None


# ── Helpers ───────────────────────────────────────────────────────


def _build_property_stats(a: dict) -> PropertyStats:
    revenue = float(a.get("total_revenue", 0) or 0)
    commission_pct = float(a["commission_pct"])
    booking_count = int(a.get("booking_count", 0) or 0)
    click_count = int(a.get("click_count", 0) or 0)
    conversion_rate = round(booking_count / click_count * 100, 2) if click_count > 0 else 0.0

    return PropertyStats(
        affiliate_id=str(a["id"]),
        hotel_id=str(a["hotel_id"]),
        hotel_name=a["hotel_name"],
        hotel_slug=a["hotel_slug"],
        referral_code=a["referral_code"],
        commission_pct=commission_pct,
        status=a["status"],
        booking_count=booking_count,
        total_revenue=revenue,
        total_commission=round(revenue * commission_pct / 100, 2),
        click_count=click_count,
        conversion_rate=conversion_rate,
        payment_method=a.get("payment_method", ""),
        stripe_connect_onboarded=a.get("stripe_connect_onboarded", False),
    )


# ── Routes ────────────────────────────────────────────────────────


@router.get("/me")
async def get_profile(user_id: str = Depends(require_affiliate)):
    user = await AuthDatabase.fetchrow(
        "SELECT id, email, name FROM users WHERE id = $1", user_id
    )
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return AffiliateProfile(
        user_id=str(user["id"]),
        name=user["name"],
        email=user["email"],
    )


@router.get("/properties")
async def get_properties(user_id: str = Depends(require_affiliate)):
    affiliates = await AffiliateRepository.list_by_user_id(user_id)
    return {
        "properties": [_build_property_stats(a) for a in affiliates],
    }


@router.get("/dashboard")
async def get_dashboard(user_id: str = Depends(require_affiliate)):
    affiliates = await AffiliateRepository.list_by_user_id(user_id)

    total_earned = 0.0
    total_bookings = 0
    total_clicks = 0
    outstanding = 0.0

    for a in affiliates:
        revenue = float(a.get("total_revenue", 0) or 0)
        commission_pct = float(a["commission_pct"])
        commission = revenue * commission_pct / 100
        total_earned += commission
        total_bookings += int(a.get("booking_count", 0) or 0)
        total_clicks += int(a.get("click_count", 0) or 0)
        outstanding += commission  # simplified — full payout tracking TBD

    conversion_rate = round(total_bookings / total_clicks * 100, 2) if total_clicks > 0 else 0.0

    return DashboardStats(
        total_earned=round(total_earned, 2),
        total_bookings=total_bookings,
        total_clicks=total_clicks,
        conversion_rate=conversion_rate,
        property_count=len(affiliates),
        outstanding_balance=round(outstanding, 2),
    )


@router.get("/payouts")
async def get_payouts(user_id: str = Depends(require_affiliate)):
    # Payout tracking tables don't exist yet — return empty list for now
    return {"payouts": []}


@router.patch("/me")
async def update_profile(
    data: ProfileUpdate,
    user_id: str = Depends(require_affiliate),
):
    affiliates = await AffiliateRepository.list_by_user_id(user_id)
    if not affiliates:
        raise HTTPException(status_code=404, detail="No affiliate records found")

    updates = {}
    if data.payment_method is not None:
        if data.payment_method not in ("stripe", "paypal", "bank"):
            raise HTTPException(status_code=400, detail="Invalid payment method")
        updates["payment_method"] = data.payment_method
    if data.paypal_email is not None:
        updates["paypal_email"] = data.paypal_email
    if data.bank_iban is not None:
        updates["bank_iban"] = data.bank_iban

    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    # Update all affiliate records for this user
    set_clauses = ", ".join(f"{k} = ${i+2}" for i, k in enumerate(updates.keys()))
    values = list(updates.values())

    for a in affiliates:
        await Database.execute(
            f"UPDATE affiliates SET {set_clauses}, updated_at = now() WHERE id = $1",
            str(a["id"]),
            *values,
        )

    return {"message": "Profile updated"}
