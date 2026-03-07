import re
import logging

from fastapi import APIRouter, HTTPException, Depends, status
from app.dependencies import require_superadmin
from app.auth import hash_password
from app.repositories.user_repo import UserRepository
from app.repositories.booking_hotel_repo import BookingHotelRepository

logger = logging.getLogger(__name__)

router = APIRouter()


def _slugify(text: str) -> str:
    text = text.lower().strip()
    text = re.sub(r'[^\w\s-]', '', text)
    text = re.sub(r'[\s_]+', '-', text)
    text = re.sub(r'-+', '-', text)
    return text or 'my-hotel'


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
    data: dict,
    user_id: str = Depends(require_superadmin),
):
    target_user_id = data.get("user_id")
    hotel_name = data.get("name", "")
    if not target_user_id:
        raise HTTPException(status_code=400, detail="user_id is required")

    existing = await BookingHotelRepository.get_by_user_id(target_user_id, columns="id")
    if existing:
        return {"id": str(existing["id"]), "message": "Hotel already exists for this user"}

    if not hotel_name:
        owner = await UserRepository.get_by_id(target_user_id, columns="id, name")
        hotel_name = owner["name"] if owner else f"Hotel {target_user_id[:8]}"

    slug = _slugify(hotel_name)
    existing_slug = await BookingHotelRepository.get_by_slug(slug)
    if existing_slug:
        slug = f"{slug}-{target_user_id[:8]}"

    result = await BookingHotelRepository.create(
        name=hotel_name,
        slug=slug,
        contact_email="",
        contact_phone="",
        timezone="UTC",
        currency="EUR",
        supported_languages=["en"],
        user_id=target_user_id,
    )

    created = await BookingHotelRepository.get_by_user_id(target_user_id, columns="id, name, slug")
    return {
        "id": str(created["id"]),
        "name": created["name"],
        "slug": created["slug"],
    }


@router.post("/superadmin/set-password")
async def superadmin_set_password(
    data: dict,
    user_id: str = Depends(require_superadmin),
):
    email = data.get("email")
    new_password = data.get("password")
    if not email or not new_password:
        raise HTTPException(status_code=400, detail="email and password are required")

    user = await UserRepository.get_by_email(email, columns="id")
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    await UserRepository.update_password(str(user["id"]), hash_password(new_password))
    return {"message": f"Password updated for {email}"}
