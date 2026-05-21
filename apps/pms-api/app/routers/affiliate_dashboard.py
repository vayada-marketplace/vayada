"""
Affiliate-facing dashboard routes — requires affiliate auth.
"""

import logging
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict

from app.database import AuthDatabase, Database
from app.dependencies import require_affiliate
from app.repositories.affiliate_payout_settings_repo import (
    AffiliatePayoutSettingsRepository,
)
from app.repositories.affiliate_repo import AffiliateRepository

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
    paypal_email: str = ""
    bank_iban: str = ""
    bank_account_holder: str = ""
    bank_swift_bic: str = ""
    bank_name: str = ""
    bank_country: str = ""
    xendit_channel_code: str | None = None
    xendit_account_number: str | None = None
    xendit_account_holder_name: str | None = None


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

    payment_method: str | None = None
    paypal_email: str | None = None
    bank_iban: str | None = None
    bank_account_holder: str | None = None
    bank_swift_bic: str | None = None
    bank_name: str | None = None
    bank_country: str | None = None
    xendit_channel_code: str | None = None
    xendit_account_number: str | None = None
    xendit_account_holder_name: str | None = None


class PayoutSettings(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    payment_method: str
    paypal_email: str
    bank_iban: str
    bank_account_holder: str
    bank_swift_bic: str
    bank_name: str
    bank_country: str
    xendit_channel_code: str | None = None
    xendit_account_number: str | None = None
    xendit_account_holder_name: str | None = None


# ── Helpers ───────────────────────────────────────────────────────


def _build_property_stats(a: dict) -> PropertyStats:
    revenue = float(a.get("total_revenue", 0) or 0)
    commission_pct = float(a["effective_commission_pct"])
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
        paypal_email=a.get("paypal_email", "") or "",
        bank_iban=a.get("bank_iban", "") or "",
        bank_account_holder=a.get("bank_account_holder", "") or "",
        bank_swift_bic=a.get("bank_swift_bic", "") or "",
        bank_name=a.get("bank_name", "") or "",
        bank_country=a.get("bank_country", "") or "",
        xendit_channel_code=a.get("xendit_channel_code"),
        xendit_account_number=a.get("xendit_account_number"),
        xendit_account_holder_name=a.get("xendit_account_holder_name"),
    )


# ── Routes ────────────────────────────────────────────────────────


@router.get("/me")
async def get_profile(user_id: str = Depends(require_affiliate)):
    user = await AuthDatabase.fetchrow("SELECT id, email, name FROM users WHERE id = $1", user_id)
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

    total_bookings = 0
    total_clicks = 0
    for a in affiliates:
        total_bookings += int(a.get("booking_count", 0) or 0)
        total_clicks += int(a.get("click_count", 0) or 0)

    # The payouts table is the source of truth for both earnings and
    # paid status — `affiliate_commission` is computed at booking time
    # using min(commission_pct, total_fee), which we'd otherwise have
    # to recompute here. Aggregate per affiliate id and sum.
    affiliate_ids = [str(a["id"]) for a in affiliates]
    total_earned = 0.0
    outstanding = 0.0
    if affiliate_ids:
        rows = await Database.fetch(
            """
            SELECT
                COALESCE(SUM(amount) FILTER (WHERE status = 'completed'),                         0)::numeric AS paid,
                COALESCE(SUM(amount) FILTER (WHERE status IN ('scheduled','processing','failed')), 0)::numeric AS unpaid
            FROM payouts
            WHERE recipient_type = 'affiliate'
              AND recipient_id = ANY($1::uuid[])
            """,
            affiliate_ids,
        )
        if rows:
            paid_total = float(rows[0]["paid"] or 0)
            unpaid_total = float(rows[0]["unpaid"] or 0)
            total_earned = paid_total + unpaid_total
            outstanding = unpaid_total

    conversion_rate = round(total_bookings / total_clicks * 100, 2) if total_clicks > 0 else 0.0

    return DashboardStats(
        total_earned=round(total_earned, 2),
        total_bookings=total_bookings,
        total_clicks=total_clicks,
        conversion_rate=conversion_rate,
        property_count=len(affiliates),
        outstanding_balance=round(outstanding, 2),
    )


_PERIOD_MONTHS = {"1m": 1, "3m": 3, "6m": 6, "12m": 12}


