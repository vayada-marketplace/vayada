import json
import logging

from fastapi import APIRouter, Depends, HTTPException

from app.database import AuthDatabase
from app.dependencies import require_hotel_admin
from app.models.hotel import (
    CalendarSettingsResponse,
    CalendarSettingsUpdate,
    GuestFormSettingsResponse,
    GuestFormSettingsUpdate,
    HotelBenefitsResponse,
    HotelBenefitsUpdate,
    HotelDeletionImpactResponse,
    HotelDetailsResponse,
    HotelRegister,
    HotelResponse,
    SameDayBookingSettingsUpdate,
    SetupStatusResponse,
)
from app.repositories.channex_mapping_repo import ChannexConnectionRepository
from app.repositories.hotel_repo import HotelRepository
from app.services import channex_service, hotel_identity_service
from app.services.calendar_auto_open_service import apply_auto_open_for_hotel, collect_rate_warnings
from app.utils import get_hotel_id, parse_jsonb

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["admin"])


def _normalize_last_minute_discount(value):
    if not isinstance(value, dict) or not value.get("enabled"):
        return {"enabled": False, "stackWithPromo": False, "tiers": []}

    tiers = []
    for tier in value.get("tiers") or []:
        if not isinstance(tier, dict):
            continue
        try:
            days_before_min = max(0, int(tier.get("daysBeforeMin") or 0))
            raw_max = tier.get("daysBeforeMax")
            days_before_max = None if raw_max is None else max(0, int(raw_max))
            discount_percent = int(tier.get("discountPercent") or 0)
        except (TypeError, ValueError):
            continue
        if discount_percent <= 0:
            continue
        tiers.append(
            {
                "daysBeforeMin": days_before_min,
                "daysBeforeMax": days_before_max,
                "discountPercent": min(discount_percent, 90),
            }
        )

    return {
        "enabled": True,
        "stackWithPromo": bool(value.get("stackWithPromo", False)),
        "tiers": tiers,
    }


def _hotel_response(
    row: dict, slug: str = None, name: str = None, contact_email: str = None
) -> HotelResponse:
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


def _hotel_to_details(row: dict) -> HotelDetailsResponse:
    """Serialize a full hotel row for the GET/PATCH endpoints."""
    lm = row.get("last_minute_discount")
    return HotelDetailsResponse(
        id=str(row["id"]),
        slug=row["slug"],
        name=row["name"],
        contact_email=row.get("contact_email", "") or "",
        property_type=row.get("property_type", "guest_house") or "guest_house",
        timezone=row.get("timezone", "") or "",
        country=row.get("country", "") or "",
        state=row.get("state", "") or "",
        city=row.get("city", "") or "",
        address=row.get("address", "") or "",
        zip_code=row.get("zip_code", "") or "",
        phone=row.get("phone", "") or "",
        latitude=float(row["latitude"]) if row.get("latitude") is not None else None,
        longitude=float(row["longitude"]) if row.get("longitude") is not None else None,
        last_minute_discount=json.loads(lm) if isinstance(lm, str) else lm,
        instant_book=bool(row.get("instant_book", False)),
        same_day_bookings_enabled=bool(row.get("same_day_bookings_enabled", True)),
        same_day_booking_cutoff_time=row.get("same_day_booking_cutoff_time") or "18:00",
    )


async def _sync_same_day_cutoff_to_channex(hotel_id: str, data: dict) -> None:
    conn = await ChannexConnectionRepository.get_by_hotel_id(hotel_id)
    if not conn or not conn.get("is_active") or not conn.get("channex_property_id"):
        return

    enabled = bool(data.get("same_day_bookings_enabled", True))
    cutoff_time = data.get("same_day_booking_cutoff_time")
    if enabled and cutoff_time:
        settings_payload = {
            "cut_off_time": f"{cutoff_time}:00",
            "cut_off_days": 0,
        }
    else:
        settings_payload = {
            "cut_off_time": None,
            "cut_off_days": None,
        }

    api_key = channex_service.get_platform_api_key()
    await channex_service.update_property(
        api_key,
        str(conn["channex_property_id"]),
        {"settings": settings_payload},
    )


