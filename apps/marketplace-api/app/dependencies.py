"""
Dependencies for FastAPI routes
"""
from fastapi import Header, HTTPException, status, Depends
from typing import Optional
from app.database import Database


async def get_current_user_id(user_id: Optional[str] = Header(None, alias="X-User-Id")) -> str:
    """
    Get current user ID from header.
    
    TODO: Replace with JWT token authentication
    For now, expects X-User-Id header with the user's UUID
    """
    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required. Please provide X-User-Id header."
        )
    
    # Verify user exists
    user = await Database.fetchrow(
        "SELECT id, type FROM users WHERE id = $1",
        user_id
    )
    
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid user ID"
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

