"""
Creator profile routes
"""
from fastapi import APIRouter, HTTPException, status, Depends
from pydantic import BaseModel, Field, HttpUrl, field_validator, model_validator
from typing import List, Optional, Literal
from datetime import datetime
from decimal import Decimal
import json
from app.database import Database
from app.dependencies import get_current_user_id, get_current_creator_id

router = APIRouter(prefix="/creators", tags=["creators"])


class CreatorProfileStatusResponse(BaseModel):
    """Creator profile status response model"""
    profile_complete: bool
    missing_fields: List[str]
    missing_platforms: bool
    completion_steps: List[str]


# Request/Response models for profile update
class TopCountry(BaseModel):
    """Top country analytics data"""
    country: str
    percentage: float = Field(..., ge=0, le=100)


class TopAgeGroup(BaseModel):
    """Top age group analytics data"""
    ageRange: str
    percentage: float = Field(..., ge=0, le=100)


class GenderSplit(BaseModel):
    """Gender split analytics data"""
    male: float = Field(..., ge=0, le=100)
    female: float = Field(..., ge=0, le=100)


class PlatformRequest(BaseModel):
    """Platform request model"""
    name: Literal["Instagram", "TikTok", "YouTube", "Facebook"]
    handle: str = Field(..., min_length=1)
    followers: int = Field(..., gt=0)
    engagementRate: float = Field(..., gt=0, alias="engagement_rate")
    topCountries: Optional[List[TopCountry]] = Field(None, alias="top_countries")
    topAgeGroups: Optional[List[TopAgeGroup]] = Field(None, alias="top_age_groups")
    genderSplit: Optional[GenderSplit] = Field(None, alias="gender_split")
    
    class Config:
        populate_by_name = True


class UpdateCreatorProfileRequest(BaseModel):
    """Request model for updating creator profile"""
    name: str = Field(..., min_length=1)
    location: str = Field(..., min_length=1)
    shortDescription: str = Field(..., min_length=10, max_length=500, alias="short_description")
    portfolioLink: Optional[HttpUrl] = Field(None, alias="portfolio_link")
    phone: Optional[str] = None
    platforms: List[PlatformRequest] = Field(..., min_length=1)
    audienceSize: Optional[int] = Field(None, alias="audience_size", gt=0)
    
    @model_validator(mode='after')
    def validate_audience_size(self):
        """Calculate audience size if not provided"""
        if self.audienceSize is None:
            self.audienceSize = sum(p.followers for p in self.platforms)
        return self
    
    class Config:
        populate_by_name = True


class PlatformResponse(BaseModel):
    """Platform response model"""
    id: str
    name: str
    handle: str
    followers: int
    engagementRate: float = Field(alias="engagement_rate")
    topCountries: Optional[List[dict]] = Field(None, alias="top_countries")
    topAgeGroups: Optional[List[dict]] = Field(None, alias="top_age_groups")
    genderSplit: Optional[dict] = Field(None, alias="gender_split")
    
    class Config:
        populate_by_name = True
        from_attributes = True


class CreatorProfileResponse(BaseModel):
    """Creator profile response model"""
    id: str
    name: str
    location: str
    shortDescription: str = Field(alias="short_description")
    portfolioLink: Optional[str] = Field(None, alias="portfolio_link")
    phone: Optional[str] = None
    platforms: List[PlatformResponse]
    audienceSize: int = Field(alias="audience_size")
    status: str
    createdAt: datetime = Field(alias="created_at")
    updatedAt: datetime = Field(alias="updated_at")
    
    class Config:
        populate_by_name = True
        from_attributes = True


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


@router.put("/me", response_model=CreatorProfileResponse, status_code=status.HTTP_200_OK)
async def update_creator_profile(
    request: UpdateCreatorProfileRequest,
    user_id: str = Depends(get_current_user_id)
):
    """
    Update the currently authenticated creator's profile.
    
    This endpoint updates basic profile information and replaces all existing platforms
    with the provided platforms array.
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
            "SELECT id FROM creators WHERE user_id = $1",
            user_id
        )
        
        if not creator:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Creator profile not found"
            )
        
        creator_id = creator['id']
        
        # Start transaction - update user name, creator profile, and platforms
        pool = await Database.get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                # Update user name
                await conn.execute(
                    "UPDATE users SET name = $1, updated_at = now() WHERE id = $2",
                    request.name,
                    user_id
                )
                
                # Update creator profile
                await conn.execute(
                    """
                    UPDATE creators 
                    SET location = $1, 
                        short_description = $2, 
                        portfolio_link = $3, 
                        phone = $4,
                        updated_at = now()
                    WHERE id = $5
                    """,
                    request.location,
                    request.shortDescription,
                    str(request.portfolioLink) if request.portfolioLink else None,
                    request.phone,
                    creator_id
                )
                
                # Delete existing platforms (replace strategy)
                await conn.execute(
                    "DELETE FROM creator_platforms WHERE creator_id = $1",
                    creator_id
                )
                
                # Insert new platforms
                for platform in request.platforms:
                    # Prepare analytics data as JSONB (asyncpg handles Python dicts/lists automatically)
                    top_countries_data = [tc.model_dump() for tc in platform.topCountries] if platform.topCountries else None
                    top_age_groups_data = [tag.model_dump() for tag in platform.topAgeGroups] if platform.topAgeGroups else None
                    gender_split_data = platform.genderSplit.model_dump() if platform.genderSplit else None
                    
                    await conn.execute(
                        """
                        INSERT INTO creator_platforms 
                        (creator_id, name, handle, followers, engagement_rate, top_countries, top_age_groups, gender_split)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                        """,
                        creator_id,
                        platform.name,
                        platform.handle,
                        platform.followers,
                        Decimal(str(platform.engagementRate)),
                        top_countries_data,
                        top_age_groups_data,
                        gender_split_data
                    )
        
        # Fetch updated profile with platforms
        creator_data = await Database.fetchrow(
            """
            SELECT c.id, c.location, c.short_description, c.portfolio_link, c.phone, 
                   c.created_at, c.updated_at, u.status
            FROM creators c
            JOIN users u ON u.id = c.user_id
            WHERE c.id = $1
            """,
            creator_id
        )
        
        platforms_data = await Database.fetch(
            """
            SELECT id, name, handle, followers, engagement_rate, 
                   top_countries, top_age_groups, gender_split
            FROM creator_platforms
            WHERE creator_id = $1
            ORDER BY name
            """,
            creator_id
        )
        
        # Calculate audience size
        audience_size = sum(p['followers'] for p in platforms_data)
        
        # Build response
        platforms_response = []
        for p in platforms_data:
            platforms_response.append(PlatformResponse(
                id=str(p['id']),
                name=p['name'],
                handle=p['handle'],
                followers=p['followers'],
                engagement_rate=float(p['engagement_rate']),
                top_countries=p['top_countries'],
                top_age_groups=p['top_age_groups'],
                gender_split=p['gender_split']
            ))
        
        return CreatorProfileResponse(
            id=str(creator_data['id']),
            name=request.name,
            location=creator_data['location'],
            short_description=creator_data['short_description'],
            portfolio_link=creator_data['portfolio_link'],
            phone=creator_data['phone'],
            platforms=platforms_response,
            audience_size=audience_size,
            status=creator_data['status'],
            created_at=creator_data['created_at'],
            updated_at=creator_data['updated_at']
        )
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to update profile: {str(e)}"
        )

