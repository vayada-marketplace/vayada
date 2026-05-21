import logging

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, EmailStr, Field

from app.auth import hash_password
from app.database import Database
from app.dependencies import require_superadmin
from app.models.utils import slugify
from app.repositories.booking_hotel_repo import BookingHotelRepository
from app.repositories.user_repo import UserRepository
from app.services.billing_service import (
    compute_fixed_plan_projected_fee,
    count_active_rooms,
)

logger = logging.getLogger(__name__)

router = APIRouter()


class SuperadminCreateHotelRequest(BaseModel):
    user_id: str
    name: str | None = ""


class SuperadminSetPasswordRequest(BaseModel):
    email: EmailStr
    password: str = Field(..., min_length=8)


@router.get("/superadmin/check")
async def superadmin_check(user_id: str = Depends(require_superadmin)):
    return {"is_superadmin": True}


_BILLING_COLUMNS = (
    "id, name, slug, location, country, user_id, "
    "billing_active_plan, billing_pending_switch, billing_switch_effective_date, "
    "booking_engine_fee_pct, channel_manager_fee_pct, affiliate_platform_fee_pct, "
    "fixed_base_fee, fixed_rooms_included, fixed_per_extra_room_fee, "
    "billing_commission_note"
)

# Plan is hotel-owned (toggled via hotel-authed endpoints); Vayada admin sets the rates.
_SUPERADMIN_BILLING_FIELDS = {
    "booking_engine_fee_pct",
    "channel_manager_fee_pct",
    "affiliate_platform_fee_pct",
    "fixed_base_fee",
    "fixed_rooms_included",
    "fixed_per_extra_room_fee",
    "billing_commission_note",
}
# 0-100 range for the OTA / affiliate platform fees; the direct-booking
# Commission rate has its own tighter 0-50 range (see _validate_billing_updates).
_PERCENT_FIELDS = {
    "channel_manager_fee_pct",
    "affiliate_platform_fee_pct",
}


async def _serialize_hotel_billing(hotel: dict, owner: dict | None) -> dict:
    hotel_id = str(hotel["id"])
    room_count = await count_active_rooms(hotel_id)
    fixed_base = float(hotel.get("fixed_base_fee") or 30)
    rooms_included = int(hotel.get("fixed_rooms_included") or 1)
    per_extra = float(hotel.get("fixed_per_extra_room_fee") or 5)
    projected_fee = compute_fixed_plan_projected_fee(
        fixed_base, rooms_included, per_extra, room_count
    )
    return {
        "id": hotel_id,
        "name": hotel["name"],
        "slug": hotel["slug"],
        "location": hotel.get("location") or "",
        "country": hotel.get("country") or "",
        "owner_name": owner["name"] if owner else "",
        "owner_email": owner["email"] if owner else "",
        "billing_active_plan": hotel.get("billing_active_plan") or "commission",
        "billing_pending_switch": hotel.get("billing_pending_switch"),
        "billing_switch_effective_date": (
            hotel["billing_switch_effective_date"].isoformat()
            if hotel.get("billing_switch_effective_date")
            else None
        ),
        "booking_engine_fee_pct": float(hotel.get("booking_engine_fee_pct") or 5),
        "channel_manager_fee_pct": float(hotel.get("channel_manager_fee_pct") or 3),
        "affiliate_platform_fee_pct": float(hotel.get("affiliate_platform_fee_pct") or 2),
        "billing_commission_note": hotel.get("billing_commission_note"),
        "fixed_base_fee": fixed_base,
        "fixed_rooms_included": rooms_included,
        "fixed_per_extra_room_fee": per_extra,
        "active_room_count": room_count,
        "fixed_plan_projected_monthly_fee": projected_fee,
    }


@router.get("/superadmin/hotels")
async def superadmin_list_hotels(user_id: str = Depends(require_superadmin)):
    hotels = await BookingHotelRepository.list_all(columns=_BILLING_COLUMNS)
    result = []
    for hotel in hotels:
        owner = await UserRepository.get_by_id(str(hotel["user_id"]), columns="id, name, email")
        result.append(await _serialize_hotel_billing(hotel, owner))
    return result


