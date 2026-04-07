import json
import logging

from fastapi import APIRouter, HTTPException, Depends

from app.dependencies import require_hotel_admin
from app.database import Database, AuthDatabase
from app.utils import get_hotel_id, parse_jsonb
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


# ── Hotel Registration ─────────────────────────────────────────────


@router.post("/register-hotel", response_model=HotelResponse, status_code=201)
async def register_hotel(
    data: HotelRegister,
    user_id: str = Depends(require_hotel_admin),
):
    # Idempotent: update slug/name if hotel already registered
    existing = await Database.fetchrow(
        "SELECT id, slug, name, contact_email, user_id, created_at FROM hotels WHERE user_id = $1",
        user_id,
    )
    if existing:
        # Keep slug in sync with booking engine
        if existing["slug"] != data.slug or existing["name"] != data.name:
            await Database.execute(
                "UPDATE hotels SET slug = $1, name = $2, contact_email = $3 WHERE id = $4",
                data.slug, data.name, data.contact_email, str(existing["id"]),
            )
        return HotelResponse(
            id=str(existing["id"]),
            slug=data.slug,
            name=data.name,
            contact_email=data.contact_email,
            user_id=str(existing["user_id"]),
            created_at=existing["created_at"].isoformat(),
        )

    row = await Database.fetchrow(
        """INSERT INTO hotels (slug, name, contact_email, user_id)
           VALUES ($1, $2, $3, $4)
           RETURNING id, slug, name, contact_email, user_id, created_at""",
        data.slug,
        data.name,
        data.contact_email,
        user_id,
    )
    return HotelResponse(
        id=str(row["id"]),
        slug=row["slug"],
        name=row["name"],
        contact_email=row["contact_email"],
        user_id=str(row["user_id"]),
        created_at=row["created_at"].isoformat(),
    )


@router.get("/hotel")
async def get_hotel(user_id: str = Depends(require_hotel_admin)):
    """Get the current user's hotel details including last-minute discount config."""
    row = await Database.fetchrow(
        "SELECT * FROM hotels WHERE user_id = $1", user_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Hotel not found")
    import json as _json
    lm = row.get("last_minute_discount")
    return {
        "id": str(row["id"]),
        "slug": row["slug"],
        "name": row["name"],
        "contact_email": row["contact_email"],
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
        "last_minute_discount": _json.loads(lm) if isinstance(lm, str) else lm,
    }


@router.patch("/hotel")
async def update_hotel(
    data: dict,
    user_id: str = Depends(require_hotel_admin),
):
    """Update hotel details (slug, name, email, last_minute_discount)."""
    import json as _json
    hotel = await Database.fetchrow(
        "SELECT id FROM hotels WHERE user_id = $1", user_id
    )
    if not hotel:
        raise HTTPException(status_code=404, detail="Hotel not found")

    set_clauses = []
    values = []
    idx = 1
    for field in ("slug", "name", "contact_email", "last_minute_discount",
                   "property_type", "timezone", "country", "state", "city",
                   "address", "zip_code", "phone", "latitude", "longitude"):
        if field in data:
            val = data[field]
            if field == "last_minute_discount":
                set_clauses.append(f"{field} = ${idx}::jsonb")
                values.append(_json.dumps(val) if val is not None else None)
            else:
                set_clauses.append(f"{field} = ${idx}")
                values.append(val)
            idx += 1

    if not set_clauses:
        raise HTTPException(status_code=400, detail="No fields to update")

    values.append(str(hotel["id"]))
    row = await Database.fetchrow(
        f"UPDATE hotels SET {', '.join(set_clauses)} WHERE id = ${idx} RETURNING *",
        *values,
    )
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
        "last_minute_discount": _json.loads(lm) if isinstance(lm, str) else lm,
    }


@router.get("/setup-status", response_model=SetupStatusResponse)
async def get_setup_status(
    user_id: str = Depends(require_hotel_admin),
):
    hotel = await Database.fetchrow(
        "SELECT id FROM hotels WHERE user_id = $1", user_id
    )

    # Auto-register: if no PMS hotel exists yet, create one from the auth profile
    if not hotel:
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
                hotel = await Database.fetchrow(
                    """INSERT INTO hotels (slug, name, contact_email, user_id)
                       VALUES ($1, $2, $3, $4)
                       RETURNING id""",
                    slug,
                    user["name"],
                    user["email"],
                    user_id,
                )
        except Exception as e:
            logger.error(f"Auto-register hotel failed for user {user_id}: {e}")

    if not hotel:
        return SetupStatusResponse(registered=False, setup_complete=False, room_count=0)

    hotel_id = str(hotel["id"])
    room_count = await Database.fetchval(
        "SELECT COUNT(*) FROM room_types WHERE hotel_id = $1", hotel_id
    )
    return SetupStatusResponse(
        registered=True,
        setup_complete=room_count > 0,
        room_count=room_count,
    )


# ── Book Direct Benefits ──────────────────────────────────────────


@router.get("/benefits", response_model=HotelBenefitsResponse)
async def get_benefits(user_id: str = Depends(require_hotel_admin)):
    hotel_id = await get_hotel_id(user_id)
    row = await Database.fetchrow(
        "SELECT benefits FROM hotels WHERE id = $1", hotel_id
    )
    return HotelBenefitsResponse(benefits=parse_jsonb(row["benefits"]) if row else [])


@router.put("/benefits", response_model=HotelBenefitsResponse)
async def update_benefits(
    data: HotelBenefitsUpdate,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    await Database.execute(
        "UPDATE hotels SET benefits = $1::jsonb WHERE id = $2",
        json.dumps(data.benefits),
        hotel_id,
    )
    return HotelBenefitsResponse(benefits=data.benefits)


# ── Guest Form Settings ──────────────────────────────────────────


@router.get("/guest-form-settings", response_model=GuestFormSettingsResponse)
async def get_guest_form_settings(user_id: str = Depends(require_hotel_admin)):
    hotel_id = await get_hotel_id(user_id)
    row = await Database.fetchrow(
        "SELECT special_requests_enabled, arrival_time_enabled, guest_count_enabled "
        "FROM hotels WHERE id = $1",
        hotel_id,
    )
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
    if updates:
        set_clauses = ", ".join(f"{k} = ${i+1}" for i, k in enumerate(updates))
        values = list(updates.values())
        values.append(hotel_id)
        await Database.execute(
            f"UPDATE hotels SET {set_clauses} WHERE id = ${len(values)}",
            *values,
        )
    row = await Database.fetchrow(
        "SELECT special_requests_enabled, arrival_time_enabled, guest_count_enabled "
        "FROM hotels WHERE id = $1",
        hotel_id,
    )
    return GuestFormSettingsResponse(
        special_requests_enabled=row["special_requests_enabled"],
        arrival_time_enabled=row["arrival_time_enabled"],
        guest_count_enabled=row["guest_count_enabled"],
    )
