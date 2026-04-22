import asyncio
import json
import logging
from typing import List
from datetime import date
from app.database import Database

from fastapi import APIRouter, HTTPException, Depends, Query

from app.dependencies import require_hotel_admin
from app.services.channex_sync_service import push_availability_for_room_type
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
from app.models.room_block import RoomBlockCreate, RoomBlockUpdate, RoomBlockResponse

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
        category=room.get("category", ""),
        description=room["description"],
        short_description=room["short_description"],
        max_occupancy=room["max_occupancy"],
        bedrooms=room.get("bedrooms", 1),
        bathrooms=room.get("bathrooms", 1),
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
        daily_rates=parse_jsonb(room.get("daily_rates", {})),
        operating_periods=parse_jsonb(room.get("operating_periods", [])),
        seasons=parse_jsonb(room.get("seasons", [])),
        weekend_surcharge=room.get("weekend_surcharge") or "+0%",
        cancellation_policy=room.get("cancellation_policy") or "Free until 7 days before",
        flexible_rate_enabled=room.get("flexible_rate_enabled", True),
        non_refundable_enabled=room.get("non_refundable_enabled", False),
        non_refundable_discount=room.get("non_refundable_discount", 10),
        last_minute_discount=(lambda v: v if isinstance(v, dict) else None)(parse_jsonb(room.get("last_minute_discount"))),
        minimum_advance_days=room.get("minimum_advance_days") or 0,
        rate_payment_methods=(lambda v: v if isinstance(v, dict) else None)(parse_jsonb(room.get("rate_payment_methods"))),
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


