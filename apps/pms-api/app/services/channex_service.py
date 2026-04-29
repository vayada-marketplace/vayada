import asyncio
import logging
from typing import Optional, List

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

_client: Optional[httpx.AsyncClient] = None
_throttle = asyncio.Semaphore(1)


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(
            base_url=settings.CHANNEX_API_BASE_URL,
            timeout=30.0,
        )
    return _client


async def close_client():
    global _client
    if _client and not _client.is_closed:
        await _client.aclose()
        _client = None


def get_platform_api_key() -> str:
    """Return the platform-wide Channex API key from config."""
    if not settings.CHANNEX_API_KEY:
        raise ValueError("CHANNEX_API_KEY not configured")
    return settings.CHANNEX_API_KEY


def _headers(api_key: str) -> dict:
    return {
        "Content-Type": "application/json",
        "user-api-key": api_key,
    }


async def _request(
    method: str,
    path: str,
    api_key: str,
    *,
    json: dict = None,
    params: dict = None,
) -> dict:
    """Execute a Channex API request with rate-limit throttling.

    Uses a semaphore to serialize requests and a configurable delay
    between calls to stay within Channex rate limits (Test 12).
    """
    async with _throttle:
        client = _get_client()
        response = await client.request(
            method, path, headers=_headers(api_key), json=json, params=params
        )
        response.raise_for_status()
        await asyncio.sleep(settings.CHANNEX_API_DELAY_SECONDS)
        if response.status_code == 204:
            return {}
        return response.json()


# ── Connection test ──────────────────────────────────────────────────

async def test_connection(api_key: str) -> bool:
    """Verify an API key is valid by listing properties."""
    try:
        client = _get_client()
        response = await client.get(
            "/api/v1/properties",
            headers=_headers(api_key),
            params={"pagination[page]": 1, "pagination[limit]": 1},
        )
        return response.status_code == 200
    except Exception:
        return False


# ── Properties ───────────────────────────────────────────────────────

async def create_property(
    api_key: str,
    *,
    title: str,
    currency: str,
    property_type: str = None,
    country: str = None,
    state: str = None,
    city: str = None,
    address: str = None,
    zip_code: str = None,
    latitude: float = None,
    longitude: float = None,
    timezone: str = None,
    email: str = None,
    phone: str = None,
) -> dict:
    """Create a property in Channex. Returns the full property object."""
    payload = {"title": title, "currency": currency}
    if property_type:
        payload["property_type"] = property_type
    if country:
        payload["country"] = country
    if state:
        payload["state"] = state
    if city:
        payload["city"] = city
    if address:
        payload["address"] = address
    if zip_code:
        payload["zip_code"] = zip_code
    if latitude is not None:
        payload["latitude"] = latitude
    if longitude is not None:
        payload["longitude"] = longitude
    if timezone:
        payload["timezone"] = timezone
    if email:
        payload["email"] = email
    if phone:
        payload["phone"] = phone

    data = await _request(
        "POST", "/api/v1/properties", api_key,
        json={"property": payload},
    )
    return data.get("data", data)


async def update_property(api_key: str, property_id: str, updates: dict) -> dict:
    """Update a Channex property."""
    data = await _request(
        "PUT", f"/api/v1/properties/{property_id}", api_key,
        json={"property": updates},
    )
    return data.get("data", data)


async def get_property(api_key: str, property_id: str) -> dict:
    data = await _request("GET", f"/api/v1/properties/{property_id}", api_key)
    return data.get("data", data)


async def list_properties(api_key: str) -> List[dict]:
    data = await _request(
        "GET", "/api/v1/properties", api_key,
        params={"pagination[page]": 1, "pagination[limit]": 100},
    )
    return data.get("data", [])


async def delete_property(api_key: str, property_id: str, force: bool = False) -> None:
    params = {"force": "true"} if force else {}
    await _request(
        "DELETE", f"/api/v1/properties/{property_id}", api_key, params=params
    )


# ── Room Types ───────────────────────────────────────────────────────

