"""
Derive invoice views from booking + payment rows.

Each booking is treated as an invoice. The invoice number is stable across
restarts because it is derived from the booking's created_at year and the
last 4 chars of its booking_reference.

Manual invoices not tied to a booking are tracked in VAY-301.
"""
from datetime import date, datetime, timezone
from typing import Dict, Iterable, List, Optional, Tuple

from app.models.financials import (
    InvoiceCharge,
    InvoiceDetail,
    InvoiceListItem,
    InvoicePayment,
    PaymentLedgerEntry,
)


PAYMENT_METHOD_LABELS = {
    "card": "Card",
    "pay_at_property": "Pay at Property",
    "cash": "Cash",
    "bank_transfer": "Bank Transfer",
    "manual_card": "Card (Manual)",
    "other": "Other",
}

# Payment statuses that count toward the paid amount on an invoice.
PAID_STATUSES = {"captured", "authorized"}


def invoice_number(booking: dict) -> str:
    """`INV-YYYY-XXXX` — year of created_at + last 4 of booking_reference."""
    created = booking.get("created_at")
    year = created.year if isinstance(created, datetime) else datetime.now(timezone.utc).year
    ref = (booking.get("booking_reference") or "")[-4:].upper() or "0000"
    return f"INV-{year}-{ref}"


def _amount_paid(payments: Iterable[dict]) -> float:
    return round(sum(float(p["amount"]) for p in payments if p.get("status") in PAID_STATUSES), 2)


def derive_status(booking: dict, amount_paid: float, today: Optional[date] = None) -> str:
    """draft | sent | paid | partial | overdue | voided"""
    today = today or date.today()
    status = booking.get("status")
    if status in ("cancelled", "expired"):
        return "voided"
    total = float(booking.get("total_amount") or 0)
    if status == "pending":
        return "draft"
    if amount_paid >= total and total > 0:
        return "paid"
    check_in = booking.get("check_in")
    if isinstance(check_in, date) and check_in < today and amount_paid < total:
        return "overdue"
    if amount_paid > 0 and amount_paid < total:
        return "partial"
    return "sent"


def build_charges(booking: dict) -> List[InvoiceCharge]:
    """Build charge line items from a booking row.

    Tax / service-charge breakdown is intentionally omitted — see VAY-304.
    """
    charges: List[InvoiceCharge] = []

    ci: date = booking["check_in"]
    co: date = booking["check_out"]
    nights = max(1, (co - ci).days)
    nightly_rate = float(booking["nightly_rate"])
    room_name = booking.get("room_name", "Room")
    currency = booking["currency"]
    accommodation_total = round(nightly_rate * nights, 2)
    charges.append(
        InvoiceCharge(
            description=f"{room_name} — {nights} night{'s' if nights != 1 else ''}",
            detail=f"Accommodation · {ci.strftime('%b %-d')}–{co.strftime('%b %-d')} · {nights} × {currency} {nightly_rate:.2f}",
            amount=accommodation_total,
        )
    )

    addon_names = booking.get("addon_names") or []
    addon_ids = booking.get("addon_ids") or []
    addon_quantities = booking.get("addon_quantities") or {}
    addon_total = float(booking.get("addon_total") or 0)

    if addon_total > 0:
        if addon_names and len(addon_names) == len(addon_ids):
            count = len(addon_ids)
            per_item = round(addon_total / count, 2) if count else 0
            for idx, addon_id in enumerate(addon_ids):
                qty = addon_quantities.get(addon_id) or addon_quantities.get(str(addon_id)) or 1
                charges.append(
                    InvoiceCharge(
                        description=str(addon_names[idx]),
                        detail=f"Add-on · {qty} unit{'s' if qty != 1 else ''}",
                        amount=per_item,
                    )
                )
        else:
            charges.append(
                InvoiceCharge(
                    description="Add-ons",
                    detail=f"{len(addon_ids)} item(s)" if addon_ids else "",
                    amount=addon_total,
                )
            )

    promo_discount = float(booking.get("promo_discount") or 0)
    if promo_discount > 0:
        charges.append(
            InvoiceCharge(
                description="Promo discount",
                detail=str(booking.get("promo_code") or ""),
                amount=-promo_discount,
            )
        )

    last_min_discount = float(booking.get("last_minute_discount_amount") or 0)
    if last_min_discount > 0:
        charges.append(
            InvoiceCharge(
                description="Last-minute discount",
                detail="",
                amount=-last_min_discount,
            )
        )

    return charges


