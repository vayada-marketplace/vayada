import asyncio
import logging
from typing import List

from fastapi import APIRouter, HTTPException, Depends

from app.config import settings
from app.dependencies import require_hotel_admin, require_super_admin
from app.utils import get_hotel_id
from app.repositories.channex_mapping_repo import (
    ChannexConnectionRepository,
    ChannexRoomTypeMappingRepository,
    ChannexRatePlanMappingRepository,
    ChannexChannelMarkupRepository,
    MARKUP_CHANNELS,
)
from app.repositories.channex_webhook_event_repo import ChannexWebhookEventRepository
from app.models.channex import (
    ChannexRoomTypeMappingResponse,
    ChannexRatePlanMappingResponse,
    ChannexSyncStatusResponse,
    ChannelMarkup,
    ChannelMarkupsResponse,
    ChannelMarkupsUpdateRequest,
    ConnectedChannel,
    ConnectedChannelsResponse,
)
from app.database import Database
from app.services import channex_service
from app.services.channex_service import ChannexAPIError
from app.services.channex.provisioning import provision_property
from app.services.channex.orchestrator import push_ari_for_hotel
from app.services.channex.inbound import poll_bookings_for_hotel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["admin-channex"])


# Map Channex `attributes.application` strings to the internal keys used
# by the PMS frontend (matches CalendarBooking.channel values from the
# inbound booking sync — see channex_sync_service.process_inbound_booking).
def _normalize_channex_application(app: str) -> str:
    if not app:
        return "other"
    a = app.lower().replace("_", "").replace("-", "").replace(".", "")
    if "booking" in a:
        return "booking.com"
    if "airbnb" in a:
        return "airbnb"
    if "expedia" in a:
        return "expedia"
    return "other"


# ── Enable / Disable ─────────────────────────────────────────────────

@router.post("/channex/enable")
async def channex_enable(
    user_id: str = Depends(require_hotel_admin),
):
    """Enable the channel manager for this hotel.

    Creates the Channex connection, provisions the property, room types,
    and rate plans — all in one step. Uses the platform-wide API key.
    """

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
    except ChannexAPIError as e:
        logger.exception("Channex rejected provisioning for hotel %s", hotel_id)
        raise HTTPException(
            status_code=502,
            detail=f"Channel manager couldn't be set up: {e.summary}",
        )
    except ValueError as e:
        # Pre-flight validation failed — actionable for the hotel admin.
        raise HTTPException(status_code=400, detail=str(e))
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
        messaging_app_installed=bool(conn.get("messaging_app_installed")),
    )


# ── Re-provision (when new room types are added) ─────────────────────

@router.post("/channex/provision")
async def channex_provision(
    user_id: str = Depends(require_hotel_admin),
):
    """Re-provision: create any new room types and rate plans in Channex."""

    hotel_id = await get_hotel_id(user_id)
    conn = await ChannexConnectionRepository.get_by_hotel_id(hotel_id)
    if not conn or not conn["is_active"]:
        raise HTTPException(status_code=400, detail="Channel manager not enabled")

    try:
        result = await provision_property(hotel_id)
    except ChannexAPIError as e:
        logger.exception("Channex rejected re-provisioning for hotel %s", hotel_id)
        raise HTTPException(
            status_code=502,
            detail=f"Channel manager couldn't be re-provisioned: {e.summary}",
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
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
        room_type_name=m.get("room_type_name"),
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
        plan_name=m.get("plan_name") or "standard",
        channel=m.get("channel") or "direct",
        meal_plan_code=int(m.get("meal_plan_code") or 0),
        created_at=m["created_at"].isoformat(),
    ) for m in mappings]


# ── ARI Sync ─────────────────────────────────────────────────────────

@router.post("/channex/sync-ari")
async def channex_sync_ari(
    user_id: str = Depends(require_hotel_admin),
):
    """Trigger a full availability + rates push to Channex."""

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

    hotel_id = await get_hotel_id(user_id)
    conn = await ChannexConnectionRepository.get_by_hotel_id(hotel_id)
    if not conn or not conn["is_active"]:
        raise HTTPException(status_code=400, detail="Channel manager not enabled")

    await poll_bookings_for_hotel(hotel_id)
    return {"status": "sync_complete"}


# ── Connected channels ───────────────────────────────────────────────

