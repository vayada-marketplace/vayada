"""
Dependencies for FastAPI routes
"""
from typing import Optional
from fastapi import HTTPException, status, Depends, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from app.jwt_utils import decode_access_token, is_token_expired
from app.repositories.user_repo import UserRepository
from app.repositories.booking_hotel_repo import BookingHotelRepository

security = HTTPBearer()


async def get_current_user_id(credentials: HTTPAuthorizationCredentials = Depends(security)) -> str:
    token = credentials.credentials

    if is_token_expired(token):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token has expired. Please login again.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    payload = decode_access_token(token)
    if not payload:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token payload",
            headers={"WWW-Authenticate": "Bearer"},
        )

    user = await UserRepository.get_by_id(user_id, columns="id, type, status")

    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found",
            headers={"WWW-Authenticate": "Bearer"},
        )

    if user['status'] in ('rejected', 'suspended'):
        status_messages = {
            'rejected': "Your account has been rejected. Please contact support.",
            'suspended': "Your account has been suspended. Please contact support.",
        }
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=status_messages[user['status']],
        )

    return user_id


async def get_current_user_with_admin_flag(
    credentials: HTTPAuthorizationCredentials = Depends(security),
) -> dict:
    """
    Same as get_current_user_id but returns a dict with user_id and is_superadmin.
    """
    token = credentials.credentials

    if is_token_expired(token):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token has expired. Please login again.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    payload = decode_access_token(token)
    if not payload:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token payload",
            headers={"WWW-Authenticate": "Bearer"},
        )

    user = await UserRepository.get_by_id(user_id, columns="id, type, status, is_superadmin")

    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found",
            headers={"WWW-Authenticate": "Bearer"},
        )

    if user['status'] in ('rejected', 'suspended'):
        status_messages = {
            'rejected': "Your account has been rejected. Please contact support.",
            'suspended': "Your account has been suspended. Please contact support.",
        }
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=status_messages[user['status']],
        )

    return {
        "user_id": str(user['id']),
        "is_superadmin": bool(user.get('is_superadmin', False)),
    }


async def require_hotel_admin(
    user_info: dict = Depends(get_current_user_with_admin_flag),
) -> str:
    """
    Allow hotel admins and super admins through.
    Returns the user_id string for backwards compatibility.
    """
    if user_info["is_superadmin"]:
        return user_info["user_id"]

    user = await UserRepository.get_by_id(user_info["user_id"], columns="id, type")

    if user['type'] != 'hotel':
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This endpoint is only available for hotel administrators"
        )

    return user_info["user_id"]


async def get_current_hotel(
    request: Request,
    user_info: dict = Depends(get_current_user_with_admin_flag),
    user_id: str = Depends(require_hotel_admin),
) -> Optional[dict]:
    """
    Resolve hotel context from X-Hotel-Id header.
    Falls back to first hotel if header is absent (backwards compat).
    Super admins bypass ownership check.
    """
    hotel_id = request.headers.get("x-hotel-id")

    if hotel_id:
        if user_info["is_superadmin"]:
            hotel = await BookingHotelRepository.get_by_id(hotel_id)
        else:
            hotel = await BookingHotelRepository.get_by_id_and_user_id(hotel_id, user_id)
        if not hotel:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Hotel not found or access denied",
            )
        return hotel

    # Fallback: return first hotel for old clients
    hotels = await BookingHotelRepository.list_by_user_id(user_id)
    return hotels[0] if hotels else None


async def require_current_hotel(
    hotel: Optional[dict] = Depends(get_current_hotel),
) -> dict:
    """Wraps get_current_hotel, raises 404 if no hotel resolved."""
    if not hotel:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No hotel found. Please complete property setup first.",
        )
    return hotel


async def require_superadmin(
    user_info: dict = Depends(get_current_user_with_admin_flag),
) -> str:
    """Only allows super admins through. Returns user_id."""
    if not user_info["is_superadmin"]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Super admin access required",
        )
    return user_info["user_id"]