def _calendar_settings_response(
    row: dict, warnings: list[str] | None = None
) -> CalendarSettingsResponse:
    return CalendarSettingsResponse(
        auto_rearrange_enabled=True
        if row.get("auto_rearrange_enabled") is None
        else bool(row.get("auto_rearrange_enabled")),
        auto_open_enabled=bool(row.get("calendar_auto_open_enabled", False)),
        auto_open_mode=row.get("calendar_auto_open_mode") or "rolling",
        auto_open_months=int(row.get("calendar_auto_open_months") or 18),
        auto_open_fixed_month=row.get("calendar_auto_open_fixed_month"),
        auto_open_through=row.get("calendar_auto_open_through"),
        auto_open_warnings=warnings or [],
    )


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
                    str(existing["id"]),
                    data.slug,
                    data.name,
                    data.contact_email,
                )
            return _hotel_response(existing, data.slug, data.name, data.contact_email)

        row = await HotelRepository.create(
            data.slug,
            data.name,
            data.contact_email,
            user_id,
            hotel_id=data.booking_hotel_id,
        )
        return _hotel_response(row)

    # Legacy path — no booking_hotel_id. Warn and fall back to the
    # single-hotel-per-user behavior.
    logger.warning(
        "register_hotel called without booking_hotel_id for user_id=%s slug=%s. "
        "This is the legacy single-hotel path and will be removed; callers "
        "must be updated to pass booking_hotel_id.",
        user_id,
        data.slug,
    )
    existing = await HotelRepository.get_oldest_for_user(user_id)
    if existing:
        if existing["slug"] != data.slug or existing["name"] != data.name:
            await HotelRepository.update_basic(
                str(existing["id"]),
                data.slug,
                data.name,
                data.contact_email,
            )
        return _hotel_response(existing, data.slug, data.name, data.contact_email)

    row = await HotelRepository.create(data.slug, data.name, data.contact_email, user_id)
    return _hotel_response(row)


@router.get("/hotel", response_model=HotelDetailsResponse)
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
    return _hotel_to_details(row)


@router.patch("/hotel", response_model=HotelDetailsResponse)
async def update_hotel(
    data: dict,
    user_id: str = Depends(require_hotel_admin),
):
    """Update hotel details (slug, name, email, last_minute_discount, etc.)."""
    hotel_id = await get_hotel_id(user_id)
    if "last_minute_discount" in data:
        data["last_minute_discount"] = _normalize_last_minute_discount(
            data.get("last_minute_discount")
        )
    same_day_changed = (
        "same_day_bookings_enabled" in data
        or "sameDayBookingsEnabled" in data
        or "same_day_booking_cutoff_time" in data
        or "sameDayBookingCutoffTime" in data
    )
    if same_day_changed:
        same_day_data = SameDayBookingSettingsUpdate.model_validate(data).model_dump(
            exclude_none=False
        )
        if "sameDayBookingsEnabled" in data:
            data["same_day_bookings_enabled"] = same_day_data["same_day_bookings_enabled"]
        if "same_day_bookings_enabled" in data:
            data["same_day_bookings_enabled"] = same_day_data["same_day_bookings_enabled"]
        if "sameDayBookingCutoffTime" in data:
            data["same_day_booking_cutoff_time"] = same_day_data["same_day_booking_cutoff_time"]
        if "same_day_booking_cutoff_time" in data:
            data["same_day_booking_cutoff_time"] = same_day_data["same_day_booking_cutoff_time"]

    row = await HotelRepository.update_fields(hotel_id, data)
    if not row:
        raise HTTPException(status_code=400, detail="No fields to update")

    # Sync instant_book to booking_db so the booking-engine frontend can
    # adjust the checkout CTA copy. Surface failures: silent drift here
    # would show guests a "Submit Booking Request" button that immediately
    # confirms — exactly the contradictory UX we're trying to avoid.
    if "instant_book" in data:
        try:
            await hotel_identity_service.set_instant_book(hotel_id, data["instant_book"])
        except Exception as e:
            logger.error("Failed to sync instant_book to booking engine: %s", e)
            raise HTTPException(
                status_code=502,
                detail="Failed to sync booking-acceptance setting to booking engine. Please retry.",
            ) from e

    if same_day_changed:
        try:
            await _sync_same_day_cutoff_to_channex(hotel_id, row)
        except Exception as e:
            logger.error("Failed to sync same-day cutoff to Channex: %s", e)
            raise HTTPException(
                status_code=502,
                detail="Saved locally, but failed to sync same-day cutoff to Channex. Please retry.",
            ) from e

    return _hotel_to_details(row)


@router.get("/hotel/deletion-impact", response_model=HotelDeletionImpactResponse)
async def get_hotel_deletion_impact(user_id: str = Depends(require_hotel_admin)):
    """Counts shown to the user before they confirm a property delete:
    upcoming bookings (so they know what guests still need handling) and
    active OTA channel connections (so they know what to clean up on the
    OTA side after the delete)."""
    hotel_id = await get_hotel_id(user_id)
    return HotelDeletionImpactResponse(
        upcoming_bookings_count=await HotelRepository.count_upcoming_bookings(hotel_id),
        connected_channels_count=await HotelRepository.count_active_channel_connections(hotel_id),
    )


