"""
JWT auth dependencies — validates tokens issued by the booking engine.
"""
import jwt
from fastapi import HTTPException, status, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from app.config import settings
from app.database import AuthDatabase

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