async def create_room_type(
    api_key: str,
    *,
    property_id: str,
    title: str,
    count_of_rooms: int,
    occ_adults: int,
    occ_children: int = 0,
    occ_infants: int = 0,
    default_occupancy: int = None,
    room_kind: str = "room",
) -> dict:
    """Create a room type in Channex."""
    if default_occupancy is None:
        default_occupancy = occ_adults

    payload = {
        "property_id": property_id,
        "title": title,
        "count_of_rooms": count_of_rooms,
        "occ_adults": occ_adults,
        "occ_children": occ_children,
        "occ_infants": occ_infants,
        "default_occupancy": default_occupancy,
        "room_kind": room_kind,
    }

    data = await _request(
        "POST", "/api/v1/room_types", api_key,
        json={"room_type": payload},
    )
    return data.get("data", data)


async def list_room_types(api_key: str, property_id: str) -> List[dict]:
    data = await _request(
        "GET", "/api/v1/room_types", api_key,
        params={
            "filter[property_id]": property_id,
            "pagination[page]": 1,
            "pagination[limit]": 100,
        },
    )
    return data.get("data", [])


async def delete_room_type(
    api_key: str, room_type_id: str, force: bool = False
) -> None:
    params = {"force": "true"} if force else {}
    await _request(
        "DELETE", f"/api/v1/room_types/{room_type_id}", api_key, params=params
    )


# ── Rate Plans ───────────────────────────────────────────────────────

async def create_rate_plan(
    api_key: str,
    *,
    property_id: str,
    room_type_id: str,
    title: str,
    sell_mode: str = "per_room",
    rate_mode: str = "manual",
    currency: str = None,
    options: List[dict] = None,
) -> dict:
    """Create a rate plan in Channex linked to a room type."""
    if options is None:
        # Default: single occupancy option matching room type default
        options = [{"occupancy": 2, "is_primary": True}]

    payload = {
        "property_id": property_id,
        "room_type_id": room_type_id,
        "title": title,
        "sell_mode": sell_mode,
        "rate_mode": rate_mode,
        "options": options,
    }
    if currency:
        payload["currency"] = currency

    data = await _request(
        "POST", "/api/v1/rate_plans", api_key,
        json={"rate_plan": payload},
    )
    return data.get("data", data)


async def list_rate_plans(api_key: str, property_id: str) -> List[dict]:
    data = await _request(
        "GET", "/api/v1/rate_plans", api_key,
        params={
            "filter[property_id]": property_id,
            "pagination[page]": 1,
            "pagination[limit]": 100,
        },
    )
    return data.get("data", [])


async def update_rate_plan_cancellation_policy(
    api_key: str,
    rate_plan_id: str,
    *,
    policies: List[dict],
) -> dict:
    """Set the cancellation policy on a Channex rate plan.

    Each entry in `policies`: {days_before_arrival, penalty_type, penalty_value}.
    `penalty_type` is "percent" (Channex also accepts "amount" / "first_night"
    but we only emit "percent" today). Passing an empty list inherits the
    property-level default.
    """
    payload = {
        "inherit_cancellation_policy": not policies,
        "cancellation_policies": policies,
    }
    data = await _request(
        "PUT", f"/api/v1/rate_plans/{rate_plan_id}", api_key,
        json={"rate_plan": payload},
    )
    return data.get("data", data)


# ── Channels ─────────────────────────────────────────────────────────

async def list_channels(api_key: str, property_id: str) -> List[dict]:
    """List OTA channels connected to a Channex property.

    Each item has attributes.application (e.g. "BookingCom", "Airbnb",
    "Expedia") and attributes.is_active.
    """
    data = await _request(
        "GET", "/api/v1/channels", api_key,
        params={
            "filter[property_id]": property_id,
            "pagination[page]": 1,
            "pagination[limit]": 100,
        },
    )
    return data.get("data", [])


async def delete_rate_plan(
    api_key: str, rate_plan_id: str, force: bool = False
) -> None:
    params = {"force": "true"} if force else {}
    await _request(
        "DELETE", f"/api/v1/rate_plans/{rate_plan_id}", api_key, params=params
    )


# ── ARI: Availability ────────────────────────────────────────────────

async def push_availability(
    api_key: str,
    values: List[dict],
) -> dict:
    """Push availability updates to Channex.

    Each value: {property_id, room_type_id, date_from, date_to, availability}
    """
    data = await _request(
        "POST", "/api/v1/availability", api_key,
        json={"values": values},
    )
    return data


