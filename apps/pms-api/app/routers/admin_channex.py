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
    ChannexRoomTypeMappingResponse,
    ChannexRatePlanMappingResponse,
    ChannexSyncStatusResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["admin-channex"])


# ── Enable / Disable ─────────────────────────────────────────────────

@router.post("/channex/enable")
async def channex_enable(
    user_id: str = Depends(require_hotel_admin),
):
    """Enable the channel manager for this hotel.

    Creates the Channex connection, provisions the property, room types,
    and rate plans — all in one step. Uses the platform-wide API key.
    """
    from app.services import channex_service
    from app.services.channex_sync_service import provision_property

    hotel_id = await get_hotel_id(user_id)

    # Check if already enabled
    existing = await ChannexConnectionRepository.get_by_hotel_id(hotel_id)
    if existing and existing["is_active"] and existing.get("channex_property_id"):
        return {"status": "already_enabled", "channex_property_id": str(existing["channex_property_id"])}

    # Verify platform API key works
    api_key = channex_service.get_platform_api_key()
    valid = await channex_service.test_connection(api_key)
    if not valid:
        raise HTTPException(status_code=502, detail="Channel manager is not configured")

    # Create or reactivate connection
    await ChannexConnectionRepository.upsert(hotel_id)

    # Provision property + rooms + rate plans in Channex
    try:
        result = await provision_property(hotel_id)
    except Exception as e:
        logger.exception("Failed to provision Channex for hotel %s", hotel_id)
        raise HTTPException(status_code=502, detail=f"Provisioning failed: {e}")

    return {
        "status": "enabled",
        "channex_property_id": result["channex_property_id"],
        "rooms_created": result["rooms_created"],
        "rates_created": result["rates_created"],
    }


@router.post("/channex/disable", status_code=204)
async def channex_disable(
    user_id: str = Depends(require_hotel_admin),
):
    """Disable the channel manager for this hotel."""
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


# ── Re-provision (when new room types are added) ─────────────────────

@router.post("/channex/provision")
async def channex_provision(
    user_id: str = Depends(require_hotel_admin),
):
    """Re-provision: create any new room types and rate plans in Channex."""
    from app.services.channex_sync_service import provision_property

    hotel_id = await get_hotel_id(user_id)
    conn = await ChannexConnectionRepository.get_by_hotel_id(hotel_id)
    if not conn or not conn["is_active"]:
        raise HTTPException(status_code=400, detail="Channel manager not enabled")

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
    return [ChannexRoomTypeMappingResponse(
        id=str(m["id"]), hotel_id=str(m["hotel_id"]),
        room_type_id=str(m["room_type_id"]),
        channex_room_type_id=str(m["channex_room_type_id"]),
        created_at=m["created_at"].isoformat(),
    ) for m in mappings]


@router.get(
    "/channex/rate-plan-mappings",
    response_model=List[ChannexRatePlanMappingResponse],
)
async def channex_list_rate_plan_mappings(
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    mappings = await ChannexRatePlanMappingRepository.list_by_hotel_id(hotel_id)
    return [ChannexRatePlanMappingResponse(
        id=str(m["id"]), hotel_id=str(m["hotel_id"]),
        room_type_id=str(m["room_type_id"]),
        channex_rate_plan_id=str(m["channex_rate_plan_id"]),
        channex_room_type_id=str(m["channex_room_type_id"]),
        sell_mode=m["sell_mode"],
        created_at=m["created_at"].isoformat(),
    ) for m in mappings]


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
        raise HTTPException(status_code=400, detail="Channel manager not enabled")

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
        raise HTTPException(status_code=400, detail="Channel manager not enabled")

    await poll_bookings_for_hotel(hotel_id)
    return {"status": "sync_complete"}


# ── Channel IFrame ───────────────────────────────────────────────────

@router.post("/channex/iframe-url")
async def channex_iframe_url(
    user_id: str = Depends(require_hotel_admin),
):
    """Generate a one-time iframe URL for channel management.

    The hotel admin can use this iframe to connect/disconnect OTAs
    (Booking.com, Airbnb, Expedia, etc.) and map rooms/rates
    without leaving the PMS UI.
    """
    from app.services import channex_service

    hotel_id = await get_hotel_id(user_id)
    conn = await ChannexConnectionRepository.get_by_hotel_id(hotel_id)
    if not conn or not conn["is_active"]:
        raise HTTPException(status_code=400, detail="Channel manager not enabled")
    if not conn.get("channex_property_id"):
        raise HTTPException(status_code=400, detail="Property not provisioned yet")

    api_key = channex_service.get_platform_api_key()
    property_id = str(conn["channex_property_id"])

    try:
        token = await channex_service.create_iframe_token(api_key, property_id)
        url = channex_service.build_iframe_url(token, property_id)
    except Exception as e:
        logger.exception("Failed to generate Channex iframe URL")
        raise HTTPException(status_code=502, detail=f"Failed to generate iframe URL: {e}")

    return {"iframe_url": url}