@router.delete("/hotel", status_code=204)
async def delete_hotel(user_id: str = Depends(require_hotel_admin)):
    """Permanently delete the hotel scoped by X-Hotel-Id.

    Best-effort Channex deprovision first — failures are logged but do
    not block the local delete, since the user has already been warned
    that they may need to clean up the OTA side manually. The DB delete
    cascades to bookings, room types, rooms, room blocks, payments,
    channex/beds24 connections, etc.
    """
    hotel_id = await get_hotel_id(user_id)

    connection = await ChannexConnectionRepository.get_by_hotel_id(hotel_id)
    if connection and connection.get("channex_property_id"):
        try:
            api_key = channex_service.get_platform_api_key()
            await channex_service.delete_property(
                api_key,
                connection["channex_property_id"],
                force=True,
            )
        except Exception as e:
            logger.warning(
                "Channex deprovision failed for hotel %s during delete (continuing): %s",
                hotel_id,
                e,
            )

    deleted = await HotelRepository.delete(hotel_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Hotel not found")
    logger.info("User %s deleted PMS hotel %s", user_id, hotel_id)
    return None


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

                    base_slug = re.sub(r"[^a-z0-9]+", "-", user["name"].lower()).strip("-")
                    slug = base_slug or "hotel"
                    # Append short suffix to avoid slug collisions
                    slug = f"{slug}-{uuid.uuid4().hex[:6]}"
                    oldest = await HotelRepository.create(
                        slug,
                        user["name"],
                        user["email"],
                        user_id,
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


# ── Calendar Settings ────────────────────────────────────────────


@router.get("/calendar-settings", response_model=CalendarSettingsResponse)
async def get_calendar_settings(user_id: str = Depends(require_hotel_admin)):
    """Per-hotel calendar behavior settings."""
    hotel_id = await get_hotel_id(user_id)
    row = await HotelRepository.get_calendar_settings(hotel_id)
    if not row:
        raise HTTPException(status_code=404, detail="Hotel not found")
    warnings = await collect_rate_warnings(
        hotel_id,
        row.get("calendar_auto_open_through"),
        row.get("timezone"),
    )
    return _calendar_settings_response(row, warnings)


@router.patch("/calendar-settings", response_model=CalendarSettingsResponse)
async def update_calendar_settings(
    data: CalendarSettingsUpdate,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    updates = data.model_dump(exclude_unset=True)
    db_updates = {}
    if "auto_rearrange_enabled" in updates:
        db_updates["auto_rearrange_enabled"] = updates["auto_rearrange_enabled"]
    if "auto_open_enabled" in updates:
        db_updates["calendar_auto_open_enabled"] = updates["auto_open_enabled"]
    if "auto_open_mode" in updates:
        db_updates["calendar_auto_open_mode"] = updates["auto_open_mode"]
    if "auto_open_months" in updates:
        db_updates["calendar_auto_open_months"] = updates["auto_open_months"]
    if "auto_open_fixed_month" in updates:
        fixed = updates["auto_open_fixed_month"]
        db_updates["calendar_auto_open_fixed_month"] = fixed.replace(day=1) if fixed else None

    current = await HotelRepository.get_calendar_settings(hotel_id)
    if not current:
        raise HTTPException(status_code=404, detail="Hotel not found")

    next_enabled = db_updates.get(
        "calendar_auto_open_enabled", current.get("calendar_auto_open_enabled", False)
    )
    next_mode = db_updates.get(
        "calendar_auto_open_mode", current.get("calendar_auto_open_mode") or "rolling"
    )
    next_fixed_month = db_updates.get(
        "calendar_auto_open_fixed_month", current.get("calendar_auto_open_fixed_month")
    )
    if next_enabled and next_mode == "fixed" and not next_fixed_month:
        raise HTTPException(status_code=400, detail="Fixed auto-open requires a target month")

    auto_open_fields = {
        "calendar_auto_open_enabled",
        "calendar_auto_open_mode",
        "calendar_auto_open_months",
        "calendar_auto_open_fixed_month",
    }
    auto_open_fields_changed = any(
        key in db_updates and db_updates[key] != current.get(key) for key in auto_open_fields
    )

    row = await HotelRepository.update_calendar_settings(hotel_id, db_updates)
    warnings: list[str] = []
    if next_enabled and auto_open_fields_changed:
        applied = await apply_auto_open_for_hotel(hotel_id)
        row = await HotelRepository.get_calendar_settings(hotel_id)
        warnings = applied.warnings
    elif row:
        warnings = await collect_rate_warnings(
            hotel_id,
            row.get("calendar_auto_open_through"),
            row.get("timezone"),
        )

    if not row:
        raise HTTPException(status_code=404, detail="Hotel not found")

    return _calendar_settings_response(row, warnings)
