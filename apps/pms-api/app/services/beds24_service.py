import asyncio
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional, List

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

_client: Optional[httpx.AsyncClient] = None
_lock = asyncio.Lock()


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(
            base_url=settings.BEDS24_API_BASE_URL,
            timeout=30.0,
        )
    return _client


async def close_client():
    global _client
    if _client and not _client.is_closed:
        await _client.aclose()
        _client = None


async def _rate_limited_request(
    method: str,
    path: str,
    token: str,
    *,
    json: dict = None,
    params: dict = None,
) -> dict:
    """Execute an API request with rate limiting (one at a time + delay)."""
    async with _lock:
        client = _get_client()
        headers = {"Authorization": f"Bearer {token}"}
        response = await client.request(
            method, path, headers={"token": token}, json=json, params=params
        )
        response.raise_for_status()
        await asyncio.sleep(settings.BEDS24_API_DELAY_SECONDS)
        return response.json()


async def _ensure_valid_token(hotel_id: str) -> str:
    """Check token expiry and refresh if within 5 minutes of expiry. Returns valid token."""
    from app.repositories.beds24_mapping_repo import Beds24ConnectionRepository

    conn = await Beds24ConnectionRepository.get_by_hotel_id(hotel_id)
    if not conn:
        raise ValueError("No Beds24 connection for this hotel")
    if not conn["is_active"]:
        raise ValueError("Beds24 connection is deactivated")

    # Check if token needs refresh (within 5 min of expiry)
    expires_at = conn["token_expires_at"]
    if isinstance(expires_at, str):
        expires_at = datetime.fromisoformat(expires_at)
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)

    if datetime.now(timezone.utc) >= expires_at - timedelta(minutes=5):
        # Refresh token
        client = _get_client()
        response = await client.get(
            "/authentication/token",
            headers={"refreshToken": conn['refresh_token']},
        )
        response.raise_for_status()
        data = response.json()

        new_token = data["token"]
        new_expires = datetime.now(timezone.utc) + timedelta(seconds=data.get("expiresIn", 3600))

        await Beds24ConnectionRepository.update_tokens(
            hotel_id, new_token, conn["refresh_token"], new_expires
        )
        return new_token

    return conn["api_token"]


async def setup_connection(hotel_id: str, invite_code: str) -> dict:
    """Exchange an invite code for API tokens and store the connection."""
    from app.repositories.beds24_mapping_repo import Beds24ConnectionRepository

    client = _get_client()
    response = await client.get(
        "/authentication/setup",
        headers={"code": invite_code},
    )
    response.raise_for_status()
    data = response.json()

    token = data["token"]
    refresh_token = data.get("refreshToken", token)
    expires_in = data.get("expiresIn", 3600)
    expires_at = datetime.now(timezone.utc) + timedelta(seconds=expires_in)

    conn = await Beds24ConnectionRepository.upsert(
        hotel_id=hotel_id,
        api_token=token,
        refresh_token=refresh_token,
        token_expires_at=expires_at,
    )
    return conn


async def get_properties(hotel_id: str) -> List[dict]:
    """List properties accessible via this connection."""
    token = await _ensure_valid_token(hotel_id)
    data = await _rate_limited_request("GET", "/properties", token)
    properties = data if isinstance(data, list) else data.get("data", [])
    return [{"id": str(p["id"]), "name": p.get("name", "")} for p in properties]


async def get_property_rooms(hotel_id: str, property_id: str) -> List[dict]:
    """List rooms for a given Beds24 property."""
    token = await _ensure_valid_token(hotel_id)
    data = await _rate_limited_request(
        "GET", "/properties/rooms", token, params={"propertyId": property_id}
    )
    rooms = data if isinstance(data, list) else data.get("data", [])
    return [
        {"id": str(r["id"]), "name": r.get("name", ""), "qty": r.get("qty", 1)}
        for r in rooms
    ]


async def set_room_calendar(
    hotel_id: str,
    beds24_room_id: str,
    calendar_data: List[dict],
) -> dict:
    """Push availability/rate data for a room. calendar_data is a list of date entries."""
    token = await _ensure_valid_token(hotel_id)
    payload = {
        "roomId": beds24_room_id,
        "calendar": calendar_data,
    }
    return await _rate_limited_request("POST", "/rooms/calendar", token, json=payload)


async def get_bookings(
    hotel_id: str,
    *,
    property_id: Optional[str] = None,
    modified_since: Optional[datetime] = None,
) -> List[dict]:
    """Fetch bookings from Beds24, optionally filtered by modification time."""
    token = await _ensure_valid_token(hotel_id)
    params = {}
    if property_id:
        params["propertyId"] = property_id
    if modified_since:
        params["modifiedSince"] = modified_since.strftime("%Y-%m-%dT%H:%M:%S")

    data = await _rate_limited_request("GET", "/bookings", token, params=params)
    return data if isinstance(data, list) else data.get("data", [])


async def get_messages(
    hotel_id: str,
    *,
    modified_since: Optional[datetime] = None,
) -> List[dict]:
    """Fetch messages from Beds24 for all bookings."""
    token = await _ensure_valid_token(hotel_id)
    params = {}
    if modified_since:
        params["modifiedSince"] = modified_since.strftime("%Y-%m-%dT%H:%M:%S")

    data = await _rate_limited_request("GET", "/bookings/messages", token, params=params)
    return data if isinstance(data, list) else data.get("data", [])


async def send_message(hotel_id: str, beds24_booking_id: str, message: str) -> dict:
    """Send a message via Beds24 (routes to OTA channel)."""
    token = await _ensure_valid_token(hotel_id)
    payload = [{"bookingId": beds24_booking_id, "message": message, "type": "host"}]
    return await _rate_limited_request("POST", "/bookings/messages", token, json=payload)


async def cancel_booking(hotel_id: str, beds24_booking_id: str) -> dict:
    """Cancel a booking on Beds24."""
    token = await _ensure_valid_token(hotel_id)
    return await _rate_limited_request(
        "PUT",
        f"/bookings/{beds24_booking_id}",
        token,
        json={"status": "cancelled"},
    )
