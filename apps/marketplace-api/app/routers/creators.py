"""
Creator profile routes
"""
from fastapi import APIRouter, HTTPException, status, Depends
from pydantic import BaseModel
from typing import List
from app.database import Database
from app.dependencies import get_current_user_id

router = APIRouter(prefix="/creators", tags=["creators"])


class CreatorProfileStatusResponse(BaseModel):
    """Creator profile status response model"""
    profile_complete: bool
    missing_fields: List[str]
    missing_platforms: bool
    completion_steps: List[str]


@router.get("/me/profile-status", response_model=CreatorProfileStatusResponse)
async def get_creator_profile_status(user_id: str = Depends(get_current_user_id)):
    """
    Get the profile completion status for the currently authenticated creator user.
    
    Returns:
    - profile_complete: Whether the profile is fully complete
    - missing_fields: Array of missing field names
    - missing_platforms: Whether at least one platform is missing
    - completion_steps: Human-readable steps to complete the profile
    """
    try:
        # Verify user is a creator
        user = await Database.fetchrow(
            "SELECT id, type, name FROM users WHERE id = $1",
            user_id
        )
        
        if not user:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="User not found"
            )
        
        if user['type'] != 'creator':
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="This endpoint is only available for creators"
            )
        
        # Get creator profile
        creator = await Database.fetchrow(
            """
            SELECT id, location, short_description, portfolio_link, phone
            FROM creators
            WHERE user_id = $1
            """,
            user_id
        )
        
        if not creator:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Creator profile not found"
            )
        
        # Check for platforms
        platforms = await Database.fetch(
            """
            SELECT id, name, handle, followers, engagement_rate
            FROM creator_platforms
            WHERE creator_id = $1
            """,
            creator['id']
        )
        
        # Determine missing fields
        missing_fields = []
        completion_steps = []
        
        # Check name (from users table)
        if not user['name'] or not user['name'].strip():
            missing_fields.append("name")
            completion_steps.append("Add your name")
        
        # Check location
        if not creator['location'] or not creator['location'].strip():
            missing_fields.append("location")
            completion_steps.append("Set your location")
        
        # Check short_description
        if not creator['short_description'] or not creator['short_description'].strip():
            missing_fields.append("short_description")
            completion_steps.append("Add a short description about yourself")
        
        # Check for platforms
        # A platform is valid if it has a handle and followers > 0
        valid_platforms = [
            p for p in platforms
            if p['handle'] and p['handle'].strip() and p['followers'] and p['followers'] > 0
        ]
        
        missing_platforms = len(valid_platforms) == 0
        
        if missing_platforms:
            completion_steps.append("Add at least one social media platform")
        
        # Determine if profile is complete
        profile_complete = (
            len(missing_fields) == 0 and
            not missing_platforms
        )
        
        return CreatorProfileStatusResponse(
            profile_complete=profile_complete,
            missing_fields=missing_fields,
            missing_platforms=missing_platforms,
            completion_steps=completion_steps
        )
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get profile status: {str(e)}"
        )