def to_payment(payment: dict) -> InvoicePayment:
    method = payment.get("payment_method") or "other"
    return InvoicePayment(
        id=str(payment["id"]),
        method=method,
        method_label=PAYMENT_METHOD_LABELS.get(method, method.replace("_", " ").title()),
        amount=float(payment["amount"]),
        currency=payment["currency"],
        reference=payment.get("reference"),
        status=payment["status"],
        recorded_at=payment["created_at"].isoformat(),
    )


def to_list_item(booking: dict, payments: List[dict]) -> InvoiceListItem:
    paid = _amount_paid(payments)
    total = float(booking["total_amount"])
    status = derive_status(booking, paid)
    return InvoiceListItem(
        id=str(booking["id"]),
        invoice_number=invoice_number(booking),
        booking_id=str(booking["id"]),
        booking_reference=booking["booking_reference"],
        guest_first_name=booking["guest_first_name"],
        guest_last_name=booking["guest_last_name"],
        guest_email=booking["guest_email"],
        check_in=str(booking["check_in"]),
        check_out=str(booking["check_out"]),
        room_number=booking.get("room_number"),
        room_name=booking.get("room_name", "Room"),
        currency=booking["currency"],
        total_amount=total,
        amount_paid=paid,
        balance_due=round(total - paid, 2),
        status=status,
        issued_at=booking["created_at"].isoformat(),
    )


def to_detail(booking: dict, payments: List[dict]) -> InvoiceDetail:
    paid = _amount_paid(payments)
    total = float(booking["total_amount"])
    charges = build_charges(booking)
    subtotal = round(sum(c.amount for c in charges), 2)
    nights = max(1, (booking["check_out"] - booking["check_in"]).days)
    return InvoiceDetail(
        id=str(booking["id"]),
        invoice_number=invoice_number(booking),
        booking_id=str(booking["id"]),
        booking_reference=booking["booking_reference"],
        guest_first_name=booking["guest_first_name"],
        guest_last_name=booking["guest_last_name"],
        guest_email=booking["guest_email"],
        guest_phone=booking.get("guest_phone", ""),
        room_number=booking.get("room_number"),
        room_name=booking.get("room_name", "Room"),
        check_in=str(booking["check_in"]),
        check_out=str(booking["check_out"]),
        nights=nights,
        currency=booking["currency"],
        charges=charges,
        subtotal=subtotal,
        total_amount=total,
        payments=[to_payment(p) for p in payments],
        amount_paid=paid,
        balance_due=round(total - paid, 2),
        status=derive_status(booking, paid),
        issued_at=booking["created_at"].isoformat(),
    )


def to_ledger_entry(payment: dict, booking: dict) -> PaymentLedgerEntry:
    method = payment.get("payment_method") or "other"
    return PaymentLedgerEntry(
        id=str(payment["id"]),
        invoice_number=invoice_number(booking),
        booking_id=str(booking["id"]),
        booking_reference=booking["booking_reference"],
        guest_first_name=booking["guest_first_name"],
        guest_last_name=booking["guest_last_name"],
        method=method,
        method_label=PAYMENT_METHOD_LABELS.get(method, method.replace("_", " ").title()),
        amount=float(payment["amount"]),
        currency=payment["currency"],
        reference=payment.get("reference"),
        status=payment["status"],
        recorded_at=payment["created_at"].isoformat(),
    )


def derive_payment_status(total: float, amount_paid: float) -> str:
    """Map invoice paid total → bookings.payment_status enum value."""
    if amount_paid <= 0:
        return "unpaid"
    if amount_paid + 0.01 < total:
        # Bookings table doesn't have a 'partial' enum value — `authorized`
        # is the closest match in the existing CHECK constraint.
        return "authorized"
    return "captured"


def index_payments_by_booking(payments: List[dict]) -> Dict[str, List[dict]]:
    grouped: Dict[str, List[dict]] = {}
    for p in payments:
        bid = str(p["booking_id"])
        grouped.setdefault(bid, []).append(p)
    return grouped


def filter_invoices_by_status(
    items: List[Tuple[dict, List[dict]]], status: Optional[str], today: Optional[date] = None
) -> List[Tuple[dict, List[dict]]]:
    if not status:
        return items
    filtered = []
    for booking, payments in items:
        if derive_status(booking, _amount_paid(payments), today) == status:
            filtered.append((booking, payments))
    return filtered


def status_counts(items: List[Tuple[dict, List[dict]]], today: Optional[date] = None) -> Dict[str, int]:
    counts: Dict[str, int] = {"draft": 0, "sent": 0, "paid": 0, "partial": 0, "overdue": 0, "voided": 0}
    for booking, payments in items:
        s = derive_status(booking, _amount_paid(payments), today)
        counts[s] = counts.get(s, 0) + 1
    return counts
