"""Custom-domain management — connect, disconnect, status. Wraps
Cloudflare for SaaS so the property-settings router doesn't carry the
hostname-provisioning concern."""
import logging
import re

from fastapi import APIRouter, Depends, HTTPException

from app.dependencies import require_current_hotel, require_hotel_admin
from app.repositories.booking_hotel_repo import BookingHotelRepository
from app.services import cloudflare_service

logger = logging.getLogger(__name__)

router = APIRouter()

_DOMAIN_RE = re.compile(
    r"^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,}$"
)


def _status_response(domain: str, cf_status: dict | None) -> dict:
    return {
        "domain": domain,
        "status": cf_status.get("status", "pending") if cf_status else "pending",
        "ssl_status": cf_status.get("ssl_status", "initializing") if cf_status else "initializing",
    }


@router.post("/settings/custom-domain")
async def connect_custom_domain(
    data: dict,
    user_id: str = Depends(require_hotel_admin),
    hotel: dict = Depends(require_current_hotel),
):
    domain = (data.get("domain") or "").strip().lower()
    if not domain or not _DOMAIN_RE.match(domain):
        raise HTTPException(status_code=400, detail="Invalid domain format")

    # Check not already taken by another hotel
    existing = await BookingHotelRepository.get_by_custom_domain(domain)
    if existing and str(existing["id"]) != str(hotel["id"]):
        raise HTTPException(status_code=409, detail="This domain is already in use by another property")

    # If already connected to this hotel, just return current status
    if existing and str(existing["id"]) == str(hotel["id"]):
        cf_status = await cloudflare_service.get_hostname_status(domain)
        return _status_response(domain, cf_status)

    # Cloudflare may still have a hostname from a previous failed/stale local
    # disconnect even when our DB says the domain is unassigned. In that case,
    # adopt the existing Cloudflare hostname for this hotel instead of failing
    # with "already registered" while the UI shows no connected domain.
    cf_status = await cloudflare_service.get_hostname_status(domain)
    if cf_status:
        await BookingHotelRepository.partial_update(hotel["id"], {"custom_domain": domain})
        return _status_response(domain, cf_status)

    # Register with Cloudflare
    try:
        cf_result = await cloudflare_service.create_custom_hostname(domain)
    except ValueError as e:
        cf_status = await cloudflare_service.get_hostname_status(domain)
        if cf_status:
            await BookingHotelRepository.partial_update(hotel["id"], {"custom_domain": domain})
            return _status_response(domain, cf_status)
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        logger.error("Cloudflare create failed for %s: %s", domain, e)
        raise HTTPException(status_code=502, detail=f"Failed to register domain: {e}")

    # Save to DB
    await BookingHotelRepository.partial_update(hotel["id"], {"custom_domain": domain})

    return {
        "domain": domain,
        "status": cf_result.get("status", "pending"),
        "ssl_status": cf_result.get("ssl", {}).get("status", "initializing"),
    }


@router.delete("/settings/custom-domain")
async def disconnect_custom_domain(
    user_id: str = Depends(require_hotel_admin),
    hotel: dict = Depends(require_current_hotel),
):
    current_domain = hotel.get("custom_domain")
    if not current_domain:
        raise HTTPException(status_code=404, detail="No custom domain configured")

    # Remove from Cloudflare
    try:
        await cloudflare_service.delete_custom_hostname(current_domain)
    except Exception as e:
        logger.warning("Cloudflare delete failed for %s: %s", current_domain, e)

    # Clear from DB
    await BookingHotelRepository.partial_update(hotel["id"], {"custom_domain": None})
    return {"removed": current_domain}


@router.get("/settings/custom-domain/status")
async def get_custom_domain_status(
    user_id: str = Depends(require_hotel_admin),
    hotel: dict = Depends(require_current_hotel),
):
    current_domain = hotel.get("custom_domain")
    if not current_domain:
        return {"configured": False}

    status = await cloudflare_service.get_hostname_status(current_domain)
    if not status:
        return {"configured": True, "domain": current_domain, "status": "unknown", "ssl_status": "unknown"}

    return {
        "configured": True,
        "domain": current_domain,
        "status": status["status"],
        "ssl_status": status["ssl_status"],
        "verification_errors": status.get("verification_errors", []),
    }
