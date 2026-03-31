import asyncio
import logging
from typing import List

from fastapi import APIRouter, HTTPException, Depends

from app.dependencies import require_hotel_admin
from app.utils import get_hotel_id
from app.repositories.channex_mapping_repo import (
    ChannexConnectionRepository,
    ChannexRoomTypeMappingRepository,
    ChannexRatePlanMappingRepository,
)
from app.models.channex import (
    ChannexConnectRequest,
    ChannexConnectionResponse,
    ChannexRoomTypeMappingResponse,
    ChannexRatePlanMappingResponse,
    ChannexSyncStatusResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["admin-channex"])


def _conn_to_response(c: dict) -> ChannexConnectionResponse:
    last_booking = c.get("last_booking_sync_at")
    last_ari = c.get("last_ari_sync_at")
    prop_id = c.get("channex_property_id")
    return ChannexConnectionResponse(
        id=str(c["id"]),
        hotel_id=str(c["hotel_id"]),
        channex_property_id=str(prop_id) if prop_id else None,
        is_active=c["is_active"],
        last_booking_sync_at=last_booking.isoformat() if last_booking else None,
        last_ari_sync_at=last_ari.isoformat() if last_ari else None,
        created_at=c["created_at"].isoformat(),
    )


def _room_mapping_to_response(m: dict) -> ChannexRoomTypeMappingResponse:
    return ChannexRoomTypeMappingResponse(
        id=str(m["id"]),
        hotel_id=str(m["hotel_id"]),
        room_type_id=str(m["room_type_id"]),
        channex_room_type_id=str(m["channex_room_type_id"]),
        created_at=m["created_at"].isoformat(),
    )


def _rate_mapping_to_response(m: dict) -> ChannexRatePlanMappingResponse:
    return ChannexRatePlanMappingResponse(
        id=str(m["id"]),
        hotel_id=str(m["hotel_id"]),
        room_type_id=str(m["room_type_id"]),
        channex_rate_plan_id=str(m["channex_rate_plan_id"]),
        channex_room_type_id=str(m["channex_room_type_id"]),
        sell_mode=m["sell_mode"],
        created_at=m["created_at"].isoformat(),
    )


# ── Connection ───────────────────────────────────────────────────────

@router.post("/channex/connect", response_model=ChannexConnectionResponse)
async def channex_connect(
    data: ChannexConnectRequest,
    user_id: str = Depends(require_hotel_admin),
):
    """Store a Channex API key and verify it works."""
    from app.services import channex_service

    hotel_id = await get_hotel_id(user_id)

    # Verify the API key is valid
    valid = await channex_service.test_connection(data.api_key)
    if not valid:
        raise HTTPException(status_code=400, detail="Invalid Channex API key")

    conn = await ChannexConnectionRepository.upsert(hotel_id, data.api_key)
    return _conn_to_response(conn)


@router.get("/channex/connection")
async def channex_get_connection(
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    conn = await ChannexConnectionRepository.get_by_hotel_id(hotel_id)
    if not conn:
        raise HTTPException(status_code=404, detail="No Channex connection found")
    return _conn_to_response(conn)


@router.delete("/channex/connection", status_code=204)
async def channex_disconnect(
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    await ChannexConnectionRepository.deactivate(hotel_id)


# ── Status overview ──────────────────────────────────────────────────

@router.get("/channex/status", response_model=ChannexSyncStatusResponse)
async def channex_status(
    user_id: str = Depends(require_hotel_admin),
):
    """Get a summary of the Channex integration status."""
    hotel_id = await get_hotel_id(user_id)
    conn = await ChannexConnectionRepository.get_by_hotel_id(hotel_id)

    if not conn or not conn["is_active"]:
        return ChannexSyncStatusResponse(is_connected=False)

    room_mappings = await ChannexRoomTypeMappingRepository.list_by_hotel_id(hotel_id)
    rate_mappings = await ChannexRatePlanMappingRepository.list_by_hotel_id(hotel_id)

    last_booking = conn.get("last_booking_sync_at")
    last_ari = conn.get("last_ari_sync_at")
    prop_id = conn.get("channex_property_id")

    return ChannexSyncStatusResponse(
        is_connected=True,
        channex_property_id=str(prop_id) if prop_id else None,
        room_types_provisioned=len(room_mappings),
        rate_plans_provisioned=len(rate_mappings),
        last_booking_sync_at=last_booking.isoformat() if last_booking else None,
        last_ari_sync_at=last_ari.isoformat() if last_ari else None,
    )


# ── Provisioning ─────────────────────────────────────────────────────

@router.post("/channex/provision")
async def channex_provision(
    user_id: str = Depends(require_hotel_admin),
):
    """Auto-create property + room types + rate plans in Channex."""
    from app.services.channex_sync_service import provision_property

    hotel_id = await get_hotel_id(user_id)
    conn = await ChannexConnectionRepository.get_by_hotel_id(hotel_id)
    if not conn or not conn["is_active"]:
        raise HTTPException(status_code=400, detail="No active Channex connection")

    try:
        result = await provision_property(hotel_id)
    except Exception as e:
        logger.exception("Failed to provision Channex for hotel %s", hotel_id)
        raise HTTPException(status_code=502, detail=f"Provisioning failed: {e}")

    return result


# ── Mappings ─────────────────────────────────────────────────────────

@router.get(
    "/channex/room-type-mappings",
    response_model=List[ChannexRoomTypeMappingResponse],
)
async def channex_list_room_type_mappings(
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    mappings = await ChannexRoomTypeMappingRepository.list_by_hotel_id(hotel_id)
    return [_room_mapping_to_response(m) for m in mappings]


@router.get(
    "/channex/rate-plan-mappings",
    response_model=List[ChannexRatePlanMappingResponse],
)
async def channex_list_rate_plan_mappings(
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    mappings = await ChannexRatePlanMappingRepository.list_by_hotel_id(hotel_id)
    return [_rate_mapping_to_response(m) for m in mappings]


# ── ARI Sync ─────────────────────────────────────────────────────────

@router.post("/channex/sync-ari")
async def channex_sync_ari(
    user_id: str = Depends(require_hotel_admin),
):
    """Trigger a full availability + rates push to Channex."""
    from app.services.channex_sync_service import push_ari_for_hotel

    hotel_id = await get_hotel_id(user_id)
    conn = await ChannexConnectionRepository.get_by_hotel_id(hotel_id)
    if not conn or not conn["is_active"]:
        raise HTTPException(status_code=400, detail="No active Channex connection")

    asyncio.create_task(push_ari_for_hotel(hotel_id))
    return {"status": "sync_started"}


# ── Booking Sync ─────────────────────────────────────────────────────

@router.post("/channex/sync-bookings")
async def channex_sync_bookings(
    user_id: str = Depends(require_hotel_admin),
):
    """Poll Channex booking revision feed and import new bookings."""
    from app.services.channex_sync_service import poll_bookings_for_hotel

    hotel_id = await get_hotel_id(user_id)
    conn = await ChannexConnectionRepository.get_by_hotel_id(hotel_id)
    if not conn or not conn["is_active"]:
        raise HTTPException(status_code=400, detail="No active Channex connection")

    await poll_bookings_for_hotel(hotel_id)
    return {"status": "sync_complete"}
