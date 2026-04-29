import asyncio
import json
import logging
from typing import List

from fastapi import APIRouter, HTTPException, Depends

from app.dependencies import require_hotel_admin
from app.services.channex_sync_service import push_cancellation_policy_for_room_type
from app.utils import parse_jsonb, get_hotel_id
from app.database import Database, BookingEngineDatabase
from app.config import settings as app_settings
from app.repositories.room_type_repo import RoomTypeRepository
from app.repositories.room_repo import RoomRepository
from app.models.room_type import (
    RoomTypeCreate,
    RoomTypeUpdate,
    RoomTypeAdminResponse,
    MonthlyRate,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["admin-room-types"])


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
        flexible_cancellation_type=room.get("flexible_cancellation_type") or "free",
        partial_refund_cancel_window_days=room.get("partial_refund_cancel_window_days", 30),
        partial_refund_amount_percent=room.get("partial_refund_amount_percent", 50),
        non_refundable_enabled=room.get("non_refundable_enabled", False),
        non_refundable_discount=room.get("non_refundable_discount", 5),
        non_refundable_cancellation_policy=room.get("non_refundable_cancellation_policy") or "Non-refundable from booking",
        last_minute_discount=(lambda v: v if isinstance(v, dict) else None)(parse_jsonb(room.get("last_minute_discount"))),
        minimum_advance_days=room.get("minimum_advance_days") or 0,
        rate_payment_methods=(lambda v: v if isinstance(v, dict) else None)(parse_jsonb(room.get("rate_payment_methods"))),
        created_at=room["created_at"].isoformat(),
        updated_at=room["updated_at"].isoformat(),
    )


async def _auto_create_rooms(
    hotel_id: str, room_type_id: str, count: int, room_type_name: str
) -> None:
    """Create `count` Room records for a newly created room type.

    Room numbers are named "{room_type_name} N" so the calendar can show e.g.
    "#Garden King 1" instead of an opaque "#1". The starting suffix is one past
    the highest existing "{room_type_name} N" suffix in the hotel, keeping the
    unique (hotel_id, room_number) index satisfied even if the user re-creates
    a room type with the same name. Failures are logged but do not abort the
    request — the user can still add rooms manually if a default still clashes.
    """
    if count <= 0:
        return
    prefix = f"{room_type_name} "
    like_pattern = prefix.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    max_num = await Database.fetchval(
        """
        SELECT COALESCE(MAX(NULLIF(regexp_replace(room_number, '^.*[^0-9]', ''), '')::int), 0)
        FROM rooms
        WHERE hotel_id = $1 AND room_number LIKE $2 ESCAPE '\\'
        """,
        hotel_id,
        like_pattern,
    ) or 0
    for i in range(count):
        room_number = f"{prefix}{max_num + i + 1}"
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
    await _auto_create_rooms(
        hotel_id,
        str(room["id"]),
        int(payload.get("total_rooms") or 0),
        room["name"],
    )
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

    cancel_fields = {
        "flexible_cancellation_type",
        "partial_refund_cancel_window_days",
        "partial_refund_amount_percent",
    }
    if cancel_fields & updates.keys():
        asyncio.create_task(
            push_cancellation_policy_for_room_type(hotel_id, room_type_id)
        )

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
        "flexible_cancellation_type": existing.get("flexible_cancellation_type") or "free",
        "partial_refund_cancel_window_days": existing.get("partial_refund_cancel_window_days", 30),
        "partial_refund_amount_percent": existing.get("partial_refund_amount_percent", 50),
        "non_refundable_discount": existing.get("non_refundable_discount", 5),
        "non_refundable_enabled": existing.get("non_refundable_enabled", False),
        "non_refundable_cancellation_policy": existing.get("non_refundable_cancellation_policy") or "Non-refundable from booking",
        "last_minute_discount": (lambda v: v if isinstance(v, dict) else None)(parse_jsonb(existing.get("last_minute_discount"))),
        "rate_payment_methods": (lambda v: v if isinstance(v, dict) else None)(parse_jsonb(existing.get("rate_payment_methods"))),
    }
    room = await RoomTypeRepository.create(hotel_id, clone_data)
    await _auto_create_rooms(
        hotel_id,
        str(room["id"]),
        int(clone_data.get("total_rooms") or 0),
        room["name"],
    )
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
