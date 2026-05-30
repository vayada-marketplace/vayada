"""
vayada-staff-only route for listing every booking across the platform.

Used by the Vayada admin (admin.vayada.com) to review booking
requests and their accept/reject history in one place.
"""

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict

from app.database import Database
from app.dependencies import require_super_admin

router = APIRouter(prefix="/super-admin", tags=["super-admin-bookings"])


def to_camel(string: str) -> str:
    parts = string.split("_")
    return parts[0] + "".join(w.capitalize() for w in parts[1:])


class SuperAdminBookingRow(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    booking_reference: str
    hotel_id: str
    hotel_name: str
    hotel_slug: str
    guest_name: str
    guest_email: str
    check_in: str
    check_out: str
    nights: int
    total_amount: float
    currency: str
    status: str  # 'pending' | 'accepted' | 'rejected' | 'withdrawn'
    raw_status: str  # original bookings.status value
    channel: str
    requested_at: str
    responded_at: str | None = None


def _map_status(raw_status: str, guest_withdrawn: bool) -> str:
    if raw_status == "pending":
        return "pending"
    if raw_status == "confirmed":
        return "accepted"
    # VAY-404: 'declined' is the canonical host-rejected status. Legacy rows
    # that landed in 'cancelled' before the migration keep working — those
    # with guest_withdrawn=false were also host rejections.
    if raw_status == "declined":
        return "rejected"
    if raw_status == "cancelled":
        return "withdrawn" if guest_withdrawn else "rejected"
    return raw_status


@router.get("/bookings", response_model=dict)
async def list_all_bookings(
    user_id: str = Depends(require_super_admin),
    status: str | None = Query(
        None,
        description="Filter by derived status: pending | accepted | rejected | withdrawn",
    ),
    limit: int = Query(200, ge=1, le=1000),
    offset: int = Query(0, ge=0),
):
    """Every booking across every hotel, newest first.

    `requested_at` is `bookings.created_at`. `responded_at` is
    `bookings.updated_at` when the booking has left the pending state
    — it is the best proxy for when the host accepted or rejected the
    request (status transitions always touch updated_at).
    """
    rows = await Database.fetch(
        """
        SELECT
            b.id,
            b.booking_reference,
            b.hotel_id,
            h.name AS hotel_name,
            h.slug AS hotel_slug,
            b.guest_first_name,
            b.guest_last_name,
            b.guest_email,
            b.check_in,
            b.check_out,
            b.total_amount,
            b.currency,
            b.status,
            b.guest_withdrawn,
            b.channel,
            b.created_at,
            b.updated_at
        FROM bookings b
        JOIN hotels h ON h.id = b.hotel_id
        ORDER BY b.created_at DESC
        LIMIT $1 OFFSET $2
        """,
        limit,
        offset,
    )

    bookings: list[SuperAdminBookingRow] = []
    for r in rows:
        derived = _map_status(r["status"], r["guest_withdrawn"])
        if status and derived != status:
            continue
        ci = r["check_in"]
        co = r["check_out"]
        responded_at = r["updated_at"] if r["status"] != "pending" else None
        bookings.append(
            SuperAdminBookingRow(
                id=str(r["id"]),
                booking_reference=r["booking_reference"],
                hotel_id=str(r["hotel_id"]),
                hotel_name=r["hotel_name"],
                hotel_slug=r["hotel_slug"],
                guest_name=f"{r['guest_first_name']} {r['guest_last_name']}".strip(),
                guest_email=r["guest_email"],
                check_in=str(ci),
                check_out=str(co),
                nights=(co - ci).days,
                total_amount=float(r["total_amount"]),
                currency=r["currency"],
                status=derived,
                raw_status=r["status"],
                channel=r.get("channel") or "direct",
                requested_at=r["created_at"].isoformat(),
                responded_at=responded_at.isoformat() if responded_at else None,
            )
        )

    return {"bookings": bookings}
