"""
JWT auth dependencies — validates tokens issued by the booking engine.
"""

import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.config import settings
from app.database import AuthDatabase
from app.utils import set_current_hotel_id_override, set_current_scoped_hotel_ids

# Must match AUTH_COOKIE_NAME in booking-engine-backend/app/auth.py.
# When the frontend logs in via /auth/login on the auth backend, that
# backend sets this cookie; the browser sends it back to us on every
# cross-origin XHR/fetch. We accept either Bearer or this cookie.
AUTH_COOKIE_NAME = "access_token"


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


# auto_error=False so we can fall back to the access_token cookie when
# the Authorization header is absent.
security = HTTPBearer(auto_error=False)


async def get_current_user_id(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
) -> str:
    if credentials is not None:
        token = credentials.credentials
    else:
        token = request.cookies.get(AUTH_COOKIE_NAME)
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )
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
    resources = payload.get("resources")
    scoped_hotel_ids = None
    if isinstance(resources, dict) and isinstance(resources.get("pms:pms_hotel"), list):
        scoped_hotel_ids = [
            str(resource_id)
            for resource_id in resources["pms:pms_hotel"]
            if isinstance(resource_id, str)
        ]
    set_current_scoped_hotel_ids(scoped_hotel_ids)

    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token payload",
        )

    user = await AuthDatabase.fetchrow("SELECT id, type, status FROM users WHERE id = $1", user_id)
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
        "SELECT type, is_superadmin FROM users WHERE id = $1", user_id
    )
    if user["type"] != "hotel" and not user["is_superadmin"]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Hotel admin access required",
        )
    return user_id


async def require_affiliate(
    user_id: str = Depends(get_current_user_id),
) -> str:
    user = await AuthDatabase.fetchrow("SELECT type FROM users WHERE id = $1", user_id)
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
    user = await AuthDatabase.fetchrow("SELECT is_superadmin FROM users WHERE id = $1", user_id)
    if not user or not user["is_superadmin"]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="vayada staff access required",
        )
    return user_id
