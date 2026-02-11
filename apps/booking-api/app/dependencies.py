"""
Dependencies for FastAPI routes
"""
from fastapi import HTTPException, status, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from app.jwt_utils import decode_access_token, is_token_expired
from app.repositories.user_repo import UserRepository

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

    if user['status'] != 'verified':
        status_messages = {
            'pending': "Your account is pending verification. Please wait for approval.",
            'rejected': "Your account has been rejected. Please contact support.",
            'suspended': "Your account has been suspended. Please contact support.",
        }
        detail = status_messages.get(user['status'], "Your account is not active. Please contact support.")
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=detail,
        )

    return user_id


async def require_hotel_admin(user_id: str = Depends(get_current_user_id)) -> str:
    user = await UserRepository.get_by_id(user_id, columns="id, type")

    if user['type'] != 'hotel':
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This endpoint is only available for hotel administrators"
        )

    return user_id
