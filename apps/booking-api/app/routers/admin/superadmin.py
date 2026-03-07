import logging

from fastapi import APIRouter, HTTPException, Depends, status
from pydantic import BaseModel, EmailStr, Field
from typing import Optional

from app.dependencies import require_superadmin
from app.auth import hash_password
from app.repositories.user_repo import UserRepository
from app.repositories.booking_hotel_repo import BookingHotelRepository
from app.models.utils import slugify

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


@router.get("/superadmin/hotels")
async def superadmin_list_hotels(user_id: str = Depends(require_superadmin)):
    hotels = await BookingHotelRepository.list_all(
        columns="id, name, slug, location, country, user_id"
    )

    result = []
    for hotel in hotels:
        owner = await UserRepository.get_by_id(str(hotel["user_id"]), columns="id, name, email")
        result.append({
            "id": str(hotel["id"]),
            "name": hotel["name"],
            "slug": hotel["slug"],
            "location": hotel.get("location") or "",
            "country": hotel.get("country") or "",
            "owner_name": owner["name"] if owner else "",
            "owner_email": owner["email"] if owner else "",
        })

    return result


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