@router.get("/earnings")
async def get_earnings(
    period: str = Query("6m", pattern="^(1m|3m|6m|12m)$"),
    user_id: str = Depends(require_affiliate),
):
    """Return monthly affiliate earnings for the chart.

    Sums payouts grouped by the month they were (or will be) paid out —
    includes completed, scheduled, and processing payouts so the chart
    reflects everything the affiliate has earned, not just what's cleared.
    Missing months in the range are zero-filled so the chart has a
    consistent x-axis.
    """
    affiliates = await AffiliateRepository.list_by_user_id(user_id)
    if not affiliates:
        return {"months": [], "currency": "EUR"}

    months = _PERIOD_MONTHS[period]
    now = datetime.now(UTC)
    # Walk back `months - 1` month boundaries so 6m = current + 5 prior = 6 buckets
    start_month = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    for _ in range(months - 1):
        start_month = (start_month - timedelta(days=1)).replace(day=1)

    affiliate_ids = [str(a["id"]) for a in affiliates]
    rows = await Database.fetch(
        """
        SELECT DATE_TRUNC('month', COALESCE(completed_at, scheduled_for))::date AS month,
               SUM(amount)::numeric AS earnings,
               MIN(currency) AS currency
        FROM payouts
        WHERE recipient_type = 'affiliate'
          AND recipient_id = ANY($1::uuid[])
          AND status IN ('scheduled', 'processing', 'completed')
          AND COALESCE(completed_at, scheduled_for) >= $2
        GROUP BY DATE_TRUNC('month', COALESCE(completed_at, scheduled_for))
        ORDER BY month
        """,
        affiliate_ids,
        start_month,
    )

    by_month: dict[str, float] = {}
    currency = "EUR"
    for r in rows:
        key = r["month"].strftime("%Y-%m")
        by_month[key] = float(r["earnings"] or 0)
        if r["currency"]:
            currency = r["currency"]

    # Zero-fill the full range
    result = []
    cursor = start_month
    for _ in range(months):
        key = cursor.strftime("%Y-%m")
        result.append(
            {
                "month": key,
                "label": cursor.strftime("%b"),
                "earnings": round(by_month.get(key, 0.0), 2),
            }
        )
        # Advance one month
        if cursor.month == 12:
            cursor = cursor.replace(year=cursor.year + 1, month=1)
        else:
            cursor = cursor.replace(month=cursor.month + 1)

    return {"months": result, "currency": currency}


@router.get("/activity")
async def get_activity(
    limit: int = Query(10, ge=1, le=50),
    user_id: str = Depends(require_affiliate),
):
    """Return a merged recent-activity feed: bookings + click batches.

    Bookings are emitted individually. Clicks are aggregated per
    (affiliate, day) so the feed shows "N new link clicks" entries
    instead of spamming one event per click.
    """
    affiliates = await AffiliateRepository.list_by_user_id(user_id)
    if not affiliates:
        return {"activities": []}

    affiliate_ids = [str(a["id"]) for a in affiliates]

    booking_rows = await Database.fetch(
        """
        SELECT b.created_at AS ts,
               h.name AS property
        FROM bookings b
        JOIN hotels h ON h.id = b.hotel_id
        WHERE b.affiliate_id = ANY($1::uuid[])
          AND b.status = 'confirmed'
        ORDER BY b.created_at DESC
        LIMIT $2
        """,
        affiliate_ids,
        limit,
    )

    click_rows = await Database.fetch(
        """
        SELECT DATE_TRUNC('day', ac.created_at) AS ts,
               h.name AS property,
               COUNT(*) AS count
        FROM affiliate_clicks ac
        JOIN affiliates a ON a.id = ac.affiliate_id
        JOIN hotels h ON h.id = a.hotel_id
        WHERE ac.affiliate_id = ANY($1::uuid[])
        GROUP BY DATE_TRUNC('day', ac.created_at), h.name
        ORDER BY ts DESC
        LIMIT $2
        """,
        affiliate_ids,
        limit,
    )

    events: list[dict] = []
    for r in booking_rows:
        events.append(
            {
                "type": "booking",
                "ts": r["ts"].isoformat(),
                "property": r["property"],
                "count": 1,
            }
        )
    for r in click_rows:
        events.append(
            {
                "type": "click",
                "ts": r["ts"].isoformat(),
                "property": r["property"],
                "count": int(r["count"]),
            }
        )

    events.sort(key=lambda e: e["ts"], reverse=True)
    return {"activities": events[:limit]}


@router.get("/payouts")
async def get_payouts(user_id: str = Depends(require_affiliate)):
    """Return completed payouts for this affiliate, grouped by the
    batch they were sent in (matched on completed_at + payment_method
    + external_reference so a single vayada transfer that covered
    several bookings shows up as one row)."""
    affiliates = await AffiliateRepository.list_by_user_id(user_id)
    if not affiliates:
        return {"payouts": []}

    affiliate_ids = [str(a["id"]) for a in affiliates]
    rows = await Database.fetch(
        """
        SELECT
            DATE_TRUNC('second', completed_at) AS completed_at,
            payment_method,
            external_reference,
            SUM(amount)::numeric AS amount,
            MIN(currency)        AS currency,
            COUNT(*)             AS booking_count
        FROM payouts
        WHERE recipient_type = 'affiliate'
          AND recipient_id = ANY($1::uuid[])
          AND status = 'completed'
        GROUP BY DATE_TRUNC('second', completed_at), payment_method, external_reference
        ORDER BY DATE_TRUNC('second', completed_at) DESC
        """,
        affiliate_ids,
    )

    payouts = [
        {
            "id": f"{r['completed_at'].isoformat()}-{r['payment_method'] or ''}-{r['external_reference'] or ''}",
            "date": r["completed_at"].isoformat(),
            "amount": float(r["amount"]),
            "currency": r["currency"] or "EUR",
            "method": r["payment_method"] or "manual",
            "reference": r["external_reference"],
            "bookingCount": int(r["booking_count"]),
            "status": "completed",
        }
        for r in rows
    ]
    return {"payouts": payouts}


