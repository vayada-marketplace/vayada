"""
Creator profile routes
"""
from fastapi import APIRouter, HTTPException, status, Depends
from pydantic import BaseModel
from typing import List
from app.database import Database
from app.dependencies import get_current_user_id

router = APIRouter(prefix="/creators", tags=["creators"])


# ============================================
# Response Models
# ============================================

class ProfileStatusResponse(BaseModel):
    """Profile completion status response"""
    profile_complete: bool
    missing_fields: List[str]
    missing_platforms: bool
    completion_steps: List[str]


# ============================================
# Endpoints
# ============================================

@router.get("/me/profile-status", response_model=ProfileStatusResponse, status_code=status.HTTP_200_OK)
async def get_creator_profile_status(
    user_id: str = Depends(get_current_user_id)
):
    """
    Get creator profile completion status
    
    Returns information about what fields are missing and what steps are needed
    to complete the profile.
    """
    try:
        # Verify user is a creator
        user = await Database.fetchrow(
            "SELECT id, type FROM users WHERE id = $1",
            user_id
        )
        
        if not user or user['type'] != 'creator':
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="This endpoint is only available for creators"
            )
        
        # Get creator profile
        creator = await Database.fetchrow(
            """
            SELECT 
              id, location, short_description, profile_complete
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
        
        # Use the database field (automatically maintained by trigger)
        profile_complete = creator['profile_complete']
        
        # Check missing fields to provide helpful feedback
        missing_fields = []
        completion_steps = []
        
        if not creator['location'] or creator['location'].strip() == '':
            missing_fields.append("location")
            completion_steps.append("Add your location")
        
        if not creator['short_description'] or creator['short_description'].strip() == '':
            missing_fields.append("short_description")
            completion_steps.append("Add a short description")
        
        # Check if at least one platform exists
        platform_count = await Database.fetchval(
            """
            SELECT COUNT(*) FROM creator_platforms
            WHERE creator_id = $1
            """,
            str(creator['id'])
        )
        
        missing_platforms = platform_count == 0
        if missing_platforms:
            completion_steps.append("Add at least one social media platform")
        
        return ProfileStatusResponse(
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

