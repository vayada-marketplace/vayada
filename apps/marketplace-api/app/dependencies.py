"""
Dependencies for FastAPI routes
"""
from fastapi import HTTPException, status, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from typing import Optional
from app.database import Database
from app.jwt_utils import decode_access_token, get_user_id_from_token, is_token_expired

security = HTTPBearer()


async def get_current_user_id(credentials: HTTPAuthorizationCredentials = Depends(security)) -> str:
    """
    Get current user ID from JWT token in Authorization header.
    
    Expects: Authorization: Bearer <token>
    """
    token = credentials.credentials
    
    # Check if token is expired (for better error message)
    if is_token_expired(token):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token has expired. Please login again.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    # Decode and verify token
    payload = decode_access_token(token)
    if not payload:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    # Get user ID from token
    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token payload",
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    # Verify user exists and check status
    user = await Database.fetchrow(
        "SELECT id, type, status FROM users WHERE id = $1",
        user_id
    )

    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # Check if user account is active (verified)
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


async def get_current_creator_id(user_id: str = Depends(get_current_user_id)) -> str:
    """
    Get current creator ID from user ID.
    Verifies that the user is a creator and has a creator profile.
    """
    # Verify user is a creator
    user = await Database.fetchrow(
        "SELECT id, type FROM users WHERE id = $1",
        user_id
    )
    
    if user['type'] != 'creator':
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This endpoint is only available for creators"
        )
    
    # Get creator profile
    creator = await Database.fetchrow(
        "SELECT id FROM creators WHERE user_id = $1",
        user_id
    )
    
    if not creator:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Creator profile not found. Please complete your profile first."
        )
    
    return str(creator['id'])


async def get_current_hotel_profile_id(user_id: str = Depends(get_current_user_id)) -> str:
    """
    Get current hotel profile ID from user ID.
    Verifies that the user is a hotel and has a hotel profile.
    """
    # Verify user is a hotel
    user = await Database.fetchrow(
        "SELECT id, type FROM users WHERE id = $1",
        user_id
    )
    
    if user['type'] != 'hotel':
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This endpoint is only available for hotels"
        )
    
    # Get hotel profile
    hotel_profile = await Database.fetchrow(
        "SELECT id FROM hotel_profiles WHERE user_id = $1",
        user_id
    )
    
    if not hotel_profile:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Hotel profile not found. Please create your profile first."
        )
    
    return str(hotel_profile['id'])