def _build_payout_updates(data: ProfileUpdate) -> dict:
    """Translate the wire-format ProfileUpdate into a column-keyed dict
    suitable for both the canonical payout-settings table and the
    legacy mirror on `affiliates`. Performs uppercasing + enum
    validation along the way.
    """
    updates: dict = {}
    if data.payment_method is not None:
        if data.payment_method not in ("stripe", "paypal", "bank", "xendit"):
            raise HTTPException(status_code=400, detail="Invalid payment method")
        updates["payment_method"] = data.payment_method
    if data.paypal_email is not None:
        updates["paypal_email"] = data.paypal_email
    if data.bank_iban is not None:
        updates["bank_iban"] = data.bank_iban
    if data.bank_account_holder is not None:
        updates["bank_account_holder"] = data.bank_account_holder
    if data.bank_swift_bic is not None:
        updates["bank_swift_bic"] = data.bank_swift_bic.upper()
    if data.bank_name is not None:
        updates["bank_name"] = data.bank_name
    if data.bank_country is not None:
        updates["bank_country"] = data.bank_country.upper()
    if data.xendit_channel_code is not None:
        from app.models.payment import VALID_XENDIT_CHANNEL_CODES

        if data.xendit_channel_code not in VALID_XENDIT_CHANNEL_CODES:
            raise HTTPException(status_code=400, detail="Invalid Xendit channel code")
        updates["xendit_channel_code"] = data.xendit_channel_code
    if data.xendit_account_number is not None:
        updates["xendit_account_number"] = data.xendit_account_number
    if data.xendit_account_holder_name is not None:
        updates["xendit_account_holder_name"] = data.xendit_account_holder_name
    return updates


async def _save_payout_settings(user_id: str, data: ProfileUpdate) -> dict:
    """Write payout settings for a user to the canonical
    affiliate_payout_settings row."""
    affiliates = await AffiliateRepository.list_by_user_id(user_id)
    if not affiliates:
        raise HTTPException(status_code=404, detail="No affiliate records found")

    updates = _build_payout_updates(data)
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    # When switching to xendit, require all bank details — check the
    # post-update merged view so partial updates don't fail spuriously.
    existing = await AffiliatePayoutSettingsRepository.get_or_default(user_id)
    if updates.get("payment_method") == "xendit":
        final_code = updates.get("xendit_channel_code") or existing.get("xendit_channel_code")
        final_number = updates.get("xendit_account_number") or existing.get("xendit_account_number")
        final_name = updates.get("xendit_account_holder_name") or existing.get(
            "xendit_account_holder_name"
        )
        if not final_code or not final_number or not final_name:
            raise HTTPException(status_code=400, detail="All Xendit bank details are required")

    return await AffiliatePayoutSettingsRepository.upsert(user_id, updates)


def _payout_response(row: dict) -> PayoutSettings:
    return PayoutSettings(
        payment_method=row["payment_method"],
        paypal_email=row.get("paypal_email") or "",
        bank_iban=row.get("bank_iban") or "",
        bank_account_holder=row.get("bank_account_holder") or "",
        bank_swift_bic=row.get("bank_swift_bic") or "",
        bank_name=row.get("bank_name") or "",
        bank_country=row.get("bank_country") or "",
        xendit_channel_code=row.get("xendit_channel_code"),
        xendit_account_number=row.get("xendit_account_number"),
        xendit_account_holder_name=row.get("xendit_account_holder_name"),
    )


@router.get("/payout-settings", response_model=PayoutSettings)
async def get_payout_settings(user_id: str = Depends(require_affiliate)):
    row = await AffiliatePayoutSettingsRepository.get_or_default(user_id)
    return _payout_response(row)


@router.patch("/payout-settings", response_model=PayoutSettings)
async def update_payout_settings(
    data: ProfileUpdate,
    user_id: str = Depends(require_affiliate),
):
    saved = await _save_payout_settings(user_id, data)
    return _payout_response(saved)


@router.patch("/me")
async def update_profile(
    data: ProfileUpdate,
    user_id: str = Depends(require_affiliate),
):
    """Legacy alias for PATCH /payout-settings — kept so older clients
    that still hit /me don't break. New clients should use
    /payout-settings."""
    await _save_payout_settings(user_id, data)
    return {"message": "Profile updated"}


@router.post("/xendit/validate-bank-account")
async def validate_affiliate_bank_account(
    channel_code: str,
    account_number: str,
    user_id: str = Depends(require_affiliate),
):
    """Validate a bank account via Xendit before saving."""
    from app.services import xendit_service
    from app.services.xendit_service import XenditError

    try:
        result = await xendit_service.validate_bank_account(
            channel_code=channel_code,
            account_number=account_number,
        )
    except XenditError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return result
