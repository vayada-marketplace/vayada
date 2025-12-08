"""
Hotel profile routes
"""
from fastapi import APIRouter, HTTPException, status, Depends
from pydantic import BaseModel
from typing import List
from app.database import Database
from app.dependencies import get_current_user_id

router = APIRouter(prefix="/hotels", tags=["hotels"])


class HotelProfileStatusHasDefaults(BaseModel):
    """Nested model for default value flags"""
    location: bool
    category: bool


class HotelProfileStatusResponse(BaseModel):
    """Hotel profile status response model"""
    profile_complete: bool
    missing_fields: List[str]
    has_defaults: HotelProfileStatusHasDefaults
    missing_listings: bool
    completion_steps: List[str]


@router.get("/me/profile-status", response_model=HotelProfileStatusResponse)
async def get_hotel_profile_status(user_id: str = Depends(get_current_user_id)):
    """
    Get the profile completion status for the currently authenticated hotel user.
    
    Returns:
    - profile_complete: Whether the profile is fully complete
    - missing_fields: Array of missing field names
    - has_defaults: Object indicating if location/category are using default values
    - completion_steps: Human-readable steps to complete the profile
    """
    try:
        # Verify user is a hotel
        user = await Database.fetchrow(
            "SELECT id, type FROM users WHERE id = $1",
            user_id
        )
        
        if not user:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="User not found"
            )
        
        if user['type'] != 'hotel':
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="This endpoint is only available for hotels"
            )
        
        # Get hotel profile
        hotel = await Database.fetchrow(
            """
            SELECT id, name, category, location, email, website, about, picture, phone
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
        
        # Check for listings
        listings = await Database.fetch(
            """
            SELECT id FROM hotel_listings
            WHERE hotel_profile_id = $1
            """,
            hotel['id']
        )
        
        missing_listings = len(listings) == 0
        
        # Determine missing fields and defaults
        missing_fields = []
        completion_steps = []
        has_default_location = False
        has_default_category = False
        
        # Check name
        if not hotel['name'] or not hotel['name'].strip():
            missing_fields.append("name")
            completion_steps.append("Update your hotel name")
        
        # Check location (required field, but check if it's the default)
        if not hotel['location'] or not hotel['location'].strip():
            missing_fields.append("location")
            completion_steps.append("Set your location")
        elif hotel['location'].strip() == 'Not specified':
            has_default_location = True
            # Don't add to missing_fields - defaults are tracked separately
            completion_steps.append("Set a custom location (currently using default)")
        
        # Check category (required field, but check if it's the default)
        if not hotel['category'] or not hotel['category'].strip():
            missing_fields.append("category")
            completion_steps.append("Set your hotel category")
        elif hotel['category'].strip() == 'Hotel':
            # 'Hotel' is the default value set during registration
            has_default_category = True
            # Note: We don't add to missing_fields for category default
            # as it's technically filled, just using a default value
            completion_steps.append("Update your hotel category (currently using default)")
        
        # Check email (required field)
        if not hotel['email'] or not hotel['email'].strip():
            missing_fields.append("email")
            completion_steps.append("Add your contact email")
        
        # Check optional but recommended fields
        if not hotel['about'] or not hotel['about'].strip():
            missing_fields.append("about")
            completion_steps.append("Add a description about your hotel")
        
        if not hotel['website'] or not hotel['website'].strip():
            missing_fields.append("website")
            completion_steps.append("Add your website URL")
        
        # Check for listings
        if missing_listings:
            completion_steps.append("Add at least one property listing")
        
        # Determine if profile is complete
        # Profile is complete when:
        # - All required fields are filled (name, location, category, email)
        # - Location and category are not using default values
        # - Optional fields like about and website are present (based on business logic)
        # - At least one listing exists
        profile_complete = (
            len(missing_fields) == 0 and
            not has_default_location and
            not has_default_category and
            not missing_listings
        )
        
        return HotelProfileStatusResponse(
            profile_complete=profile_complete,
            missing_fields=missing_fields,
            has_defaults=HotelProfileStatusHasDefaults(
                location=has_default_location,
                category=has_default_category
            ),
            missing_listings=missing_listings,
            completion_steps=completion_steps
        )
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get profile status: {str(e)}"
        )

