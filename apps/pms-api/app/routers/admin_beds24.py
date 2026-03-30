import asyncio
import logging
from typing import List

logger = logging.getLogger(__name__)

from fastapi import APIRouter, HTTPException, Depends

from app.dependencies import require_hotel_admin
from app.utils import get_hotel_id
from app.repositories.room_type_repo import RoomTypeRepository
from app.repositories.booking_repo import BookingRepository
from app.repositories.beds24_mapping_repo import (
    Beds24ConnectionRepository,
    Beds24RoomMappingRepository,
)
from app.models.beds24 import (
    Beds24ConnectRequest,
    Beds24ConnectionResponse,
    Beds24RoomMappingCreate,
    Beds24RoomMappingResponse,
    Beds24SetPropertyRequest,
    Beds24PropertyResponse,
    Beds24RoomResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["admin-beds24"])


def _conn_to_response(c: dict) -> Beds24ConnectionResponse:
    last_sync = c.get("last_sync_at")
    return Beds24ConnectionResponse(
        id=str(c["id"]),
        hotel_id=str(c["hotel_id"]),
        beds24_property_id=c.get("beds24_property_id"),
        is_active=c["is_active"],
        last_sync_at=last_sync.isoformat() if last_sync else None,
        created_at=c["created_at"].isoformat(),
    )


def _mapping_to_response(m: dict) -> Beds24RoomMappingResponse:
    return Beds24RoomMappingResponse(
        id=str(m["id"]),
        hotel_id=str(m["hotel_id"]),
        room_type_id=str(m["room_type_id"]),
        beds24_room_id=m["beds24_room_id"],
        created_at=m["created_at"].isoformat(),
    )


# ── Beds24 Channel Manager ────────────────────────────────────────


@router.post("/beds24/connect", response_model=Beds24ConnectionResponse)
async def beds24_connect(
    data: Beds24ConnectRequest,
    user_id: str = Depends(require_hotel_admin),
):
    from app.services import beds24_service

    hotel_id = await get_hotel_id(user_id)
    try:
        conn = await beds24_service.setup_connection(hotel_id, data.invite_code)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to connect: {e}")
    return _conn_to_response(conn)


