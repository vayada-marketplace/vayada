import asyncio
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends, Query

from app.dependencies import require_hotel_admin
from app.utils import get_hotel_id
from app.repositories.room_type_repo import RoomTypeRepository
from app.repositories.booking_repo import BookingRepository
from app.repositories.room_repo import RoomRepository
from app.repositories.payout_repo import PayoutRepository
from app.models.booking import BookingAdminResponse, BookingStatusUpdate, AdminBookingCreate, BookingRoomAssign
from app.models.payment import PayoutResponse
from app.services.email_service import send_guest_confirmation, send_guest_cancellation, send_guest_admin_booking_confirmed
from app.services.booking_service import host_accept_booking, host_reject_booking

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["admin-bookings"])


def _booking_to_admin(b: dict) -> BookingAdminResponse:
    ci = b["check_in"]
    co = b["check_out"]
    nights = (co - ci).days
    room_id = b.get("room_id")
    deadline = b.get("host_response_deadline")
    pf = b.get("platform_fee_amount")
    ac = b.get("affiliate_commission_amount")
    pp = b.get("property_payout_amount")
    return BookingAdminResponse(
        id=str(b["id"]),
        booking_reference=b["booking_reference"],
        room_type_id=str(b["room_type_id"]),
        room_name=b["room_name"],
        guest_first_name=b["guest_first_name"],
        guest_last_name=b["guest_last_name"],
        guest_email=b["guest_email"],
        guest_phone=b["guest_phone"],
        special_requests=b["special_requests"],
        check_in=str(ci),
        check_out=str(co),
        nights=nights,
        adults=b["adults"],
        children=b["children"],
        nightly_rate=float(b["nightly_rate"]),
        total_amount=float(b["total_amount"]),
        currency=b["currency"],
        status=b["status"],
        room_id=str(room_id) if room_id else None,
        room_number=b.get("room_number"),
        channel=b.get("channel", "direct"),
        payment_method=b.get("payment_method"),
        payment_status=b.get("payment_status"),
        host_response_deadline=deadline.isoformat() if deadline else None,
        platform_fee_amount=float(pf) if pf is not None else None,
        affiliate_commission_amount=float(ac) if ac is not None else None,
        property_payout_amount=float(pp) if pp is not None else None,
        addon_ids=b.get("addon_ids") or [],
        addon_total=float(b["addon_total"]) if b.get("addon_total") else 0,
        addon_quantities=b.get("addon_quantities") or {},
        guest_withdrawn=b.get("guest_withdrawn", False),
        created_at=b["created_at"].isoformat(),
        updated_at=b["updated_at"].isoformat(),
    )


# ── Bookings ────────────────────────────────────────────────────────