@router.get("/channex/channels", response_model=ConnectedChannelsResponse)
async def channex_list_channels(
    user_id: str = Depends(require_hotel_admin),
):
    """Return the OTA channels currently connected for this hotel.

    Used by the calendar legend to only show OTAs the hotel actually
    has wired up via the channel manager.
    """

    hotel_id = await get_hotel_id(user_id)
    conn = await ChannexConnectionRepository.get_by_hotel_id(hotel_id)
    if not conn or not conn["is_active"] or not conn.get("channex_property_id"):
        return ConnectedChannelsResponse(channels=[])

    api_key = channex_service.get_platform_api_key()
    property_id = str(conn["channex_property_id"])

    try:
        raw = await channex_service.list_channels(api_key, property_id)
    except Exception:
        logger.exception("Failed to list Channex channels for hotel %s", hotel_id)
        return ConnectedChannelsResponse(channels=[])

    channels: List[ConnectedChannel] = []
    for item in raw:
        attrs = item.get("attributes", item) or {}
        application = attrs.get("application") or attrs.get("app") or ""
        if not application:
            continue
        is_active = attrs.get("is_active", True)
        if is_active is False:
            continue
        channels.append(ConnectedChannel(
            key=_normalize_channex_application(application),
            application=application,
            title=attrs.get("title"),
            is_active=bool(is_active),
        ))
    return ConnectedChannelsResponse(channels=channels)


# ── Channel markups ──────────────────────────────────────────────────

@router.get("/channex/markups", response_model=ChannelMarkupsResponse)
async def channex_get_markups(
    user_id: str = Depends(require_hotel_admin),
):
    """Return current per-channel markup percentages for the hotel.
    Channels with no configured row default to 0%."""
    hotel_id = await get_hotel_id(user_id)
    rows = await ChannexChannelMarkupRepository.list_by_hotel_id(hotel_id)
    by_channel = {r["channel"]: r["markup_pct"] for r in rows}
    markups = [
        ChannelMarkup(channel=ch, markup_pct=by_channel.get(ch, 0))
        for ch in MARKUP_CHANNELS
    ]
    return ChannelMarkupsResponse(markups=markups)


