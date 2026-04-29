import json
import logging

from fastapi import APIRouter, HTTPException, Depends

from app.config import settings as app_settings
from app.dependencies import require_hotel_admin
from app.database import AuthDatabase, BookingEngineDatabase
from app.utils import get_hotel_id, parse_jsonb
from app.repositories.hotel_repo import HotelRepository
from app.models.hotel import (
    HotelRegister,
    HotelResponse,
    HotelBenefitsUpdate,
    HotelBenefitsResponse,
    GuestFormSettingsResponse,
    GuestFormSettingsUpdate,
    SetupStatusResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["admin"])


def _hotel_response(row: dict, slug: str = None, name: str = None, contact_email: str = None) -> HotelResponse:
    """Build a HotelResponse from a basic-shape row, optionally overriding
    fields with values the caller is about to write."""
    return HotelResponse(
        id=str(row["id"]),
        slug=slug if slug is not None else row["slug"],
        name=name if name is not None else row["name"],
        contact_email=contact_email if contact_email is not None else row["contact_email"],
        user_id=str(row["user_id"]),
        created_at=row["created_at"].isoformat(),
    )


def _hotel_to_dict(row: dict) -> dict:
    """Serialize a full hotel row for the GET/PATCH endpoints."""
    lm = row.get("last_minute_discount")
    return {
        "id": str(row["id"]),
        "slug": row["slug"],
        "name": row["name"],
        "contact_email": row.get("contact_email", ""),
        "property_type": row.get("property_type", "guest_house"),
        "timezone": row.get("timezone", ""),
        "country": row.get("country", ""),
        "state": row.get("state", ""),
        "city": row.get("city", ""),
        "address": row.get("address", ""),
        "zip_code": row.get("zip_code", ""),
        "phone": row.get("phone", ""),
        "latitude": float(row["latitude"]) if row.get("latitude") is not None else None,
        "longitude": float(row["longitude"]) if row.get("longitude") is not None else None,
        "last_minute_discount": json.loads(lm) if isinstance(lm, str) else lm,
        "instant_book": bool(row.get("instant_book", False)),
    }


# ── Hotel Registration ─────────────────────────────────────────────


@router.post("/register-hotel", response_model=HotelResponse, status_code=201)
async def register_hotel(
    data: HotelRegister,
    user_id: str = Depends(require_hotel_admin),
):
    """
    Create or update the PMS row for a hotel.

    Two modes:

    1. With `booking_hotel_id` (the correct, multi-hotel-safe mode): look
       up the PMS row by `id = booking_hotel_id` and either insert a new
       row using that id as the PK, or update the existing row's
       slug/name/contact_email. This is the mode used by the setup
       wizard after the multi-hotel-ids migration.

    2. Without `booking_hotel_id` (legacy, single-hotel-per-user mode):
       look up the PMS row by `user_id` and upsert. Preserved only for
       back-compat with callers that predate the multi-hotel migration;
       emits a warning when hit. Do not add new callers that rely on
       this mode — it silently reuses the first hotel if the user
       already has one, which is the old bug we're trying to kill.
    """
    if data.booking_hotel_id:
        existing = await HotelRepository.get_by_id(data.booking_hotel_id)
        if existing:
            if str(existing["user_id"]) != user_id:
                raise HTTPException(
                    status_code=403,
                    detail="This booking_hotel_id belongs to a different user",
                )
            if (
                existing["slug"] != data.slug
                or existing["name"] != data.name
                or existing["contact_email"] != data.contact_email
            ):
                await HotelRepository.update_basic(
                    str(existing["id"]), data.slug, data.name, data.contact_email,
                )
            return _hotel_response(existing, data.slug, data.name, data.contact_email)

        row = await HotelRepository.create(
            data.slug, data.name, data.contact_email, user_id,
            hotel_id=data.booking_hotel_id,
        )
        return _hotel_response(row)

    # Legacy path — no booking_hotel_id. Warn and fall back to the
    # single-hotel-per-user behavior.
    logger.warning(
        "register_hotel called without booking_hotel_id for user_id=%s slug=%s. "
        "This is the legacy single-hotel path and will be removed; callers "
        "must be updated to pass booking_hotel_id.",
        user_id, data.slug,
    )
    existing = await HotelRepository.get_oldest_for_user(user_id)
    if existing:
        if existing["slug"] != data.slug or existing["name"] != data.name:
            await HotelRepository.update_basic(
                str(existing["id"]), data.slug, data.name, data.contact_email,
            )
        return _hotel_response(existing, data.slug, data.name, data.contact_email)

    row = await HotelRepository.create(data.slug, data.name, data.contact_email, user_id)
    return _hotel_response(row)


@router.get("/hotel")
async def get_hotel(user_id: str = Depends(require_hotel_admin)):
    """Get the current hotel's details including last-minute discount config.

    Scoped by X-Hotel-Id via get_hotel_id (falls back to the user's
    oldest hotel when no header is present — same multi-hotel rules
    as every other admin endpoint).
    """
    hotel_id = await get_hotel_id(user_id)
    row = await HotelRepository.get_by_id(hotel_id)
    if not row:
        raise HTTPException(status_code=404, detail="Hotel not found")
    return _hotel_to_dict(row)


