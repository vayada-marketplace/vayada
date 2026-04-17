"""
JWT auth dependencies — validates tokens issued by the booking engine.
"""
import jwt
from fastapi import HTTPException, status, Depends, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from app.config import settings
from app.database import AuthDatabase, Database
from app.utils import set_current_hotel_id_override


async def capture_hotel_header(request: Request) -> None:
    """
    Capture the X-Hotel-Id header into a per-request contextvar so
    that get_hotel_id() (called by ~50 routers) can use it without
    every endpoint needing to accept a Request or hotel dependency.

    This dependency is attached globally to the admin router in
    main.py. It runs once per request, stores the header (or None)
    in the contextvar, and returns nothing.

    The header's ownership is validated later by get_hotel_id when
    it looks up the row — not here — so a request with an invalid
    header still gets past this dep and fails with a cleaner 403
    at the actual query site.
    """
    set_current_hotel_id_override(request.headers.get("X-Hotel-Id"))

security = HTTPBearer()


async def get_current_user_id(
    credentials: HTTPAuthorizationCredentials = Depends(security),
) -> str:
    token = credentials.credentials
    try:
        payload = jwt.decode(
            token,
            settings.JWT_SECRET_KEY,
            algorithms=[settings.JWT_ALGORITHM],
        )
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token has expired",
        )
    except jwt.InvalidTokenError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token",
        )

    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token payload",
        )

    user = await AuthDatabase.fetchrow(
        "SELECT id, type, status FROM users WHERE id = $1", user_id
    )
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found",
        )
    if user["status"] in ("rejected", "suspended"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account not active",
        )

    return user_id


async def require_hotel_admin(
    user_id: str = Depends(get_current_user_id),
) -> str:
    user = await AuthDatabase.fetchrow(
        "SELECT type FROM users WHERE id = $1", user_id
    )
    if user["type"] not in ("hotel", "admin"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Hotel admin access required",
        )
    return user_id


async def require_affiliate(
    user_id: str = Depends(get_current_user_id),
) -> str:
    user = await AuthDatabase.fetchrow(
        "SELECT type FROM users WHERE id = $1", user_id
    )
    if user["type"] != "affiliate":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Affiliate access required",
        )
    return user_id


async def require_super_admin(
    user_id: str = Depends(get_current_user_id),
) -> str:
    """vayada-staff-only endpoints. Gated by users.is_superadmin."""
    user = await AuthDatabase.fetchrow(
        "SELECT is_superadmin FROM users WHERE id = $1", user_id
    )
    if not user or not user["is_superadmin"]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="vayada staff access required",
        )
    return user_id


async def get_current_hotel(
    request: Request,
    user_id: str = Depends(require_hotel_admin),
) -> dict | None:
    """
    Resolve the hotel the current request is operating on.

    Priority:
      1. `X-Hotel-Id` request header — the multi-hotel-safe mode. The
         header value must identify a hotel owned by the authenticated
         user, otherwise 403.
      2. Legacy fallback: the user's oldest hotel (ordered by
         created_at). Preserved so that clients that haven't been
         updated to send the header still work in single-hotel mode.
         A future commit will remove this fallback entirely once all
         clients are updated.

    Returns the hotel row as a dict, or None if the user has no
    hotels at all (new users mid-onboarding). Routers that require
    a hotel should depend on `require_current_hotel` instead.
    """
    header_id = request.headers.get("X-Hotel-Id")
    if header_id:
        hotel = await Database.fetchrow(
            "SELECT * FROM hotels WHERE id = $1 AND user_id = $2",
            header_id, user_id,
        )
        if not hotel:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Hotel not found or not owned by this user",
            )
        return dict(hotel)

    row = await Database.fetchrow(
        "SELECT * FROM hotels WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1",
        user_id,
    )
    return dict(row) if row else None


async def require_current_hotel(
    hotel: dict | None = Depends(get_current_hotel),
) -> dict:
    """Same as get_current_hotel but raises 404 when the user has no hotel."""
    if not hotel:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No hotel found for this user. Create one via POST /admin/register-hotel first.",
        )
    return hotel