@router.put("/channex/markups", response_model=ChannelMarkupsResponse)
async def channex_update_markups(
    req: ChannelMarkupsUpdateRequest,
    user_id: str = Depends(require_hotel_admin),
):
    """Upsert per-channel markup percentages, ensure per-channel rate plans
    exist in Channex, and trigger an ARI re-sync so the updated prices
    propagate to OTAs."""

    hotel_id = await get_hotel_id(user_id)
    conn = await ChannexConnectionRepository.get_by_hotel_id(hotel_id)
    if not conn or not conn["is_active"]:
        raise HTTPException(status_code=400, detail="Channel manager not enabled")

    for m in req.markups:
        if m.channel not in MARKUP_CHANNELS:
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported channel '{m.channel}'",
            )
        await ChannexChannelMarkupRepository.upsert(hotel_id, m.channel, m.markup_pct)

    # Provision is idempotent — creates any missing per-channel rate plans
    # (needed for hotels that enabled Channex before this feature shipped).
    try:
        await provision_property(hotel_id)
    except ChannexAPIError as e:
        logger.exception("Channex rejected per-channel provisioning for hotel %s", hotel_id)
        raise HTTPException(
            status_code=502,
            detail=f"Channel manager couldn't be updated: {e.summary}",
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("Failed to provision per-channel rate plans for hotel %s", hotel_id)
        raise HTTPException(status_code=502, detail=f"Provisioning failed: {e}")

    asyncio.create_task(push_ari_for_hotel(hotel_id))

    rows = await ChannexChannelMarkupRepository.list_by_hotel_id(hotel_id)
    by_channel = {r["channel"]: r["markup_pct"] for r in rows}
    markups = [
        ChannelMarkup(channel=ch, markup_pct=by_channel.get(ch, 0))
        for ch in MARKUP_CHANNELS
    ]
    return ChannelMarkupsResponse(markups=markups)


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


# ── Messaging app management (super-admin / one-time setup) ──────────

WEBHOOK_HEADER_NAME = "X-Vayada-Webhook-Token"


@router.post("/channex/messaging/backfill")
async def channex_messaging_backfill(
    user_id: str = Depends(require_super_admin),
):
    """Install the Channex Messaging & Reviews app on every existing
    channex_connections row that doesn't have it yet. Idempotent."""
    api_key = channex_service.get_platform_api_key()

    rows = await Database.fetch(
        "SELECT hotel_id, channex_property_id FROM channex_connections "
        "WHERE is_active = true "
        "  AND channex_property_id IS NOT NULL "
        "  AND messaging_app_installed = false"
    )

    installed = []
    failed = []
    for r in rows:
        hotel_id = str(r["hotel_id"])
        property_id = str(r["channex_property_id"])
        try:
            already = await channex_service.is_messaging_app_installed(api_key, property_id)
            if not already:
                await channex_service.install_messaging_app(api_key, property_id)
            await ChannexConnectionRepository.set_messaging_app_installed(hotel_id, True)
            installed.append(hotel_id)
        except Exception as e:
            logger.warning("Failed to install messaging app for hotel %s: %s", hotel_id, e)
            failed.append({"hotel_id": hotel_id, "error": str(e)})

    return {"installed": installed, "failed": failed}


@router.post("/channex/messaging/install")
async def channex_messaging_install(
    user_id: str = Depends(require_hotel_admin),
):
    """Install (or re-attempt installing) the Channex Messaging & Reviews app
    for the requesting hotel's property. Lets a hotel admin recover from a
    failed install without waiting for a super-admin backfill. Idempotent."""
    hotel_id = await get_hotel_id(user_id)
    conn = await ChannexConnectionRepository.get_by_hotel_id(hotel_id)
    if not conn or not conn["is_active"]:
        raise HTTPException(status_code=400, detail="Channel manager not enabled")
    if not conn.get("channex_property_id"):
        raise HTTPException(status_code=400, detail="Property not provisioned yet")

    api_key = channex_service.get_platform_api_key()
    property_id = str(conn["channex_property_id"])
    try:
        already = await channex_service.is_messaging_app_installed(api_key, property_id)
        if not already:
            await channex_service.install_messaging_app(api_key, property_id)
        await ChannexConnectionRepository.set_messaging_app_installed(hotel_id, True)
    except Exception as e:
        logger.warning("Failed to install messaging app for hotel %s: %s", hotel_id, e)
        raise HTTPException(status_code=502, detail=f"Failed to install messaging app: {e}")
    return {"status": "installed"}


@router.get("/channex/webhook-events/summary")
async def channex_webhook_events_summary(
    hours: int = 24,
    user_id: str = Depends(require_super_admin),
):
    """Counts of Channex webhook events received in the last N hours, grouped
    by event_type. Use to detect a stuck webhook pipeline (zero `message`
    events for a sustained window means Channex has stopped delivering)."""
    if hours < 1 or hours > 24 * 30:
        raise HTTPException(status_code=400, detail="hours must be 1..720")
    rows = await ChannexWebhookEventRepository.summary_since(hours)
    return {
        "window_hours": hours,
        "by_event_type": [
            {
                "event_type": r["event_type"],
                "total": r["total"],
                "ok": r["ok"],
                "failed": r["failed"],
                "ignored": r["ignored"],
                "last_received_at": r["last_received_at"].isoformat() if r["last_received_at"] else None,
            }
            for r in rows
        ],
    }


@router.post("/channex/webhook/setup")
async def channex_webhook_setup(
    callback_url: str,
    user_id: str = Depends(require_super_admin),
):
    """One-time setup: register (or update) a single global Channex webhook
    that pushes `message` events to our /webhooks/channex endpoint, with our
    shared secret in the X-Vayada-Webhook-Token header.

    Pass the public callback URL (e.g.
    `https://api.vayada.com/webhooks/channex`)."""
    if not settings.CHANNEX_WEBHOOK_SECRET:
        raise HTTPException(
            status_code=400,
            detail="CHANNEX_WEBHOOK_SECRET must be set before registering",
        )

    api_key = channex_service.get_platform_api_key()
    headers = {WEBHOOK_HEADER_NAME: settings.CHANNEX_WEBHOOK_SECRET}

    try:
        existing = await channex_service.list_webhooks(api_key)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to list webhooks: {e}")

    match = None
    for w in existing:
        attrs = w.get("attributes") or {}
        if attrs.get("callback_url") == callback_url:
            match = w
            break

    if match:
        try:
            updated = await channex_service.update_webhook(
                api_key, match["id"],
                {
                    "event_mask": "message",
                    "is_global": True,
                    "is_active": True,
                    "send_data": True,
                    "headers": headers,
                },
            )
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Failed to update webhook: {e}")
        return {"status": "updated", "webhook_id": updated.get("id", match["id"])}

    try:
        created = await channex_service.create_webhook(
            api_key,
            callback_url=callback_url,
            event_mask="message",
            is_global=True,
            headers=headers,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to create webhook: {e}")
    return {"status": "created", "webhook_id": created.get("id")}