async def _auto_create_rooms(hotel_id: str, room_type_id: str, count: int) -> None:
    """Create `count` Room records for a newly created room type.

    Room numbers start after the highest existing numeric room number in the
    hotel, so the defaults ("1", "2", "3", …) never collide with the unique
    (hotel_id, room_number) index. Non-numeric room numbers are ignored.
    Failures are logged but do not abort the request — the user can still
    add rooms manually if the defaults clash.
    """
    if count <= 0:
        return
    max_num = await Database.fetchval(
        """
        SELECT COALESCE(MAX((room_number)::int), 0)
        FROM rooms
        WHERE hotel_id = $1 AND room_number ~ '^[0-9]+$'
        """,
        hotel_id,
    ) or 0
    for i in range(count):
        room_number = str(max_num + i + 1)
        try:
            await RoomRepository.create(
                {
                    "hotel_id": hotel_id,
                    "room_type_id": room_type_id,
                    "room_number": room_number,
                    "floor": "",
                    "status": "available",
                    "sort_order": i,
                }
            )
        except Exception as e:
            logger.warning(
                "Failed to auto-create room %s for room_type %s: %s",
                room_number, room_type_id, e,
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

    # Force the room currency to the hotel's authoritative currency so a
    # buggy or stale frontend payload can never create rooms with a
    # different currency than the property. Currency lives in
    # booking_hotels.currency (booking_db is the single source of truth
    # for hotel identity fields — see memory/project_hotel_data_ownership.md).
    from app.database import BookingEngineDatabase
    from app.config import settings as app_settings
    if app_settings.BOOKING_ENGINE_DATABASE_URL:
        try:
            be_currency = await BookingEngineDatabase.fetchval(
                "SELECT currency FROM booking_hotels WHERE id = $1",
                hotel_id,
            )
            if be_currency:
                payload["currency"] = be_currency
        except Exception as e:
            logger.warning("Failed to fetch booking engine currency for room creation: %s", e)

    if payload.get("monthly_rates"):
        payload["monthly_rates"] = {
            k: v.model_dump(exclude_none=True) if hasattr(v, "model_dump") else {kk: vv for kk, vv in v.items() if vv is not None}
            for k, v in payload["monthly_rates"].items()
        }
    else:
        payload["monthly_rates"] = {}
    if not payload.get("daily_rates"):
        payload["daily_rates"] = {}
    room = await RoomTypeRepository.create(hotel_id, payload)
    await _auto_create_rooms(hotel_id, str(room["id"]), int(payload.get("total_rooms") or 0))
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


@router.post("/room-types/{room_type_id}/duplicate", response_model=RoomTypeAdminResponse, status_code=201)
async def duplicate_room_type(
    room_type_id: str,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    existing = await RoomTypeRepository.get_by_id(room_type_id)
    if not existing or str(existing["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Room type not found")

    clone_data = {
        "name": existing["name"] + " (Copy)",
        "category": existing.get("category", ""),
        "description": existing.get("description", ""),
        "short_description": existing.get("short_description", ""),
        "max_occupancy": existing["max_occupancy"],
        "bedrooms": existing.get("bedrooms", 1),
        "bathrooms": existing.get("bathrooms", 1),
        "size": existing["size"],
        "base_rate": float(existing["base_rate"]),
        "non_refundable_rate": float(existing["non_refundable_rate"]) if existing.get("non_refundable_rate") is not None else None,
        "currency": existing["currency"],
        "amenities": parse_jsonb(existing["amenities"]),
        "images": parse_jsonb(existing["images"]),
        "bed_type": existing["bed_type"],
        "features": parse_jsonb(existing["features"]),
        "benefits": parse_jsonb(existing.get("benefits", [])),
        "total_rooms": existing["total_rooms"],
        "is_active": existing["is_active"],
        "sort_order": existing["sort_order"],
        "monthly_rates": parse_jsonb(existing.get("monthly_rates", {})),
        "daily_rates": parse_jsonb(existing.get("daily_rates", {})),
        "operating_periods": parse_jsonb(existing.get("operating_periods", [])),
        "seasons": parse_jsonb(existing.get("seasons", [])),
        "weekend_surcharge": existing.get("weekend_surcharge") or "+0%",
        "cancellation_policy": existing.get("cancellation_policy") or "Free until 7 days before",
        "flexible_rate_enabled": existing.get("flexible_rate_enabled", True),
        "non_refundable_discount": existing.get("non_refundable_discount", 10),
        "non_refundable_enabled": existing.get("non_refundable_enabled", False),
        "last_minute_discount": (lambda v: v if isinstance(v, dict) else None)(parse_jsonb(existing.get("last_minute_discount"))),
    }
    room = await RoomTypeRepository.create(hotel_id, clone_data)
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


async def _check_block_availability(
    room_type_id: str,
    total_rooms: int,
    start_date: date,
    end_date: date,
    new_blocked_count: int,
    exclude_block_id: str = None,
) -> None:
    """Raise 400 if adding a block of new_blocked_count rooms on the given
    date range would cause total occupancy (bookings + blocks) to exceed
    total_rooms on any day."""
    from datetime import timedelta
    current = start_date
    while current < end_date:
        next_day = current + timedelta(days=1)
        booked = await RoomTypeRepository.count_booked(room_type_id, current, next_day)
        # Sum blocks overlapping this day, optionally excluding one block (for updates)
        if exclude_block_id:
            blocked = await Database.fetchval(
                """
                SELECT COALESCE(SUM(blocked_count), 0) FROM room_blocks
                WHERE room_type_id = $1 AND start_date < $3 AND end_date > $2 AND id <> $4
                """,
                room_type_id, current, next_day, exclude_block_id,
            ) or 0
        else:
            blocked = await RoomTypeRepository.count_blocked(room_type_id, current, next_day)
        if booked + blocked + new_blocked_count > total_rooms:
            raise HTTPException(
                status_code=400,
                detail=f"Not enough availability on {current.isoformat()}: {booked} booked, {blocked} blocked, {total_rooms} total. Cannot block {new_blocked_count} more room(s).",
            )
        current = next_day


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

    await _check_block_availability(
        data.room_type_id,
        room["total_rooms"],
        data.start_date,
        data.end_date,
        data.blocked_count,
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

    # Push updated availability to Channex
    asyncio.create_task(
        push_availability_for_room_type(
            hotel_id, data.room_type_id,
            start_date=data.start_date, end_date=data.end_date,
        )
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


@router.patch("/room-blocks/{block_id}", response_model=RoomBlockResponse)
async def update_room_block(
    block_id: str,
    data: RoomBlockUpdate,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    block = await RoomBlockRepository.get_by_id(block_id)
    if not block or str(block["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Room block not found")

    updates = data.model_dump(exclude_unset=True)

    # Validate date range against the (possibly updated) fields
    new_start = updates.get("start_date", block["start_date"])
    new_end = updates.get("end_date", block["end_date"])
    if new_end <= new_start:
        raise HTTPException(status_code=400, detail="end_date must be after start_date")

    # Validate blocked_count against room type total and availability
    new_count = updates.get("blocked_count", block["blocked_count"])
    room = await RoomTypeRepository.get_by_id(str(block["room_type_id"]))
    if room and (new_count < 1 or new_count > room["total_rooms"]):
        raise HTTPException(
            status_code=400,
            detail=f"blocked_count must be between 1 and {room['total_rooms']}",
        )

    if room:
        await _check_block_availability(
            str(block["room_type_id"]),
            room["total_rooms"],
            new_start,
            new_end,
            new_count,
            exclude_block_id=block_id,
        )

    updated = await RoomBlockRepository.update(block_id, updates)

    # Push updated availability to Channex — cover union of old and new date ranges
    sync_start = min(block["start_date"], new_start)
    sync_end = max(block["end_date"], new_end)
    asyncio.create_task(
        push_availability_for_room_type(
            hotel_id, str(block["room_type_id"]),
            start_date=sync_start, end_date=sync_end,
        )
    )

    return RoomBlockResponse(
        id=str(updated["id"]),
        room_type_id=str(updated["room_type_id"]),
        start_date=str(updated["start_date"]),
        end_date=str(updated["end_date"]),
        blocked_count=updated["blocked_count"],
        reason=updated["reason"],
        created_at=updated["created_at"].isoformat(),
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

    # Push updated availability to Channex
    asyncio.create_task(
        push_availability_for_room_type(
            hotel_id, str(block["room_type_id"]),
            start_date=block["start_date"], end_date=block["end_date"],
        )
    )