@router.post("/bookings", response_model=BookingAdminResponse, status_code=201)
async def create_admin_booking(
    data: AdminBookingCreate,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)

    # Validate room belongs to hotel
    room = await RoomRepository.get_by_id(data.room_id)
    if not room or str(room["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Room not found")

    # Validate dates
    if data.check_out <= data.check_in:
        raise HTTPException(
            status_code=400, detail="check_out must be after check_in"
        )

    # Check room availability
    available = await BookingRepository.is_room_available(
        data.room_id, data.check_in, data.check_out
    )
    if not available:
        raise HTTPException(
            status_code=409, detail="Room is not available for the selected dates"
        )

    # Get room type for pricing
    room_type = await RoomTypeRepository.get_by_id(str(room["room_type_id"]))
    if data.nightly_rate is not None:
        nightly_rate = data.nightly_rate
    else:
        resolved_base, _ = RoomTypeRepository.resolve_rate(room_type, data.check_in)
        nightly_rate = resolved_base
    nights = (data.check_out - data.check_in).days
    total_amount = nightly_rate * nights

    booking = await BookingRepository.create(
        {
            "hotel_id": hotel_id,
            "room_type_id": str(room["room_type_id"]),
            "guest_first_name": data.guest_first_name,
            "guest_last_name": data.guest_last_name,
            "guest_email": data.guest_email,
            "guest_phone": data.guest_phone,
            "special_requests": data.special_requests,
            "check_in": data.check_in,
            "check_out": data.check_out,
            "adults": data.adults,
            "children": data.children,
            "nightly_rate": nightly_rate,
            "total_amount": total_amount,
            "currency": room_type["currency"],
            "room_id": data.room_id,
            "channel": data.channel,
            "status": "confirmed",
        }
    )

    # Re-fetch with JOINs for full response
    full_booking = await BookingRepository.get_by_id(str(booking["id"]))

    # Notify guest of their confirmed booking
    if full_booking.get("guest_email"):
        asyncio.create_task(
            send_guest_admin_booking_confirmed(full_booking["guest_email"], full_booking)
        )

    return _booking_to_admin(full_booking)


@router.get("/bookings")
async def list_bookings(
    status: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    bookings = await BookingRepository.list_by_hotel_id(
        hotel_id, status=status, search=search, limit=limit, offset=offset
    )
    total = await BookingRepository.count_by_hotel_id(hotel_id, status=status)
    return {
        "bookings": [_booking_to_admin(b) for b in bookings],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


@router.get("/bookings/{booking_id}", response_model=BookingAdminResponse)
async def get_booking(
    booking_id: str,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    booking = await BookingRepository.get_by_id(booking_id)
    if not booking or str(booking["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Booking not found")
    return _booking_to_admin(booking)


@router.patch("/bookings/{booking_id}/status", response_model=BookingAdminResponse)
async def update_booking_status(
    booking_id: str,
    data: BookingStatusUpdate,
    user_id: str = Depends(require_hotel_admin),
):
    if data.status not in ("confirmed", "cancelled"):
        raise HTTPException(
            status_code=400, detail="Status must be 'confirmed' or 'cancelled'"
        )

    hotel_id = await get_hotel_id(user_id)
    booking = await BookingRepository.get_by_id(booking_id)
    if not booking or str(booking["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Booking not found")

    await BookingRepository.update_status(booking_id, data.status)
    updated = await BookingRepository.get_by_id(booking_id)

    # Fire-and-forget: notify guest of status change
    if data.status == "confirmed":
        asyncio.create_task(
            send_guest_confirmation(updated["guest_email"], updated)
        )
    elif data.status == "cancelled":
        asyncio.create_task(
            send_guest_cancellation(updated["guest_email"], updated)
        )

    return _booking_to_admin(updated)


# ── Room Assignment ───────────────────────────────────────────────


@router.patch("/bookings/{booking_id}/assign-room", response_model=BookingAdminResponse)
async def assign_room_to_booking(
    booking_id: str,
    data: BookingRoomAssign,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    booking = await BookingRepository.get_by_id(booking_id)
    if not booking or str(booking["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Booking not found")

    # Validate room belongs to hotel and matches room type
    room = await RoomRepository.get_by_id(data.room_id)
    if not room or str(room["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Room not found")
    if str(room["room_type_id"]) != str(booking["room_type_id"]):
        raise HTTPException(
            status_code=400,
            detail="Room does not belong to the same room type as the booking",
        )

    # Check room availability for the booking dates
    available = await BookingRepository.is_room_available(
        data.room_id, booking["check_in"], booking["check_out"]
    )
    if not available:
        raise HTTPException(
            status_code=409,
            detail="Room is not available for the booking dates",
        )

    await BookingRepository.assign_room(booking_id, data.room_id)
    updated = await BookingRepository.get_by_id(booking_id)
    return _booking_to_admin(updated)


# ── Accept / Reject (new payment flow) ────────────────────────────


@router.post("/bookings/{booking_id}/accept", response_model=BookingAdminResponse)
async def accept_booking(
    booking_id: str,
    user_id: str = Depends(require_hotel_admin),
):
    try:
        updated = await host_accept_booking(booking_id, user_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return _booking_to_admin(updated)


@router.post("/bookings/{booking_id}/reject", response_model=BookingAdminResponse)
async def reject_booking(
    booking_id: str,
    user_id: str = Depends(require_hotel_admin),
):
    try:
        updated = await host_reject_booking(booking_id, user_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return _booking_to_admin(updated)


# ── Payouts ───────────────────────────────────────────────────────


@router.get("/payouts")
async def list_payouts(
    status: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    payouts = await PayoutRepository.list_by_hotel(
        hotel_id, status=status, limit=limit, offset=offset
    )
    total = await PayoutRepository.count_by_hotel(hotel_id, status=status)
    return {
        "payouts": [
            PayoutResponse(
                id=str(p["id"]),
                booking_id=str(p["booking_id"]),
                booking_reference=p.get("booking_reference"),
                recipient_type=p["recipient_type"],
                amount=float(p["amount"]),
                currency=p["currency"],
                status=p["status"],
                scheduled_for=p["scheduled_for"].isoformat(),
                completed_at=p["completed_at"].isoformat() if p.get("completed_at") else None,
            ).model_dump(by_alias=True)
            for p in payouts
        ],
        "total": total,
        "limit": limit,
        "offset": offset,
    }
