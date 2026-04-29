import logging
from typing import List
from datetime import date

from fastapi import APIRouter, HTTPException, Depends, Query

from app.dependencies import require_hotel_admin
from app.utils import get_hotel_id
from app.repositories.room_type_repo import RoomTypeRepository
from app.repositories.booking_repo import BookingRepository
from app.repositories.room_block_repo import RoomBlockRepository
from app.repositories.room_repo import RoomRepository
from app.models.room import RoomCreate, RoomUpdate, RoomResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["admin-rooms"])


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
                "category": rt.get("category", ""),
                "totalRooms": rt["total_rooms"],
                "baseRate": float(rt["base_rate"]),
                "maxOccupancy": rt.get("max_occupancy", 2),
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
                "roomId": str(bl["room_id"]) if bl.get("room_id") else None,
                "roomNumber": bl.get("room_number"),
                "startDate": str(bl["start_date"]),
                "endDate": str(bl["end_date"]),
                "blockedCount": bl["blocked_count"],
                "reason": bl["reason"],
                "createdAt": bl["created_at"].isoformat(),
            }
            for bl in blocks
        ],
    }
