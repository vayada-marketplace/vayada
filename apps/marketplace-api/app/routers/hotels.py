"""
Hotel profile routes
"""
from fastapi import APIRouter, HTTPException, status, Depends
from pydantic import BaseModel
from typing import List, Dict
from app.database import Database
from app.dependencies import get_current_user_id

router = APIRouter(prefix="/hotels", tags=["hotels"])


# ============================================
# Response Models
# ============================================

class HotelProfileStatusResponse(BaseModel):
    """Hotel profile completion status response"""
    profile_complete: bool
    missing_fields: List[str]
    has_defaults: Dict[str, bool]
    completion_steps: List[str]


# ============================================
# Endpoints
# ============================================

@router.get("/me/profile-status", response_model=HotelProfileStatusResponse, status_code=status.HTTP_200_OK)
async def get_hotel_profile_status(
    user_id: str = Depends(get_current_user_id)
):
    """
    Get hotel profile completion status
    
    Returns information about what fields are missing, which fields still have
    default values, and what steps are needed to complete the profile.
    """
    try:
        # Verify user is a hotel
        user = await Database.fetchrow(
            "SELECT id, type FROM users WHERE id = $1",
            user_id
        )
        
        if not user or user['type'] != 'hotel':
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="This endpoint is only available for hotels"
            )
        
        # Get hotel profile
        hotel = await Database.fetchrow(
            """
            SELECT 
              id, name, category, location, about, website, phone, profile_complete
            FROM hotel_profiles
            WHERE user_id = $1
            """,
            user_id
        )
        
        if not hotel:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Hotel profile not found"
            )
        
        # Use the database field (automatically maintained by trigger)
        # Note: Requires migration 006_add_hotel_profile_complete.sql to be run
        profile_complete = hotel.get('profile_complete', False)
        
        # Check missing fields and defaults to provide helpful feedback
        missing_fields = []
        has_defaults = {}
        completion_steps = []
        
        # Check location (default is 'Not specified')
        if not hotel['location'] or hotel['location'].strip() == '' or hotel['location'] == 'Not specified':
            missing_fields.append("location")
            has_defaults["location"] = True
            completion_steps.append("Update your location (currently 'Not specified')")
        else:
            has_defaults["location"] = False
        
        # Check category (default is 'Hotel')
        if hotel['category'] == 'Hotel':
            has_defaults["category"] = True
            completion_steps.append("Update your category if needed")
        else:
            has_defaults["category"] = False
        
        # Check about (optional but recommended)
        if not hotel['about'] or hotel['about'].strip() == '':
            missing_fields.append("about")
            completion_steps.append("Add a description about your hotel")
        
        return HotelProfileStatusResponse(
            profile_complete=profile_complete,
            missing_fields=missing_fields,
            has_defaults=has_defaults,
            completion_steps=completion_steps
        )
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get profile status: {str(e)}"
        )

