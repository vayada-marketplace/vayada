import asyncio
import json as _json
import logging
from typing import Optional, List

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

_client: Optional[httpx.AsyncClient] = None
_throttle = asyncio.Semaphore(1)


class ChannexAPIError(Exception):
    """Raised when Channex returns a non-2xx response.

    Carries the parsed response body so callers (and the UI) can surface the
    *actual* validation reason instead of httpx's generic
    "Client error '422 Unprocessable Content' for url ..." message that
    points users at MDN's HTTP docs.
    """

    def __init__(
        self,
        *,
        method: str,
        path: str,
        status_code: int,
        body: dict | str,
    ):
        self.method = method
        self.path = path
        self.status_code = status_code
        self.body = body
        self.summary = _summarize_channex_errors(path, body)
        super().__init__(self.summary)


def _summarize_channex_errors(path: str, body: dict | str) -> str:
    """Produce a one-line, user-facing summary of a Channex error body.

    Channex error shapes seen in the wild:
      {"errors": {"detail": "..."}}
      {"errors": {"title": ["has already been taken"], "occupancy": ["can't be blank"]}}
      {"errors": [{"detail": "..."}]}
    """
    resource = path.rsplit("/", 1)[-1] or path

    if isinstance(body, str):
        snippet = body.strip()[:200]
        return f"Channex rejected {resource}: {snippet}" if snippet else f"Channex rejected {resource}"

    errors = body.get("errors") if isinstance(body, dict) else None

    if isinstance(errors, dict):
        detail = errors.get("detail")
        if isinstance(detail, str) and detail:
            return f"Channex rejected {resource}: {detail}"
        # Per-field errors: "title has already been taken; occupancy can't be blank"
        parts: list[str] = []
        for field, messages in errors.items():
            if isinstance(messages, list):
                msg = "; ".join(str(m) for m in messages if m)
            else:
                msg = str(messages)
            if msg:
                parts.append(f"{field} {msg}")
        if parts:
            return f"Channex rejected {resource}: {'; '.join(parts)}"

    if isinstance(errors, list):
        msgs = [
            e.get("detail") or e.get("title") or str(e)
            for e in errors
            if e
        ]
        msgs = [m for m in msgs if m]
        if msgs:
            return f"Channex rejected {resource}: {'; '.join(msgs)}"

    return f"Channex rejected {resource} (HTTP error)"


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
        await asyncio.sleep(settings.CHANNEX_API_DELAY_SECONDS)
        if response.status_code >= 400:
            try:
                body = response.json()
            except (ValueError, _json.JSONDecodeError):
                body = response.text
            logger.error(
                "Channex %s %s -> %d: %s",
                method, path, response.status_code, body,
            )
            raise ChannexAPIError(
                method=method,
                path=path,
                status_code=response.status_code,
                body=body,
            )
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

# Map Booking.com meal_plan_code values to Channex's `meal_type` string
# enum. Channex relays meal_type to the OTA as the appropriate channel
# field (e.g. Booking.com's meal_plan_code).
_MEAL_PLAN_CODE_TO_CHANNEX = {
    0: "room_only",
    1: "breakfast",
    3: "half_board",
    4: "full_board",
    9: "all_inclusive",
}


def meal_plan_code_to_channex_meal_type(code: int) -> str:
    return _MEAL_PLAN_CODE_TO_CHANNEX.get(code, "room_only")


