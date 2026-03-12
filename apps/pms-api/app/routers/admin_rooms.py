import json
import logging
from typing import List
from datetime import date

from fastapi import APIRouter, HTTPException, Depends, Query

from app.dependencies import require_hotel_admin
from app.utils import parse_jsonb, get_hotel_id
from app.repositories.room_type_repo import RoomTypeRepository
from app.repositories.booking_repo import BookingRepository
from app.repositories.room_block_repo import RoomBlockRepository
from app.repositories.room_repo import RoomRepository
from app.models.room_type import (
    RoomTypeCreate,
    RoomTypeUpdate,
    RoomTypeAdminResponse,
    MonthlyRate,
)
from app.models.room import RoomCreate, RoomUpdate, RoomResponse
from app.models.room_block import RoomBlockCreate, RoomBlockResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["admin-rooms"])


def _parse_monthly_rates(val) -> dict:
    raw = val if val else {}
    if isinstance(raw, str):
        raw = json.loads(raw)
    result = {}
    for k, v in raw.items():
        result[k] = MonthlyRate(
            base_rate=v.get("base_rate"),
            non_refundable_rate=v.get("non_refundable_rate"),
        )
    return result


def _room_to_admin(room: dict) -> RoomTypeAdminResponse:
    nr_rate = room.get("non_refundable_rate")
    return RoomTypeAdminResponse(
        id=str(room["id"]),
        hotel_id=str(room["hotel_id"]),
        name=room["name"],
        description=room["description"],
        short_description=room["short_description"],
        max_occupancy=room["max_occupancy"],
        size=room["size"],
        base_rate=float(room["base_rate"]),
        non_refundable_rate=float(nr_rate) if nr_rate is not None else None,
        currency=room["currency"],
        amenities=parse_jsonb(room["amenities"]),
        images=parse_jsonb(room["images"]),
        bed_type=room["bed_type"],
        features=parse_jsonb(room["features"]),
        benefits=parse_jsonb(room.get("benefits", [])),
        total_rooms=room["total_rooms"],
        is_active=room["is_active"],
        sort_order=room["sort_order"],
        monthly_rates=_parse_monthly_rates(room.get("monthly_rates")),
        created_at=room["created_at"].isoformat(),
        updated_at=room["updated_at"].isoformat(),
    )


def _room_to_response(r: dict) -> RoomResponse:
    return RoomResponse(
        id=str(r["id"]),
        hotel_id=str(r["hotel_id"]),
        room_type_id=str(r["room_type_id"]),
        room_type_name=r["room_type_name"],
        room_number=r["room_number"],
        floor=r["floor"],
        status=r["status"],
        sort_order=r["sort_order"],
        created_at=r["created_at"].isoformat(),
        updated_at=r["updated_at"].isoformat(),
    )


# ── Room Types ──────────────────────────────────────────────────────


@router.get("/room-types", response_model=List[RoomTypeAdminResponse])
async def list_room_types(user_id: str = Depends(require_hotel_admin)):
    hotel_id = await get_hotel_id(user_id)
    rooms = await RoomTypeRepository.list_by_hotel_id(hotel_id)
    return [_room_to_admin(r) for r in rooms]


