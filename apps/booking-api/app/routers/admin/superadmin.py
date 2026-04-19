import logging

from fastapi import APIRouter, HTTPException, Depends, status
from pydantic import BaseModel, EmailStr, Field
from typing import Optional

from app.dependencies import require_superadmin
from app.auth import hash_password
from app.repositories.user_repo import UserRepository
from app.repositories.booking_hotel_repo import BookingHotelRepository
from app.database import Database
from app.models.utils import slugify
from app.routers.admin.settings import _count_active_rooms, compute_fixed_plan_projected_fee

logger = logging.getLogger(__name__)

router = APIRouter()


class SuperadminCreateHotelRequest(BaseModel):
    user_id: str
    name: Optional[str] = ""


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
    "fixed_base_fee, fixed_rooms_included, fixed_per_extra_room_fee"
)

# Plan is hotel-owned (toggled via hotel-authed endpoints); Vayada admin sets the rates.
_SUPERADMIN_BILLING_FIELDS = {
    "booking_engine_fee_pct",
    "channel_manager_fee_pct",
    "affiliate_platform_fee_pct",
    "fixed_base_fee",
    "fixed_rooms_included",
    "fixed_per_extra_room_fee",
}
_PERCENT_FIELDS = {
    "booking_engine_fee_pct",
    "channel_manager_fee_pct",
    "affiliate_platform_fee_pct",
}


async def _serialize_hotel_billing(hotel: dict, owner: Optional[dict]) -> dict:
    hotel_id = str(hotel["id"])
    room_count = await _count_active_rooms(hotel_id)
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
        "booking_engine_fee_pct": float(hotel.get("booking_engine_fee_pct") or 2),
        "channel_manager_fee_pct": float(hotel.get("channel_manager_fee_pct") or 3),
        "affiliate_platform_fee_pct": float(hotel.get("affiliate_platform_fee_pct") or 2),
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
    """
    updates = {k: v for k, v in data.items() if k in _SUPERADMIN_BILLING_FIELDS and v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No valid fields to update")

    for field in _PERCENT_FIELDS & updates.keys():
        value = float(updates[field])
        if value < 0 or value > 100:
            raise HTTPException(status_code=400, detail=f"{field} must be between 0 and 100")
    if "fixed_rooms_included" in updates and int(updates["fixed_rooms_included"]) < 0:
        raise HTTPException(status_code=400, detail="fixed_rooms_included must be >= 0")
    for money_field in ("fixed_base_fee", "fixed_per_extra_room_fee"):
        if money_field in updates and float(updates[money_field]) < 0:
            raise HTTPException(status_code=400, detail=f"{money_field} must be >= 0")

    set_clauses = []
    params = [hotel_id]
    for i, (col, val) in enumerate(updates.items(), start=2):
        set_clauses.append(f"{col} = ${i}")
        params.append(val)

    sql = f"UPDATE booking_hotels SET {', '.join(set_clauses)} WHERE id = $1 RETURNING id"
    row = await Database.fetchrow(sql, *params)
    if not row:
        raise HTTPException(status_code=404, detail="Hotel not found")
    return {"ok": True}


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
