"""
Dependencies for FastAPI routes
"""

from fastapi import Depends, Header, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.auth import AUTH_COOKIE_NAME
from app.config import settings
from app.jwt_utils import decode_access_token, is_token_expired
from app.repositories.booking_hotel_repo import BookingHotelRepository
from app.repositories.user_repo import UserRepository


async def require_internal_key(
    x_internal_key: str | None = Header(default=None),
) -> None:
    """Gate server-to-server endpoints behind ``INTERNAL_API_KEY``. When the
    setting is empty, the gate is open for backward-compat — operators can
    roll out enforcement by setting the key on both backends without a
    flag day."""
    expected = settings.INTERNAL_API_KEY
    if not expected:
        return
    if not x_internal_key or x_internal_key != expected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing internal API key",
        )


# auto_error=False so we can fall back to the cookie when the
# Authorization header is absent.
security = HTTPBearer(auto_error=False)


def _extract_token(credentials: HTTPAuthorizationCredentials | None, request: Request) -> str:
    """Pull the access token from the Authorization header if present,
    else from the AUTH_COOKIE_NAME cookie. Raises 401 when neither is
    available."""
    if credentials is not None:
        return credentials.credentials
    cookie_token = request.cookies.get(AUTH_COOKIE_NAME)
    if cookie_token:
        return cookie_token
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Not authenticated",
        headers={"WWW-Authenticate": "Bearer"},
    )


async def _authenticate(
    credentials: HTTPAuthorizationCredentials | None,
    request: Request,
    columns: str = "id, type, status",
) -> dict:
    """Shared auth logic: validate token, fetch user, check status."""
    token = _extract_token(credentials, request)

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

    user = await UserRepository.get_by_id(user_id, columns=columns)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found",
            headers={"WWW-Authenticate": "Bearer"},
        )

    if user["status"] in ("rejected", "suspended"):
        status_messages = {
            "rejected": "Your account has been rejected. Please contact support.",
            "suspended": "Your account has been suspended. Please contact support.",
        }
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=status_messages[user["status"]],
        )

    return user


async def get_current_user_id(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
) -> str:
    user = await _authenticate(credentials, request)
    return str(user["id"])


async def get_current_user_with_admin_flag(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
) -> dict:
    user = await _authenticate(credentials, request, columns="id, type, status, is_superadmin")
    return {
        "user_id": str(user["id"]),
        "type": user["type"],
        "is_superadmin": bool(user.get("is_superadmin", False)),
    }


async def require_hotel_admin(
    user_info: dict = Depends(get_current_user_with_admin_flag),
) -> str:
    if user_info["is_superadmin"]:
        return user_info["user_id"]
    if user_info["type"] != "hotel":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This endpoint is only available for hotel administrators",
        )
    return user_info["user_id"]


async def get_current_hotel(
    request: Request,
    user_info: dict = Depends(get_current_user_with_admin_flag),
    user_id: str = Depends(require_hotel_admin),
) -> dict | None:
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

    hotels = await BookingHotelRepository.list_by_user_id(user_id)
    if not hotels:
        return None
    # Refetch the full record. list_by_user_id only selects a handful of
    # columns, so returning hotels[0] directly would hand downstream
    # endpoints a hotel dict missing fields like custom_domain — making
    # the header and no-header paths behave inconsistently (VAY-401).
    return await BookingHotelRepository.get_by_id(str(hotels[0]["id"]))


async def require_current_hotel(
    hotel: dict | None = Depends(get_current_hotel),
) -> dict:
    if not hotel:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No hotel found. Please complete property setup first.",
        )
    return hotel


async def require_superadmin(
    user_info: dict = Depends(get_current_user_with_admin_flag),
) -> str:
    if not user_info["is_superadmin"]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Super admin access required",
        )
    return user_info["user_id"]
