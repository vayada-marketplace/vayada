"""
Vayada-staff-only routes for tracking and recording manual affiliate
payouts. These endpoints are NOT scoped to a single hotel — they
operate across the entire platform and require `users.is_superadmin`.
"""
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict

from app.database import AuthDatabase, Database
from app.dependencies import require_super_admin

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/super-admin", tags=["super-admin-payouts"])


def to_camel(string: str) -> str:
    parts = string.split("_")
    return parts[0] + "".join(w.capitalize() for w in parts[1:])


class AffiliatePayoutSummary(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    affiliate_id: str
    full_name: str
    email: str
    hotel_id: str
    hotel_name: str
    hotel_slug: str
    payment_method: str
    paypal_email: str = ""
    bank_account_holder: str = ""
    bank_iban: str = ""
    bank_swift_bic: str = ""
    bank_name: str = ""
    bank_country: str = ""
    stripe_connect_account_id: Optional[str] = None
    stripe_connect_onboarded: bool = False
    outstanding_amount: float
    paid_amount: float
    currency: str
    unpaid_count: int
    last_paid_at: Optional[str] = None


class BookingPayoutLine(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    payout_id: str
    booking_id: str
    booking_reference: str
    guest_name: str
    check_in: str
    check_out: str
    booking_total: float
    commission: float
    currency: str
    status: str
    scheduled_for: Optional[str] = None
    completed_at: Optional[str] = None
    payment_method: Optional[str] = None
    external_reference: Optional[str] = None


class PayoutHistoryEntry(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    completed_at: str
    payment_method: str
    external_reference: Optional[str] = None
    notes: Optional[str] = None
    amount: float
    currency: str
    booking_count: int


class MarkPaidRequest(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    payment_method: str  # 'manual_bank' | 'manual_paypal' | 'wise' | 'stripe' | 'other'
    external_reference: Optional[str] = None
    notes: Optional[str] = None


@router.get("/affiliate-payouts")
async def list_affiliate_payouts(
    user_id: str = Depends(require_super_admin),
):
    """One row per (affiliate, hotel) with their outstanding balance.

    Outstanding = sum of unpaid `payouts` rows. Paid = sum of completed.
    Affiliates with zero outstanding still appear so we can see history.
    """
    rows = await Database.fetch(
        """
        SELECT
            a.id AS affiliate_id,
            a.full_name,
            a.email,
            a.hotel_id,
            h.name AS hotel_name,
            h.slug AS hotel_slug,
            a.payment_method,
            a.paypal_email,
            a.bank_account_holder,
            a.bank_iban,
            a.bank_swift_bic,
            a.bank_name,
            a.bank_country,
            a.stripe_connect_account_id,
            a.stripe_connect_onboarded,
            COALESCE(unpaid.amount, 0)        AS outstanding_amount,
            COALESCE(unpaid.cnt, 0)           AS unpaid_count,
            COALESCE(paid.amount, 0)          AS paid_amount,
            paid.last_paid_at                 AS last_paid_at,
            COALESCE(unpaid.currency,
                     paid.currency,
                     'EUR')                   AS currency
        FROM affiliates a
        JOIN hotels h ON h.id = a.hotel_id
        LEFT JOIN (
            SELECT recipient_id,
                   SUM(amount)::numeric AS amount,
                   COUNT(*)             AS cnt,
                   MIN(currency)        AS currency
            FROM payouts
            WHERE recipient_type = 'affiliate'
              AND status IN ('scheduled', 'processing', 'failed')
            GROUP BY recipient_id
        ) unpaid ON unpaid.recipient_id = a.id
        LEFT JOIN (
            SELECT recipient_id,
                   SUM(amount)::numeric AS amount,
                   MAX(completed_at)    AS last_paid_at,
                   MIN(currency)        AS currency
            FROM payouts
            WHERE recipient_type = 'affiliate'
              AND status = 'completed'
            GROUP BY recipient_id
        ) paid ON paid.recipient_id = a.id
        WHERE a.status = 'approved'
        ORDER BY outstanding_amount DESC, a.full_name
        """
    )

    summaries = []
    for r in rows:
        summaries.append(AffiliatePayoutSummary(
            affiliate_id=str(r["affiliate_id"]),
            full_name=r["full_name"],
            email=r["email"],
            hotel_id=str(r["hotel_id"]),
            hotel_name=r["hotel_name"],
            hotel_slug=r["hotel_slug"],
            payment_method=r["payment_method"] or "",
            paypal_email=r["paypal_email"] or "",
            bank_account_holder=r["bank_account_holder"] or "",
            bank_iban=r["bank_iban"] or "",
            bank_swift_bic=r["bank_swift_bic"] or "",
            bank_name=r["bank_name"] or "",
            bank_country=r["bank_country"] or "",
            stripe_connect_account_id=r["stripe_connect_account_id"],
            stripe_connect_onboarded=bool(r["stripe_connect_onboarded"]),
            outstanding_amount=float(r["outstanding_amount"]),
            paid_amount=float(r["paid_amount"]),
            currency=r["currency"],
            unpaid_count=int(r["unpaid_count"]),
            last_paid_at=r["last_paid_at"].isoformat() if r["last_paid_at"] else None,
        ))
    return {"affiliates": summaries}


@router.get("/affiliate-payouts/{affiliate_id}")
async def get_affiliate_payout_detail(
    affiliate_id: str,
    user_id: str = Depends(require_super_admin),
):
    """Per-booking breakdown for one affiliate plus the prior payout history."""
    affiliate = await Database.fetchrow(
        """
        SELECT a.*, h.name AS hotel_name, h.slug AS hotel_slug
        FROM affiliates a JOIN hotels h ON h.id = a.hotel_id
        WHERE a.id = $1
        """,
        affiliate_id,
    )
    if not affiliate:
        raise HTTPException(status_code=404, detail="Affiliate not found")

    booking_rows = await Database.fetch(
        """
        SELECT
            p.id            AS payout_id,
            p.amount,
            p.currency,
            p.status,
            p.scheduled_for,
            p.completed_at,
            p.payment_method AS payout_payment_method,
            p.external_reference,
            b.id            AS booking_id,
            b.booking_reference,
            b.guest_name,
            b.check_in,
            b.check_out,
            b.total_amount  AS booking_total
        FROM payouts p
        JOIN bookings b ON b.id = p.booking_id
        WHERE p.recipient_type = 'affiliate'
          AND p.recipient_id = $1
        ORDER BY p.status, b.check_out DESC
        """,
        affiliate_id,
    )

    lines = [
        BookingPayoutLine(
            payout_id=str(r["payout_id"]),
            booking_id=str(r["booking_id"]),
            booking_reference=r["booking_reference"] or "",
            guest_name=r["guest_name"] or "",
            check_in=r["check_in"].isoformat() if r["check_in"] else "",
            check_out=r["check_out"].isoformat() if r["check_out"] else "",
            booking_total=float(r["booking_total"]) if r["booking_total"] is not None else 0.0,
            commission=float(r["amount"]),
            currency=r["currency"],
            status=r["status"],
            scheduled_for=r["scheduled_for"].isoformat() if r["scheduled_for"] else None,
            completed_at=r["completed_at"].isoformat() if r["completed_at"] else None,
            payment_method=r["payout_payment_method"],
            external_reference=r["external_reference"],
        )
        for r in booking_rows
    ]

    history_rows = await Database.fetch(
        """
        SELECT
            DATE_TRUNC('second', completed_at) AS completed_at,
            payment_method,
            external_reference,
            notes,
            SUM(amount)::numeric AS amount,
            MIN(currency)        AS currency,
            COUNT(*)             AS booking_count
        FROM payouts
        WHERE recipient_type = 'affiliate'
          AND recipient_id = $1
          AND status = 'completed'
        GROUP BY DATE_TRUNC('second', completed_at), payment_method, external_reference, notes
        ORDER BY DATE_TRUNC('second', completed_at) DESC
        """,
        affiliate_id,
    )

    history = [
        PayoutHistoryEntry(
            completed_at=r["completed_at"].isoformat(),
            payment_method=r["payment_method"] or "manual",
            external_reference=r["external_reference"],
            notes=r["notes"],
            amount=float(r["amount"]),
            currency=r["currency"] or "EUR",
            booking_count=int(r["booking_count"]),
        )
        for r in history_rows
    ]

    outstanding = sum(line.commission for line in lines if line.status != "completed")
    paid = sum(line.commission for line in lines if line.status == "completed")

    return {
        "affiliate": {
            "id": str(affiliate["id"]),
            "fullName": affiliate["full_name"],
            "email": affiliate["email"],
            "hotelId": str(affiliate["hotel_id"]),
            "hotelName": affiliate["hotel_name"],
            "hotelSlug": affiliate["hotel_slug"],
            "paymentMethod": affiliate["payment_method"] or "",
            "paypalEmail": affiliate["paypal_email"] or "",
            "bankAccountHolder": affiliate["bank_account_holder"] or "",
            "bankIban": affiliate["bank_iban"] or "",
            "bankSwiftBic": affiliate["bank_swift_bic"] or "",
            "bankName": affiliate["bank_name"] or "",
            "bankCountry": affiliate["bank_country"] or "",
            "stripeConnectAccountId": affiliate["stripe_connect_account_id"],
            "stripeConnectOnboarded": bool(affiliate["stripe_connect_onboarded"]),
        },
        "outstandingAmount": float(outstanding),
        "paidAmount": float(paid),
        "lines": lines,
        "history": history,
    }


@router.post("/affiliate-payouts/{affiliate_id}/mark-paid")
async def mark_affiliate_paid(
    affiliate_id: str,
    data: MarkPaidRequest,
    user_id: str = Depends(require_super_admin),
):
    """Mark every unpaid payout row for this affiliate as completed,
    stamping the manual payment method, reference, and notes. Returns
    the affiliate id, the total amount marked paid, and the row count.
    """
    affiliate = await Database.fetchrow(
        "SELECT id FROM affiliates WHERE id = $1", affiliate_id
    )
    if not affiliate:
        raise HTTPException(status_code=404, detail="Affiliate not found")

    rows = await Database.fetch(
        """
        UPDATE payouts
        SET status = 'completed',
            completed_at = now(),
            payment_method = $2,
            external_reference = $3,
            notes = $4,
            paid_by_user_id = $5,
            updated_at = now()
        WHERE recipient_type = 'affiliate'
          AND recipient_id = $1
          AND status IN ('scheduled', 'processing', 'failed')
        RETURNING amount, currency
        """,
        affiliate_id,
        data.payment_method,
        data.external_reference,
        data.notes,
        user_id,
    )

    if not rows:
        raise HTTPException(
            status_code=400,
            detail="No outstanding payouts to mark paid for this affiliate",
        )

    total = sum(float(r["amount"]) for r in rows)
    currency = rows[0]["currency"]

    return {
        "affiliateId": affiliate_id,
        "rowCount": len(rows),
        "amount": total,
        "currency": currency,
    }