async def create_rate_plan(
    api_key: str,
    *,
    property_id: str,
    room_type_id: str,
    title: str,
    options: List[dict],
    sell_mode: str = "per_room",
    rate_mode: str = "manual",
    currency: str = None,
    meal_plan_code: int = 0,
) -> dict:
    """Create a rate plan in Channex linked to a room type.

    `options` must be supplied by the caller — Channex rejects rate plans
    whose occupancy options don't fit the parent room type, so a sensible
    default isn't safe.
    """
    if not options:
        raise ValueError("create_rate_plan requires at least one occupancy option")

    payload = {
        "property_id": property_id,
        "room_type_id": room_type_id,
        "title": title,
        "sell_mode": sell_mode,
        "rate_mode": rate_mode,
        "options": options,
        "meal_type": meal_plan_code_to_channex_meal_type(meal_plan_code),
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


# ── Applications (per-property addon installs) ───────────────────────

MESSAGING_APP_CODE = "channex_messages"


async def list_installed_applications(api_key: str, property_id: str) -> List[dict]:
    data = await _request(
        "GET", "/api/v1/applications/installed", api_key,
        params={"filter[property_id]": property_id},
    )
    return data.get("data", [])


async def install_application(
    api_key: str, property_id: str, application_code: str
) -> dict:
    """Install an application on a Channex property. Idempotent at our layer:
    callers should check `list_installed_applications` first, but Channex itself
    may also reject duplicate installs."""
    data = await _request(
        "POST", "/api/v1/applications/install", api_key,
        json={
            "application_installation": {
                "property_id": property_id,
                "application_code": application_code,
            }
        },
    )
    return data.get("data", data)


async def is_messaging_app_installed(api_key: str, property_id: str) -> bool:
    apps = await list_installed_applications(api_key, property_id)
    for app in apps:
        attrs = app.get("attributes", app) or {}
        if attrs.get("application_code") == MESSAGING_APP_CODE:
            return True
    return False


async def install_messaging_app(api_key: str, property_id: str) -> dict:
    return await install_application(api_key, property_id, MESSAGING_APP_CODE)


# ── Webhooks (account-level subscription) ────────────────────────────

async def list_webhooks(api_key: str) -> List[dict]:
    data = await _request("GET", "/api/v1/webhooks", api_key)
    return data.get("data", [])


async def create_webhook(
    api_key: str,
    *,
    callback_url: str,
    event_mask: str,
    is_global: bool = True,
    property_id: str = None,
    headers: dict = None,
    send_data: bool = True,
    is_active: bool = True,
) -> dict:
    payload = {
        "callback_url": callback_url,
        "event_mask": event_mask,
        "is_global": is_global,
        "send_data": send_data,
        "is_active": is_active,
        "headers": headers or {},
        "request_params": {},
    }
    if property_id:
        payload["property_id"] = property_id
    data = await _request(
        "POST", "/api/v1/webhooks", api_key,
        json={"webhook": payload},
    )
    return data.get("data", data)


async def update_webhook(api_key: str, webhook_id: str, updates: dict) -> dict:
    data = await _request(
        "PUT", f"/api/v1/webhooks/{webhook_id}", api_key,
        json={"webhook": updates},
    )
    return data.get("data", data)


async def delete_webhook(api_key: str, webhook_id: str) -> None:
    await _request("DELETE", f"/api/v1/webhooks/{webhook_id}", api_key)


# ── Messaging ────────────────────────────────────────────────────────

async def list_message_threads(
    api_key: str,
    property_id: str = None,
    *,
    page: int = 1,
    limit: int = 100,
    order: str = "desc",
) -> List[dict]:
    """List message threads. Without property_id, returns threads across the
    whole Channex account (used by the safety-net sweep)."""
    params = {
        "pagination[page]": page,
        "pagination[limit]": limit,
        "order[inserted_at]": order,
    }
    if property_id:
        params["filter[property_id]"] = property_id
    data = await _request(
        "GET", "/api/v1/message_threads", api_key, params=params,
    )
    return data.get("data", [])


async def get_message_thread(api_key: str, thread_id: str) -> dict:
    data = await _request(
        "GET", f"/api/v1/message_threads/{thread_id}", api_key,
    )
    return data.get("data", data)


async def list_thread_messages(
    api_key: str,
    thread_id: str,
    *,
    page: int = 1,
    limit: int = 100,
) -> List[dict]:
    data = await _request(
        "GET", f"/api/v1/message_threads/{thread_id}/messages", api_key,
        params={
            "pagination[page]": page,
            "pagination[limit]": limit,
            "order[inserted_at]": "asc",
        },
    )
    return data.get("data", [])


async def post_thread_message(
    api_key: str,
    thread_id: str,
    *,
    message: str = "",
    attachment_id: str = None,
) -> dict:
    payload: dict = {}
    if message:
        payload["message"] = message
    if attachment_id:
        payload["attachment_id"] = attachment_id
    if not payload:
        raise ValueError("message or attachment_id required")
    data = await _request(
        "POST", f"/api/v1/message_threads/{thread_id}/messages", api_key,
        json={"message": payload},
    )
    return data.get("data", data)


async def close_thread(api_key: str, thread_id: str) -> dict:
    data = await _request(
        "POST", f"/api/v1/message_threads/{thread_id}/close", api_key,
    )
    return data.get("data", data)


async def mark_thread_no_reply_needed(api_key: str, thread_id: str) -> dict:
    """Booking.com only — marks a thread as not requiring a reply (counts toward response time)."""
    data = await _request(
        "POST", f"/api/v1/message_threads/{thread_id}/no_reply_needed", api_key,
    )
    return data.get("data", data)


async def upload_attachment(
    api_key: str,
    *,
    file_bytes: bytes,
    filename: str,
    content_type: str,
) -> dict:
    """Upload an attachment to Channex. Returns the attachment object whose
    `id` is then passed to `post_thread_message` as `attachment_id`."""
    import base64
    payload = {
        "file": base64.b64encode(file_bytes).decode("ascii"),
        "file_name": filename,
        "file_type": content_type,
    }
    data = await _request(
        "POST", "/api/v1/attachments", api_key,
        json={"attachment": payload},
    )
    return data.get("data", data)
