from fastapi import APIRouter, Depends, HTTPException, Request

from app.dependencies import get_allowed_booking_hotel_ids, require_hotel_admin
from app.repositories.booking_hotel_repo import BookingHotelRepository
from app.repositories.user_repo import UserRepository

router = APIRouter()


@router.get("/hotels")
async def list_hotels(request: Request, user_id: str = Depends(require_hotel_admin)):
    scoped_hotel_ids = get_allowed_booking_hotel_ids(request)
    if scoped_hotel_ids is None:
        return await BookingHotelRepository.list_by_user_id(user_id)

    hotels = []
    for hotel_id in scoped_hotel_ids:
        hotel = await BookingHotelRepository.get_by_id(
            hotel_id,
            columns="id, name, slug, location, country",
        )
        if hotel:
            hotels.append(hotel)
    return hotels


@router.get("/me")
async def get_admin_profile(user_id: str = Depends(require_hotel_admin)):
    user = await UserRepository.get_by_id(
        user_id, columns="id, email, name, type, status, created_at"
    )
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    return {
        "id": str(user["id"]),
        "email": user["email"],
        "name": user["name"],
        "type": user["type"],
        "status": user["status"],
        "created_at": user["created_at"].isoformat() if user["created_at"] else None,
    }