@router.patch("/hotel")
async def update_hotel(
    data: dict,
    user_id: str = Depends(require_hotel_admin),
):
    """Update hotel details (slug, name, email, last_minute_discount, etc.)."""
    hotel_id = await get_hotel_id(user_id)
    row = await HotelRepository.update_fields(hotel_id, data)
    if not row:
        raise HTTPException(status_code=400, detail="No fields to update")

    # Sync instant_book to booking_db so the booking-engine frontend (which
    # reads /api/hotels/{slug} from the BE backend) can adjust the checkout
    # CTA copy. Surface failures: silent drift here would show guests a
    # "Submit Booking Request" button that immediately confirms — exactly the
    # contradictory UX we're trying to avoid.
    if "instant_book" in data and app_settings.BOOKING_ENGINE_DATABASE_URL:
        try:
            await BookingEngineDatabase.execute(
                "UPDATE booking_hotels SET instant_book = $2 WHERE id = $1",
                hotel_id, bool(data["instant_book"]),
            )
        except Exception as e:
            logger.error("Failed to sync instant_book to booking engine: %s", e)
            raise HTTPException(
                status_code=502,
                detail="Failed to sync booking-acceptance setting to booking engine. Please retry.",
            )

    return _hotel_to_dict(row)


@router.get("/setup-status", response_model=SetupStatusResponse)
async def get_setup_status(
    user_id: str = Depends(require_hotel_admin),
):
    """Setup status for the selected hotel (or the user's oldest).

    This endpoint also auto-creates an empty PMS hotel for users who
    log into the PMS without yet having one — but only when no
    X-Hotel-Id header is present, since a header explicitly targets
    an existing hotel and "no hotel" there should be a 403, not
    silent auto-creation of a new one.
    """
    from app.utils import _current_hotel_id_override

    header_id = _current_hotel_id_override.get()
    if header_id:
        # Header mode: find the specific hotel, don't auto-create.
        owned_id = await HotelRepository.get_owned_id(header_id, user_id)
        if not owned_id:
            raise HTTPException(
                status_code=403,
                detail="X-Hotel-Id does not match any hotel owned by this user",
            )
        hotel_id = owned_id
    else:
        oldest = await HotelRepository.get_oldest_for_user(user_id)
        # Auto-register: if no PMS hotel exists yet, create one from the auth profile
        if not oldest:
            try:
                user = await AuthDatabase.fetchrow(
                    "SELECT name, email FROM users WHERE id = $1", user_id
                )
                if user and user["name"]:
                    import re
                    import uuid
                    base_slug = re.sub(r'[^a-z0-9]+', '-', user["name"].lower()).strip('-')
                    slug = base_slug or "hotel"
                    # Append short suffix to avoid slug collisions
                    slug = f"{slug}-{uuid.uuid4().hex[:6]}"
                    oldest = await HotelRepository.create(
                        slug, user["name"], user["email"], user_id,
                    )
            except Exception as e:
                logger.error(f"Auto-register hotel failed for user {user_id}: {e}")

        if not oldest:
            return SetupStatusResponse(registered=False, setup_complete=False, room_count=0)
        hotel_id = str(oldest["id"])

    room_count = await HotelRepository.count_room_types(hotel_id)
    return SetupStatusResponse(
        registered=True,
        setup_complete=room_count > 0,
        room_count=room_count,
    )


# ── Book Direct Benefits ──────────────────────────────────────────


@router.get("/benefits", response_model=HotelBenefitsResponse)
async def get_benefits(user_id: str = Depends(require_hotel_admin)):
    hotel_id = await get_hotel_id(user_id)
    raw = await HotelRepository.get_benefits_raw(hotel_id)
    return HotelBenefitsResponse(benefits=parse_jsonb(raw) if raw is not None else [])


@router.put("/benefits", response_model=HotelBenefitsResponse)
async def update_benefits(
    data: HotelBenefitsUpdate,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    await HotelRepository.update_benefits(hotel_id, data.benefits)
    return HotelBenefitsResponse(benefits=data.benefits)


# ── Guest Form Settings ──────────────────────────────────────────


@router.get("/guest-form-settings", response_model=GuestFormSettingsResponse)
async def get_guest_form_settings(user_id: str = Depends(require_hotel_admin)):
    hotel_id = await get_hotel_id(user_id)
    row = await HotelRepository.get_guest_form_settings(hotel_id)
    if not row:
        return GuestFormSettingsResponse()
    return GuestFormSettingsResponse(
        special_requests_enabled=row["special_requests_enabled"],
        arrival_time_enabled=row["arrival_time_enabled"],
        guest_count_enabled=row["guest_count_enabled"],
    )


@router.patch("/guest-form-settings", response_model=GuestFormSettingsResponse)
async def update_guest_form_settings(
    data: GuestFormSettingsUpdate,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    updates = {k: v for k, v in data.model_dump().items() if v is not None}
    await HotelRepository.update_guest_form_settings(hotel_id, updates)
    row = await HotelRepository.get_guest_form_settings(hotel_id)
    return GuestFormSettingsResponse(
        special_requests_enabled=row["special_requests_enabled"],
        arrival_time_enabled=row["arrival_time_enabled"],
        guest_count_enabled=row["guest_count_enabled"],
    )