async def get_availability(
    api_key: str,
    property_id: str,
    date_from: str,
    date_to: str,
) -> dict:
    data = await _request(
        "GET", "/api/v1/availability", api_key,
        params={
            "filter[property_id]": property_id,
            "filter[date][gte]": date_from,
            "filter[date][lte]": date_to,
        },
    )
    return data.get("data", {})


# ── ARI: Restrictions (rates + rules) ────────────────────────────────

async def push_restrictions(
    api_key: str,
    values: List[dict],
) -> dict:
    """Push rate/restriction updates to Channex.

    Each value: {property_id, rate_plan_id, date_from, date_to, rate, min_stay_arrival, ...}
    """
    data = await _request(
        "POST", "/api/v1/restrictions", api_key,
        json={"values": values},
    )
    return data


async def get_restrictions(
    api_key: str,
    property_id: str,
    date_from: str,
    date_to: str,
) -> dict:
    data = await _request(
        "GET", "/api/v1/restrictions", api_key,
        params={
            "filter[property_id]": property_id,
            "filter[date][gte]": date_from,
            "filter[date][lte]": date_to,
        },
    )
    return data.get("data", {})


# ── Bookings ─────────────────────────────────────────────────────────

async def get_booking_revisions_feed(
    api_key: str,
    property_id: str = None,
) -> List[dict]:
    """Fetch unacknowledged booking revisions (the primary PMS polling method)."""
    params = {}
    if property_id:
        params["filter[property_id]"] = property_id
    params["order[inserted_at]"] = "asc"

    data = await _request(
        "GET", "/api/v1/booking_revisions/feed", api_key,
        params=params,
    )
    return data.get("data", [])


async def acknowledge_booking_revision(api_key: str, revision_id: str) -> dict:
    """Acknowledge receipt of a booking revision (prevents re-delivery)."""
    return await _request(
        "POST", f"/api/v1/booking_revisions/{revision_id}/ack", api_key,
    )


async def get_booking(api_key: str, booking_id: str) -> dict:
    data = await _request(
        "GET", f"/api/v1/bookings/{booking_id}", api_key,
    )
    return data.get("data", data)


async def list_bookings(
    api_key: str,
    property_id: str = None,
    arrival_gte: str = None,
    arrival_lte: str = None,
) -> List[dict]:
    params = {"pagination[page]": 1, "pagination[limit]": 100}
    if property_id:
        params["filter[property_id]"] = property_id
    if arrival_gte:
        params["filter[arrival_date][gte]"] = arrival_gte
    if arrival_lte:
        params["filter[arrival_date][lte]"] = arrival_lte

    data = await _request("GET", "/api/v1/bookings", api_key, params=params)
    return data.get("data", [])


async def report_no_show(
    api_key: str, booking_id: str, waived_fees: bool = False
) -> dict:
    return await _request(
        "POST", f"/api/v1/bookings/{booking_id}/no_show", api_key,
        json={"no_show_report": {"waived_fees": waived_fees}},
    )


# ── Channel IFrame ──────────────────────────────────────────────────

async def create_iframe_token(
    api_key: str,
    property_id: str,
    username: str = "pms_user",
) -> str:
    """Generate a one-time token for the Channex channel management iframe.
    Token is valid for 15 minutes and invalidated after first use."""
    data = await _request(
        "POST", "/api/v1/auth/one_time_token", api_key,
        json={
            "one_time_token": {
                "property_id": property_id,
                "username": username,
            }
        },
    )
    return data["data"]["token"]


def build_iframe_url(
    token: str,
    property_id: str,
    channels: str = None,
    language: str = "en",
) -> str:
    """Build the Channex iframe URL for channel management.

    Args:
        token: One-time access token from create_iframe_token()
        property_id: Channex property ID
        channels: Optional comma-separated channel codes to show (e.g. "BDC,ABB")
        language: UI language code (en, es, de, fr, it, etc.)
    """
    base = settings.CHANNEX_API_BASE_URL
    url = (
        f"{base}/auth/exchange"
        f"?oauth_session_key={token}"
        f"&app_mode=headless"
        f"&redirect_to=/channels"
        f"&property_id={property_id}"
        f"&lng={language}"
    )
    if channels:
        url += f"&channels={channels}"
    return url
