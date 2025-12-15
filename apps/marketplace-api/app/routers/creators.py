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
from app.dependencies import get_current_user_id

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
    """Request model for updating creator profile (partial updates supported)"""
    name: Optional[str] = Field(None, min_length=1)
    location: Optional[str] = Field(None, min_length=1)
    shortDescription: Optional[str] = Field(None, min_length=10, max_length=500, alias="short_description")
    portfolioLink: Optional[HttpUrl] = Field(None, alias="portfolio_link")
    phone: Optional[str] = None
    platforms: Optional[List[PlatformRequest]] = Field(None, min_length=1)
    audienceSize: Optional[int] = Field(None, alias="audience_size", gt=0)
    
    @model_validator(mode='after')
    def validate_audience_size(self):
        """Calculate audience size if platforms are provided and audienceSize is not"""
        if self.platforms is not None and self.audienceSize is None:
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


class ReviewResponse(BaseModel):
    """Review response model"""
    id: str
    hotelId: Optional[str] = Field(None, alias="hotel_id")
    hotelName: Optional[str] = Field(None, alias="hotel_name")
    rating: int
    comment: Optional[str] = None
    createdAt: datetime = Field(alias="created_at")
    
    class Config:
        populate_by_name = True
        from_attributes = True


class RatingResponse(BaseModel):
    """Rating summary response model"""
    averageRating: float = Field(alias="average_rating")
    totalReviews: int = Field(alias="total_reviews")
    reviews: List[ReviewResponse] = Field(default_factory=list)
    
    class Config:
        populate_by_name = True
        from_attributes = True


class CreatorProfileFullResponse(BaseModel):
    """Full creator profile response model for GET /creators/me"""
    id: str
    name: str
    email: str
    phone: Optional[str] = None
    location: str
    portfolioLink: Optional[str] = Field(None, alias="portfolio_link")
    shortDescription: Optional[str] = Field(None, alias="short_description")
    profilePicture: Optional[str] = Field(None, alias="profile_picture")
    platforms: List[PlatformResponse]
    rating: RatingResponse
    status: str
    createdAt: datetime = Field(alias="created_at")
    updatedAt: datetime = Field(alias="updated_at")
    
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


@router.get("/me", response_model=CreatorProfileFullResponse)
async def get_creator_profile(user_id: str = Depends(get_current_user_id)):
    """
    Get the complete profile data for the currently authenticated creator user.
    """
    try:
        # Verify user is a creator
        user = await Database.fetchrow(
            "SELECT id, type, name, email, status FROM users WHERE id = $1",
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
            SELECT id, location, short_description, portfolio_link, phone, 
                   created_at, updated_at
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
        
        creator_id = creator['id']
        
        # Get platforms
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
        
        platforms_response = [
            PlatformResponse(
                id=str(p['id']),
                name=p['name'],
                handle=p['handle'],
                followers=p['followers'],
                engagement_rate=float(p['engagement_rate']),
                topCountries=p['top_countries'],
                topAgeGroups=p['top_age_groups'],
                genderSplit=p['gender_split']
            ) for p in platforms_data
        ]
        
        # Get ratings and reviews
        ratings_data = await Database.fetch(
            """
            SELECT cr.id, cr.hotel_id, cr.rating, cr.comment, cr.created_at,
                   hp.name as hotel_name
            FROM creator_ratings cr
            LEFT JOIN hotel_profiles hp ON cr.hotel_id = hp.id
            WHERE cr.creator_id = $1
            ORDER BY cr.created_at DESC
            """,
            creator_id
        )
        
        total_reviews = len(ratings_data)
        average_rating = (
            sum(r['rating'] for r in ratings_data) / total_reviews
            if total_reviews > 0 else 0.0
        )
        
        reviews_response = [
            ReviewResponse(
                id=str(r['id']),
                hotelId=str(r['hotel_id']) if r['hotel_id'] else None,
                hotelName=r['hotel_name'],
                rating=r['rating'],
                comment=r['comment'],
                created_at=r['created_at']
            ) for r in ratings_data
        ]
        
        rating_response = RatingResponse(
            average_rating=round(average_rating, 2),
            total_reviews=total_reviews,
            reviews=reviews_response
        )
        
        return CreatorProfileFullResponse(
            id=str(creator_id),
            name=user['name'],
            email=user['email'],
            phone=creator['phone'],
            location=creator['location'] or "",
            portfolio_link=creator['portfolio_link'],
            short_description=creator['short_description'],
            profile_picture=None,  # Not stored in current schema
            platforms=platforms_response,
            rating=rating_response,
            status=user['status'],
            created_at=creator['created_at'],
            updated_at=creator['updated_at']
        )
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get profile: {str(e)}"
        )


@router.put("/me", response_model=CreatorProfileResponse, status_code=status.HTTP_200_OK)
async def update_creator_profile(
    request: UpdateCreatorProfileRequest,
    user_id: str = Depends(get_current_user_id)
):
    """
    Update the currently authenticated creator's profile.
    Supports partial updates - only provided fields will be updated.
    
    If platforms are provided, all existing platforms will be replaced with the new ones.
    If platforms are not provided, existing platforms remain unchanged.
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
                # Update user name if provided
                if request.name is not None:
                    await conn.execute(
                        "UPDATE users SET name = $1, updated_at = now() WHERE id = $2",
                        request.name,
                        user_id
                    )
                
                # Build dynamic UPDATE query for creator profile
                update_fields = []
                update_values = []
                param_counter = 1
                
                if request.location is not None:
                    update_fields.append(f"location = ${param_counter}")
                    update_values.append(request.location)
                    param_counter += 1
                
                if request.shortDescription is not None:
                    update_fields.append(f"short_description = ${param_counter}")
                    update_values.append(request.shortDescription)
                    param_counter += 1
                
                if request.portfolioLink is not None:
                    update_fields.append(f"portfolio_link = ${param_counter}")
                    update_values.append(str(request.portfolioLink))
                    param_counter += 1
                
                if request.phone is not None:
                    update_fields.append(f"phone = ${param_counter}")
                    update_values.append(request.phone)
                    param_counter += 1
                
                # Update creator profile if there are fields to update
                if update_fields:
                    update_fields.append("updated_at = now()")
                    update_values.append(creator_id)  # WHERE clause parameter
                    
                    update_query = f"""
                        UPDATE creators 
                        SET {', '.join(update_fields)}
                        WHERE id = ${param_counter}
                    """
                    await conn.execute(update_query, *update_values)
                
                # Update platforms only if provided (replace strategy)
                if request.platforms is not None:
                    # Delete existing platforms
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
                   c.created_at, c.updated_at, u.status, u.name as user_name
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
            name=request.name if request.name is not None else creator_data['user_name'],
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