@router.post("/room-types", response_model=RoomTypeAdminResponse, status_code=201)
async def create_room_type(
    data: RoomTypeCreate,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    payload = data.model_dump()
    if payload.get("monthly_rates"):
        payload["monthly_rates"] = {
            k: v.model_dump(exclude_none=True) if hasattr(v, "model_dump") else {kk: vv for kk, vv in v.items() if vv is not None}
            for k, v in payload["monthly_rates"].items()
        }
    else:
        payload["monthly_rates"] = {}
    room = await RoomTypeRepository.create(hotel_id, payload)
    return _room_to_admin(room)


@router.get("/room-types/{room_type_id}", response_model=RoomTypeAdminResponse)
async def get_room_type(
    room_type_id: str,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
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
    hotel_id = await get_hotel_id(user_id)
    existing = await RoomTypeRepository.get_by_id(room_type_id)
    if not existing or str(existing["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Room type not found")

    updates = data.model_dump(exclude_unset=True)
    if "monthly_rates" in updates and updates["monthly_rates"] is not None:
        updates["monthly_rates"] = {
            k: {kk: vv for kk, vv in v.items() if vv is not None}
            for k, v in updates["monthly_rates"].items()
        }
    room = await RoomTypeRepository.update(room_type_id, updates)
    return _room_to_admin(room)


@router.delete("/room-types/{room_type_id}", status_code=204)
async def delete_room_type(
    room_type_id: str,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
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


# ── Rooms (individual) ─────────────────────────────────────────────


@router.get("/rooms", response_model=List[RoomResponse])
async def list_rooms(user_id: str = Depends(require_hotel_admin)):
    hotel_id = await get_hotel_id(user_id)
    rooms = await RoomRepository.list_by_hotel_id(hotel_id)
    return [_room_to_response(r) for r in rooms]


@router.post("/rooms", response_model=RoomResponse, status_code=201)
async def create_room(
    data: RoomCreate,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)

    # Validate room type belongs to hotel
    room_type = await RoomTypeRepository.get_by_id(data.room_type_id)
    if not room_type or str(room_type["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Room type not found")

    if data.status not in ("available", "maintenance", "out_of_order"):
        raise HTTPException(
            status_code=400,
            detail="Status must be 'available', 'maintenance', or 'out_of_order'",
        )

    try:
        room = await RoomRepository.create(
            {
                "hotel_id": hotel_id,
                "room_type_id": data.room_type_id,
                "room_number": data.room_number,
                "floor": data.floor,
                "status": data.status,
                "sort_order": data.sort_order,
            }
        )
    except Exception:
        raise HTTPException(
            status_code=409,
            detail="A room with this number already exists",
        )
    return _room_to_response(room)


@router.patch("/rooms/{room_id}", response_model=RoomResponse)
async def update_room(
    room_id: str,
    data: RoomUpdate,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    existing = await RoomRepository.get_by_id(room_id)
    if not existing or str(existing["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Room not found")

    updates = data.model_dump(exclude_unset=True)
    if "status" in updates and updates["status"] not in (
        "available", "maintenance", "out_of_order"
    ):
        raise HTTPException(
            status_code=400,
            detail="Status must be 'available', 'maintenance', or 'out_of_order'",
        )

    room = await RoomRepository.update(room_id, updates)
    return _room_to_response(room)


@router.delete("/rooms/{room_id}", status_code=204)
async def delete_room(
    room_id: str,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    existing = await RoomRepository.get_by_id(room_id)
    if not existing or str(existing["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Room not found")

    try:
        await RoomRepository.delete(room_id)
    except Exception:
        raise HTTPException(
            status_code=409,
            detail="Cannot delete room with existing bookings",
        )


# ── Calendar ───────────────────────────────────────────────────────


@router.get("/calendar")
async def get_calendar(
    start: date = Query(...),
    end: date = Query(...),
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    room_types = await RoomTypeRepository.list_by_hotel_id(hotel_id)
    rooms = await RoomRepository.list_by_hotel_id(hotel_id)
    bookings = await BookingRepository.list_by_hotel_in_range(hotel_id, start, end)
    blocks = await RoomBlockRepository.list_by_hotel_in_range(hotel_id, start, end)

    return {
        "roomTypes": [
            {
                "id": str(rt["id"]),
                "name": rt["name"],
                "totalRooms": rt["total_rooms"],
                "baseRate": float(rt["base_rate"]),
                "currency": rt["currency"],
            }
            for rt in room_types
        ],
        "rooms": [
            {
                "id": str(r["id"]),
                "roomTypeId": str(r["room_type_id"]),
                "roomTypeName": r["room_type_name"],
                "roomNumber": r["room_number"],
                "floor": r["floor"],
                "status": r["status"],
            }
            for r in rooms
        ],
        "bookings": [
            {
                "id": str(b["id"]),
                "roomTypeId": str(b["room_type_id"]),
                "roomName": b["room_name"],
                "guestFirstName": b["guest_first_name"],
                "guestLastName": b["guest_last_name"],
                "checkIn": str(b["check_in"]),
                "checkOut": str(b["check_out"]),
                "status": b["status"],
                "roomId": str(b["room_id"]) if b.get("room_id") else None,
                "roomNumber": b.get("room_number"),
                "channel": b.get("channel", "direct"),
                "bookingReference": b["booking_reference"],
            }
            for b in bookings
        ],
        "blocks": [
            {
                "id": str(bl["id"]),
                "roomTypeId": str(bl["room_type_id"]),
                "startDate": str(bl["start_date"]),
                "endDate": str(bl["end_date"]),
                "blockedCount": bl["blocked_count"],
                "reason": bl["reason"],
                "createdAt": bl["created_at"].isoformat(),
            }
            for bl in blocks
        ],
    }


# ── Room Blocks ────────────────────────────────────────────────────


@router.post("/room-blocks", response_model=RoomBlockResponse, status_code=201)
async def create_room_block(
    data: RoomBlockCreate,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)

    # Validate room type belongs to hotel
    room = await RoomTypeRepository.get_by_id(data.room_type_id)
    if not room or str(room["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Room type not found")

    if data.blocked_count < 1 or data.blocked_count > room["total_rooms"]:
        raise HTTPException(
            status_code=400,
            detail=f"blocked_count must be between 1 and {room['total_rooms']}",
        )

    if data.end_date <= data.start_date:
        raise HTTPException(
            status_code=400, detail="end_date must be after start_date"
        )

    block = await RoomBlockRepository.create(
        {
            "hotel_id": hotel_id,
            "room_type_id": data.room_type_id,
            "start_date": data.start_date,
            "end_date": data.end_date,
            "blocked_count": data.blocked_count,
            "reason": data.reason,
        }
    )
    return RoomBlockResponse(
        id=str(block["id"]),
        room_type_id=str(block["room_type_id"]),
        start_date=str(block["start_date"]),
        end_date=str(block["end_date"]),
        blocked_count=block["blocked_count"],
        reason=block["reason"],
        created_at=block["created_at"].isoformat(),
    )


@router.delete("/room-blocks/{block_id}", status_code=204)
async def delete_room_block(
    block_id: str,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    block = await RoomBlockRepository.get_by_id(block_id)
    if not block or str(block["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Room block not found")
    await RoomBlockRepository.delete(block_id)