@router.get("/beds24/connection")
async def beds24_get_connection(
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    conn = await Beds24ConnectionRepository.get_by_hotel_id(hotel_id)
    if not conn:
        raise HTTPException(status_code=404, detail="No Beds24 connection found")
    return _conn_to_response(conn)


@router.delete("/beds24/connection", status_code=204)
async def beds24_disconnect(
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    await Beds24ConnectionRepository.deactivate(hotel_id)


@router.get("/beds24/properties", response_model=List[Beds24PropertyResponse])
async def beds24_list_properties(
    user_id: str = Depends(require_hotel_admin),
):
    from app.services import beds24_service

    hotel_id = await get_hotel_id(user_id)
    try:
        props = await beds24_service.get_properties(hotel_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return [Beds24PropertyResponse(id=p["id"], name=p["name"]) for p in props]


@router.post("/beds24/property")
async def beds24_set_property(
    data: Beds24SetPropertyRequest,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    conn = await Beds24ConnectionRepository.set_property_id(
        hotel_id, data.beds24_property_id
    )
    if not conn:
        raise HTTPException(status_code=404, detail="No Beds24 connection found")
    return _conn_to_response(conn)


@router.get("/beds24/rooms", response_model=List[Beds24RoomResponse])
async def beds24_list_rooms(
    user_id: str = Depends(require_hotel_admin),
):
    from app.services import beds24_service

    hotel_id = await get_hotel_id(user_id)
    conn = await Beds24ConnectionRepository.get_by_hotel_id(hotel_id)
    if not conn or not conn.get("beds24_property_id"):
        raise HTTPException(status_code=400, detail="No Beds24 property mapped")
    try:
        rooms = await beds24_service.get_property_rooms(
            hotel_id, conn["beds24_property_id"]
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("Failed to fetch Beds24 rooms for hotel %s", hotel_id)
        raise HTTPException(status_code=502, detail="Failed to fetch rooms from Beds24")
    return [Beds24RoomResponse(id=r["id"], name=r["name"], qty=r.get("qty", 1)) for r in rooms]


@router.get("/beds24/room-mappings", response_model=List[Beds24RoomMappingResponse])
async def beds24_list_room_mappings(
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    mappings = await Beds24RoomMappingRepository.list_by_hotel_id(hotel_id)
    return [_mapping_to_response(m) for m in mappings]


@router.post("/beds24/room-mappings", response_model=Beds24RoomMappingResponse, status_code=201)
async def beds24_create_room_mapping(
    data: Beds24RoomMappingCreate,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)

    # Validate room type belongs to hotel
    room_type = await RoomTypeRepository.get_by_id(data.room_type_id)
    if not room_type or str(room_type["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Room type not found")

    try:
        mapping = await Beds24RoomMappingRepository.create(
            hotel_id, data.room_type_id, data.beds24_room_id
        )
    except Exception:
        raise HTTPException(
            status_code=409,
            detail="Room type or Beds24 room is already mapped",
        )
    return _mapping_to_response(mapping)


@router.delete("/beds24/room-mappings/{mapping_id}", status_code=204)
async def beds24_delete_room_mapping(
    mapping_id: str,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    # Verify mapping belongs to hotel
    mappings = await Beds24RoomMappingRepository.list_by_hotel_id(hotel_id)
    if not any(str(m["id"]) == mapping_id for m in mappings):
        raise HTTPException(status_code=404, detail="Room mapping not found")
    await Beds24RoomMappingRepository.delete(mapping_id)


@router.post("/beds24/sync-availability")
async def beds24_sync_availability(
    user_id: str = Depends(require_hotel_admin),
):
    from app.services.beds24_sync_service import push_availability_for_hotel

    hotel_id = await get_hotel_id(user_id)
    conn = await Beds24ConnectionRepository.get_by_hotel_id(hotel_id)
    if not conn or not conn["is_active"]:
        raise HTTPException(status_code=400, detail="No active Beds24 connection")

    asyncio.create_task(push_availability_for_hotel(hotel_id))
    return {"status": "sync_started"}


@router.post("/beds24/assign-unassigned-rooms")
async def beds24_assign_unassigned_rooms(
    user_id: str = Depends(require_hotel_admin),
):
    """One-time fix: assign room units to Beds24 bookings that were imported without one."""
    from app.database import Database

    hotel_id = await get_hotel_id(user_id)
    unassigned = await Database.fetch(
        """
        SELECT b.id, b.room_type_id, b.check_in, b.check_out
        FROM bookings b
        JOIN beds24_booking_mappings bm ON bm.booking_id = b.id
        WHERE b.hotel_id = $1
          AND b.room_id IS NULL
          AND b.status IN ('pending', 'confirmed')
        """,
        hotel_id,
    )

    assigned_count = 0
    for booking in unassigned:
        available_room = await Database.fetchrow(
            """
            SELECT r.id FROM rooms r
            WHERE r.room_type_id = $1
              AND r.status = 'available'
              AND r.id NOT IN (
                SELECT b.room_id FROM bookings b
                WHERE b.room_id IS NOT NULL
                  AND b.status IN ('pending', 'confirmed')
                  AND b.check_in < $3
                  AND b.check_out > $2
              )
            ORDER BY r.sort_order, r.room_number
            LIMIT 1
            """,
            str(booking["room_type_id"]),
            booking["check_in"],
            booking["check_out"],
        )
        if available_room:
            await BookingRepository.assign_room(str(booking["id"]), str(available_room["id"]))
            assigned_count += 1

    return {"assigned": assigned_count, "total_unassigned": len(unassigned)}