@router.patch("/superadmin/hotels/{hotel_id}/billing")
async def superadmin_update_billing(
    hotel_id: str,
    data: dict,
    user_id: str = Depends(require_superadmin),
):
    """Update platform-fee and fixed-plan config for a specific hotel (super admin only).

    The active plan itself is hotel-owned and not settable here.
    Commission-rate edits (booking_engine_fee_pct) are recorded in
    commission_rate_changes for audit; the request may include
    `commission_note` to attach a free-text reason that's also persisted on the hotel.
    """
    updates = {k: v for k, v in data.items() if k in _SUPERADMIN_BILLING_FIELDS and v is not None}
    # commission_note is the request-level alias for billing_commission_note;
    # accept either so the admin UI can pass it inline with a rate change.
    if "commission_note" in data and data["commission_note"] is not None:
        updates["billing_commission_note"] = data["commission_note"]
    if not updates:
        raise HTTPException(status_code=400, detail="No valid fields to update")

    if "booking_engine_fee_pct" in updates:
        value = float(updates["booking_engine_fee_pct"])
        if value < 0 or value > 50:
            raise HTTPException(
                status_code=400,
                detail="booking_engine_fee_pct must be between 0 and 50",
            )
    for field in _PERCENT_FIELDS & updates.keys():
        value = float(updates[field])
        if value < 0 or value > 100:
            raise HTTPException(status_code=400, detail=f"{field} must be between 0 and 100")
    if "fixed_rooms_included" in updates and int(updates["fixed_rooms_included"]) < 0:
        raise HTTPException(status_code=400, detail="fixed_rooms_included must be >= 0")
    for money_field in ("fixed_base_fee", "fixed_per_extra_room_fee"):
        if money_field in updates and float(updates[money_field]) < 0:
            raise HTTPException(status_code=400, detail=f"{money_field} must be >= 0")

    # Read the current commission rate so the audit row has the true old value.
    old_rate = None
    if "booking_engine_fee_pct" in updates:
        existing = await Database.fetchrow(
            "SELECT booking_engine_fee_pct FROM booking_hotels WHERE id = $1",
            hotel_id,
        )
        if not existing:
            raise HTTPException(status_code=404, detail="Hotel not found")
        old_rate = float(existing["booking_engine_fee_pct"])

    set_clauses = []
    params = [hotel_id]
    for i, (col, val) in enumerate(updates.items(), start=2):
        set_clauses.append(f"{col} = ${i}")
        params.append(val)

    sql = f"UPDATE booking_hotels SET {', '.join(set_clauses)} WHERE id = $1 RETURNING id"
    row = await Database.fetchrow(sql, *params)
    if not row:
        raise HTTPException(status_code=404, detail="Hotel not found")

    # Audit: only record actual rate changes (skip no-op saves).
    if "booking_engine_fee_pct" in updates:
        new_rate = float(updates["booking_engine_fee_pct"])
        if old_rate is None or abs(new_rate - old_rate) > 1e-9:
            await Database.execute(
                """
                INSERT INTO commission_rate_changes
                    (hotel_id, admin_user_id, old_value, new_value, note)
                VALUES ($1, $2, $3, $4, $5)
                """,
                hotel_id,
                user_id,
                old_rate if old_rate is not None else new_rate,
                new_rate,
                updates.get("billing_commission_note"),
            )
    return {"ok": True}


@router.get("/superadmin/hotels/{hotel_id}/commission-history")
async def superadmin_commission_history(
    hotel_id: str,
    user_id: str = Depends(require_superadmin),
):
    """Return the commission-rate change log for a hotel, newest first.

    Each entry includes the admin who made the change (looked up from auth)
    so the Admin Dashboard can show "<name> changed 5% → 4% on <date>".
    """
    rows = await Database.fetch(
        """
        SELECT id, admin_user_id, old_value, new_value, note, changed_at
        FROM commission_rate_changes
        WHERE hotel_id = $1
        ORDER BY changed_at DESC
        """,
        hotel_id,
    )
    history = []
    for row in rows:
        admin = await UserRepository.get_by_id(str(row["admin_user_id"]), columns="id, name, email")
        history.append(
            {
                "id": str(row["id"]),
                "admin_user_id": str(row["admin_user_id"]),
                "admin_name": admin["name"] if admin else "",
                "admin_email": admin["email"] if admin else "",
                "old_value": float(row["old_value"]),
                "new_value": float(row["new_value"]),
                "note": row["note"],
                "changed_at": row["changed_at"].isoformat(),
            }
        )
    return history


@router.post("/superadmin/hotels", status_code=status.HTTP_201_CREATED)
async def superadmin_create_hotel(
    data: SuperadminCreateHotelRequest,
    user_id: str = Depends(require_superadmin),
):
    existing = await BookingHotelRepository.get_by_user_id(data.user_id, columns="id")
    if existing:
        return {"id": str(existing["id"]), "message": "Hotel already exists for this user"}

    hotel_name = data.name
    if not hotel_name:
        owner = await UserRepository.get_by_id(data.user_id, columns="id, name")
        hotel_name = owner["name"] if owner else f"Hotel {data.user_id[:8]}"

    slug = slugify(hotel_name)
    existing_slug = await BookingHotelRepository.get_by_slug(slug)
    if existing_slug:
        slug = f"{slug}-{data.user_id[:8]}"

    await BookingHotelRepository.create(
        name=hotel_name,
        slug=slug,
        contact_email="",
        contact_phone="",
        timezone="UTC",
        currency="EUR",
        supported_languages=["en"],
        user_id=data.user_id,
    )

    created = await BookingHotelRepository.get_by_user_id(data.user_id, columns="id, name, slug")
    return {
        "id": str(created["id"]),
        "name": created["name"],
        "slug": created["slug"],
    }


@router.delete("/superadmin/hotels/{hotel_id}", status_code=status.HTTP_204_NO_CONTENT)
async def superadmin_delete_hotel(
    hotel_id: str,
    user_id: str = Depends(require_superadmin),
):
    existing = await BookingHotelRepository.get_by_id(hotel_id, columns="id")
    if not existing:
        raise HTTPException(status_code=404, detail="Hotel not found")
    deleted = await BookingHotelRepository.delete(hotel_id)
    if not deleted:
        raise HTTPException(status_code=500, detail="Failed to delete hotel")
    logger.info("Superadmin %s deleted booking hotel %s", user_id, hotel_id)
    return None


@router.post("/superadmin/set-password")
async def superadmin_set_password(
    data: SuperadminSetPasswordRequest,
    user_id: str = Depends(require_superadmin),
):
    user = await UserRepository.get_by_email(data.email, columns="id")
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    await UserRepository.update_password(str(user["id"]), hash_password(data.password))
    return {"message": f"Password updated for {data.email}"}
