import json
import logging
from typing import Optional, List

from fastapi import APIRouter, HTTPException, Depends, Query

from app.dependencies import require_hotel_admin
from app.database import Database
from app.repositories.room_type_repo import RoomTypeRepository
from app.repositories.booking_repo import BookingRepository
from app.models.room_type import (
    RoomTypeCreate,
    RoomTypeUpdate,
    RoomTypeAdminResponse,
)
from app.models.booking import BookingAdminResponse, BookingStatusUpdate
from app.models.hotel import HotelRegister, HotelResponse, SetupStatusResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["admin"])


def _parse_jsonb(val):
    if isinstance(val, str):
        return json.loads(val)
    return val if val else []


async def _get_hotel_id(user_id: str) -> str:
    row = await Database.fetchrow(
        "SELECT id FROM hotels WHERE user_id = $1", user_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="No hotel found for this account")
    return str(row["id"])


def _room_to_admin(room: dict) -> RoomTypeAdminResponse:
    return RoomTypeAdminResponse(
        id=str(room["id"]),
        hotel_id=str(room["hotel_id"]),
        name=room["name"],
        description=room["description"],
        short_description=room["short_description"],
        max_occupancy=room["max_occupancy"],
        size=room["size"],
        base_rate=float(room["base_rate"]),
        currency=room["currency"],
        amenities=_parse_jsonb(room["amenities"]),
        images=_parse_jsonb(room["images"]),
        bed_type=room["bed_type"],
        features=_parse_jsonb(room["features"]),
        total_rooms=room["total_rooms"],
        is_active=room["is_active"],
        sort_order=room["sort_order"],
        created_at=room["created_at"].isoformat(),
        updated_at=room["updated_at"].isoformat(),
    )


def _booking_to_admin(b: dict) -> BookingAdminResponse:
    ci = b["check_in"]
    co = b["check_out"]
    nights = (co - ci).days
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
        created_at=b["created_at"].isoformat(),
        updated_at=b["updated_at"].isoformat(),
    )


# ── Hotel Registration ─────────────────────────────────────────────


@router.post("/register-hotel", response_model=HotelResponse, status_code=201)
async def register_hotel(
    data: HotelRegister,
    user_id: str = Depends(require_hotel_admin),
):
    # Idempotent: return existing hotel if already registered
    existing = await Database.fetchrow(
        "SELECT id, slug, name, contact_email, user_id, created_at FROM hotels WHERE user_id = $1",
        user_id,
    )
    if existing:
        return HotelResponse(
            id=str(existing["id"]),
            slug=existing["slug"],
            name=existing["name"],
            contact_email=existing["contact_email"],
            user_id=str(existing["user_id"]),
            created_at=existing["created_at"].isoformat(),
        )

    row = await Database.fetchrow(
        """INSERT INTO hotels (slug, name, contact_email, user_id)
           VALUES ($1, $2, $3, $4)
           RETURNING id, slug, name, contact_email, user_id, created_at""",
        data.slug,
        data.name,
        data.contact_email,
        user_id,
    )
    return HotelResponse(
        id=str(row["id"]),
        slug=row["slug"],
        name=row["name"],
        contact_email=row["contact_email"],
        user_id=str(row["user_id"]),
        created_at=row["created_at"].isoformat(),
    )


@router.get("/setup-status", response_model=SetupStatusResponse)
async def get_setup_status(
    user_id: str = Depends(require_hotel_admin),
):
    hotel = await Database.fetchrow(
        "SELECT id FROM hotels WHERE user_id = $1", user_id
    )
    if not hotel:
        return SetupStatusResponse(registered=False, setup_complete=False, room_count=0)

    hotel_id = str(hotel["id"])
    room_count = await Database.fetchval(
        "SELECT COUNT(*) FROM room_types WHERE hotel_id = $1", hotel_id
    )
    return SetupStatusResponse(
        registered=True,
        setup_complete=room_count > 0,
        room_count=room_count,
    )


# ── Room Types ──────────────────────────────────────────────────────


@router.get("/room-types", response_model=List[RoomTypeAdminResponse])
async def list_room_types(user_id: str = Depends(require_hotel_admin)):
    hotel_id = await _get_hotel_id(user_id)
    rooms = await RoomTypeRepository.list_by_hotel_id(hotel_id)
    return [_room_to_admin(r) for r in rooms]


@router.post("/room-types", response_model=RoomTypeAdminResponse, status_code=201)
async def create_room_type(
    data: RoomTypeCreate,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await _get_hotel_id(user_id)
    room = await RoomTypeRepository.create(hotel_id, data.model_dump())
    return _room_to_admin(room)


@router.get("/room-types/{room_type_id}", response_model=RoomTypeAdminResponse)
async def get_room_type(
    room_type_id: str,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await _get_hotel_id(user_id)
    room = await RoomTypeRepository.get_by_id(room_type_id)
    if not room or str(room["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Room type not found")
    return _room_to_admin(room)


@router.patch("/room-types/{room_type_id}", response_model=RoomTypeAdminResponse)
async def update_room_type(
    room_type_id: str,
    data: RoomTypeUpdate,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await _get_hotel_id(user_id)
    existing = await RoomTypeRepository.get_by_id(room_type_id)
    if not existing or str(existing["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Room type not found")

    updates = {k: v for k, v in data.model_dump().items() if v is not None}
    room = await RoomTypeRepository.update(room_type_id, updates)
    return _room_to_admin(room)


@router.delete("/room-types/{room_type_id}", status_code=204)
async def delete_room_type(
    room_type_id: str,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await _get_hotel_id(user_id)
    existing = await RoomTypeRepository.get_by_id(room_type_id)
    if not existing or str(existing["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Room type not found")

    try:
        await RoomTypeRepository.delete(room_type_id)
    except Exception:
        raise HTTPException(
            status_code=409,
            detail="Cannot delete room type with existing bookings",
        )


# ── Bookings ────────────────────────────────────────────────────────


@router.get("/bookings")
async def list_bookings(
    status: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await _get_hotel_id(user_id)
    bookings = await BookingRepository.list_by_hotel_id(
        hotel_id, status=status, limit=limit, offset=offset
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
    hotel_id = await _get_hotel_id(user_id)
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

    hotel_id = await _get_hotel_id(user_id)
    booking = await BookingRepository.get_by_id(booking_id)
    if not booking or str(booking["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Booking not found")

    await BookingRepository.update_status(booking_id, data.status)
    updated = await BookingRepository.get_by_id(booking_id)
    return _booking_to_admin(updated)
