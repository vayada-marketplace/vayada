from fastapi import APIRouter, HTTPException, status, Depends
from app.dependencies import require_hotel_admin
from app.repositories.user_repo import UserRepository
from app.repositories.booking_hotel_repo import BookingHotelRepository

router = APIRouter()


@router.get("/hotels")
async def list_hotels(user_id: str = Depends(require_hotel_admin)):
    return await BookingHotelRepository.list_by_user_id(user_id)


@router.get("/me")
async def get_admin_profile(user_id: str = Depends(require_hotel_admin)):
    user = await UserRepository.get_by_id(
        user_id, columns="id, email, name, type, status, created_at"
    )
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    return {
        "id": str(user['id']),
        "email": user['email'],
        "name": user['name'],
        "type": user['type'],
        "status": user['status'],
        "created_at": user['created_at'].isoformat() if user['created_at'] else None,
    }
