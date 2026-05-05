import asyncio
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends, Query
from pydantic import BaseModel

from app.dependencies import require_hotel_admin
from app.utils import get_hotel_id
from app.repositories.room_type_repo import RoomTypeRepository
from app.repositories.booking_repo import BookingRepository
from app.repositories.booking_event_repo import BookingEventRepository
from app.repositories.room_repo import RoomRepository
from app.repositories.payout_repo import PayoutRepository
from app.models.booking import BookingAdminResponse, BookingStatusUpdate, BookingDetailsUpdate, AdminBookingCreate, BookingRoomAssign, BookingRoomSwap
from app.models.payment import PayoutResponse
from app.services.email_service import send_guest_confirmation, send_guest_cancellation, send_guest_admin_booking_confirmed
from app.services.booking_service import host_accept_booking, host_reject_booking
from app.services.channex_sync_service import push_availability_for_room_type

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
        guest_country=b.get("guest_country") or "",
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
            "guest_country": data.guest_country,
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

    # Push updated availability to Channex (only affected dates)
    asyncio.create_task(
        push_availability_for_room_type(
            hotel_id, str(room["room_type_id"]),
            start_date=data.check_in, end_date=data.check_out,
        )
    )

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


@router.patch("/bookings/{booking_id}", response_model=BookingAdminResponse)
async def update_booking_details(
    booking_id: str,
    data: BookingDetailsUpdate,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    booking = await BookingRepository.get_by_id(booking_id)
    if not booking or str(booking["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Booking not found")

    updates = data.model_dump(exclude_none=True)
    updated = await BookingRepository.update_details(booking_id, updates)
    if not updated:
        raise HTTPException(status_code=404, detail="Booking not found")

    # Push availability if dates changed (cover both old and new date ranges)
    if data.check_in is not None or data.check_out is not None:
        old_start = booking["check_in"]
        old_end = booking["check_out"]
        new_start = data.check_in or old_start
        new_end = data.check_out or old_end
        asyncio.create_task(
            push_availability_for_room_type(
                hotel_id, str(booking["room_type_id"]),
                start_date=min(old_start, new_start),
                end_date=max(old_end, new_end),
            )
        )

    return _booking_to_admin(updated)


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

    # Push availability to Channex (only affected dates)
    asyncio.create_task(
        push_availability_for_room_type(
            hotel_id, str(booking["room_type_id"]),
            start_date=booking["check_in"], end_date=booking["check_out"],
        )
    )

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


@router.patch("/bookings/{booking_id}/move-room", response_model=BookingAdminResponse)
async def move_booking_to_room(
    booking_id: str,
    data: BookingRoomAssign,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    booking = await BookingRepository.get_by_id(booking_id)
    if not booking or str(booking["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Booking not found")

    if booking["status"] == "cancelled":
        raise HTTPException(
            status_code=400,
            detail="Cancelled bookings cannot be moved",
        )

    current_room_id = str(booking["room_id"]) if booking.get("room_id") else None
    if current_room_id == data.room_id:
        raise HTTPException(
            status_code=400,
            detail="Booking is already assigned to this room",
        )

    room = await RoomRepository.get_by_id(data.room_id)
    if not room or str(room["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Room not found")
    if str(room["room_type_id"]) != str(booking["room_type_id"]):
        raise HTTPException(
            status_code=400,
            detail="Room does not belong to the same room type as the booking",
        )

    available = await BookingRepository.is_room_available(
        data.room_id,
        booking["check_in"],
        booking["check_out"],
        exclude_booking_id=booking_id,
    )
    if not available:
        raise HTTPException(
            status_code=409,
            detail="Room is not available for the booking dates",
        )

    await BookingRepository.assign_room(booking_id, data.room_id)
    await BookingEventRepository.record(
        booking_id=booking_id,
        hotel_id=hotel_id,
        event_type="room_moved",
        payload={
            "from_room_id": current_room_id,
            "to_room_id": data.room_id,
        },
        actor_user_id=user_id,
    )

    asyncio.create_task(
        push_availability_for_room_type(
            hotel_id,
            str(booking["room_type_id"]),
            start_date=booking["check_in"],
            end_date=booking["check_out"],
        )
    )

    updated = await BookingRepository.get_by_id(booking_id)
    return _booking_to_admin(updated)


@router.patch("/bookings/{booking_id}/unassign-room", response_model=BookingAdminResponse)
async def unassign_booking_room(
    booking_id: str,
    user_id: str = Depends(require_hotel_admin),
):
    """Push an assigned booking back to Unassigned (clears room_id).

    Used by the calendar's room picker when the user wants to free a room so a
    different (currently unassigned) booking can be placed there. The displaced
    booking simply joins the Unassigned row and can be reassigned later.
    """
    hotel_id = await get_hotel_id(user_id)
    booking = await BookingRepository.get_by_id(booking_id)
    if not booking or str(booking["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Booking not found")

    if booking["status"] not in ("pending", "confirmed"):
        raise HTTPException(
            status_code=400,
            detail="Only pending or confirmed bookings can be unassigned",
        )

    current_room_id = str(booking["room_id"]) if booking.get("room_id") else None
    if not current_room_id:
        raise HTTPException(
            status_code=400,
            detail="Booking is already unassigned",
        )

    await BookingRepository.unassign_room(booking_id)
    await BookingEventRepository.record(
        booking_id=booking_id,
        hotel_id=hotel_id,
        event_type="room_unassigned",
        payload={"from_room_id": current_room_id},
        actor_user_id=user_id,
    )

    asyncio.create_task(
        push_availability_for_room_type(
            hotel_id,
            str(booking["room_type_id"]),
            start_date=booking["check_in"],
            end_date=booking["check_out"],
        )
    )

    updated = await BookingRepository.get_by_id(booking_id)
    return _booking_to_admin(updated)


@router.patch("/bookings/{booking_id}/swap-room", response_model=BookingAdminResponse)
async def swap_booking_rooms(
    booking_id: str,
    data: BookingRoomSwap,
    user_id: str = Depends(require_hotel_admin),
):
    """Swap room assignments between two reservations.

    Two-way swap: source booking takes partner's current room and vice versa.
    Unassigned-source case: source takes partner's room and partner moves to a
    free room provided in `partner_destination_room_id`. Both updates happen
    atomically in one SQL statement so the swap can never half-apply.
    """
    if data.partner_booking_id == booking_id:
        raise HTTPException(
            status_code=400,
            detail="Cannot swap a booking with itself",
        )

    hotel_id = await get_hotel_id(user_id)

    source = await BookingRepository.get_by_id(booking_id)
    if not source or str(source["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Booking not found")

    partner = await BookingRepository.get_by_id(data.partner_booking_id)
    if not partner or str(partner["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Partner booking not found")

    # Both bookings must be in a swappable status. Cancelled is excluded
    # outright; checked-in/checked-out are deferred to a future iteration.
    SWAPPABLE_STATUSES = {"pending", "confirmed"}
    for label, b in (("source", source), ("partner", partner)):
        if b["status"] not in SWAPPABLE_STATUSES:
            raise HTTPException(
                status_code=400,
                detail=f"{label.capitalize()} booking is not in a swappable status",
            )

    # v1 only swaps within the same room type — the move-room endpoint
    # already enforces this and rate-plan implications of cross-type moves
    # are out of scope for this ticket.
    if str(source["room_type_id"]) != str(partner["room_type_id"]):
        raise HTTPException(
            status_code=400,
            detail="Bookings must belong to the same room type to swap",
        )

    source_room_id = str(source["room_id"]) if source.get("room_id") else None
    partner_room_id = str(partner["room_id"]) if partner.get("room_id") else None

    if not partner_room_id:
        raise HTTPException(
            status_code=400,
            detail="Partner booking has no room assigned — nothing to swap",
        )

    # Determine target room for each booking.
    new_source_room_id = partner_room_id
    if source_room_id:
        # Standard 2-way swap: partner takes source's room.
        new_partner_room_id = source_room_id
        if data.partner_destination_room_id and data.partner_destination_room_id != source_room_id:
            raise HTTPException(
                status_code=400,
                detail="partnerDestinationRoomId is only used when source is unassigned",
            )
    else:
        # Unassigned source: partner must move to a free room provided by caller.
        if not data.partner_destination_room_id:
            raise HTTPException(
                status_code=400,
                detail="partnerDestinationRoomId is required when source booking is unassigned",
            )
        new_partner_room_id = data.partner_destination_room_id
        # The free room must belong to this hotel and the same room type.
        free_room = await RoomRepository.get_by_id(new_partner_room_id)
        if not free_room or str(free_room["hotel_id"]) != hotel_id:
            raise HTTPException(status_code=404, detail="Destination room not found")
        if str(free_room["room_type_id"]) != str(partner["room_type_id"]):
            raise HTTPException(
                status_code=400,
                detail="Destination room does not belong to the same room type",
            )

    if new_source_room_id == source_room_id and new_partner_room_id == partner_room_id:
        raise HTTPException(
            status_code=400,
            detail="Swap is a no-op — bookings already in target rooms",
        )

    # Conflict check: after the swap, neither room may overlap any other booking.
    # Both bookings are excluded from each room's check because they are the
    # ones moving.
    excluded = [booking_id, data.partner_booking_id]
    source_room_ok = await BookingRepository.is_room_available_excluding(
        new_source_room_id, source["check_in"], source["check_out"], excluded,
    )
    if not source_room_ok:
        raise HTTPException(
            status_code=409,
            detail="Target room for source booking has a conflict",
        )
    partner_room_ok = await BookingRepository.is_room_available_excluding(
        new_partner_room_id, partner["check_in"], partner["check_out"], excluded,
    )
    if not partner_room_ok:
        raise HTTPException(
            status_code=409,
            detail="Target room for partner booking has a conflict",
        )

    # Atomic two-row update.
    await BookingRepository.swap_room_assignments(
        booking_id, new_source_room_id,
        data.partner_booking_id, new_partner_room_id,
    )

    # Audit: one event per booking, each pointing at the other.
    await BookingEventRepository.record(
        booking_id=booking_id,
        hotel_id=hotel_id,
        event_type="room_swapped",
        payload={
            "from_room_id": source_room_id,
            "to_room_id": new_source_room_id,
            "paired_booking_id": data.partner_booking_id,
        },
        actor_user_id=user_id,
    )
    await BookingEventRepository.record(
        booking_id=data.partner_booking_id,
        hotel_id=hotel_id,
        event_type="room_swapped",
        payload={
            "from_room_id": partner_room_id,
            "to_room_id": new_partner_room_id,
            "paired_booking_id": booking_id,
        },
        actor_user_id=user_id,
    )

    # Push availability for the affected room type. Same room type for both
    # bookings (enforced above), and Channex tracks availability per type, so
    # one push covering the union of both date ranges is sufficient.
    asyncio.create_task(
        push_availability_for_room_type(
            hotel_id,
            str(source["room_type_id"]),
            start_date=min(source["check_in"], partner["check_in"]),
            end_date=max(source["check_out"], partner["check_out"]),
        )
    )

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


class RejectBookingRequest(BaseModel):
    reason: str | None = None

@router.post("/bookings/{booking_id}/reject", response_model=BookingAdminResponse)
async def reject_booking(
    booking_id: str,
    body: RejectBookingRequest = RejectBookingRequest(),
    user_id: str = Depends(require_hotel_admin),
):
    try:
        updated = await host_reject_booking(booking_id, user_id, reason=body.reason)
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
