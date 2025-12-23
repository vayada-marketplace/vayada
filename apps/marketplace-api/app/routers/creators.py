"""
Creator profile routes
"""
from fastapi import APIRouter, HTTPException, status, Depends
from pydantic import BaseModel, Field, HttpUrl, field_validator, model_validator, ConfigDict
from typing import List, Optional, Literal
from datetime import datetime
from decimal import Decimal
import json
import logging
from app.database import Database
from app.dependencies import get_current_user_id
from app.email_service import send_email, create_profile_completion_email_html
from app.auth import create_email_verification_token
from app.config import settings

logger = logging.getLogger(__name__)

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
    country: Optional[str] = None
    percentage: Optional[float] = Field(
        None, ge=0, le=100, description="Audience share for the country (0-100)"
    )


class TopAgeGroup(BaseModel):
    """Top age group analytics data"""
    ageRange: Optional[str] = None
    percentage: Optional[float] = Field(
        None, ge=0, le=100, description="Audience share for the age group (0-100)"
    )


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
    
    model_config = ConfigDict(populate_by_name=True)


class UpdateCreatorProfileRequest(BaseModel):
    """Request model for updating creator profile (partial updates supported)"""
    name: Optional[str] = Field(None, min_length=1)
    location: Optional[str] = Field(None, min_length=1)
    shortDescription: Optional[str] = Field(None, min_length=10, max_length=500, alias="short_description")
    portfolioLink: Optional[HttpUrl] = Field(None, alias="portfolio_link")
    phone: Optional[str] = None
    profilePicture: Optional[str] = Field(None, alias="profile_picture", description="S3 URL of the profile picture")
    platforms: Optional[List[PlatformRequest]] = Field(None, min_length=1)
    audienceSize: Optional[int] = Field(None, alias="audience_size", gt=0)
    
    @model_validator(mode='after')
    def validate_audience_size(self):
        """Calculate audience size if platforms are provided and audienceSize is not"""
        if self.platforms is not None and self.audienceSize is None:
            self.audienceSize = sum(p.followers for p in self.platforms)
        return self
    
    model_config = ConfigDict(populate_by_name=True)


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
    
    model_config = ConfigDict(populate_by_name=True, from_attributes=True)


class ReviewResponse(BaseModel):
    """Review response model"""
    id: str
    hotelId: Optional[str] = Field(None, alias="hotel_id")
    hotelName: Optional[str] = Field(None, alias="hotel_name")
    rating: int
    comment: Optional[str] = None
    createdAt: datetime = Field(alias="created_at")
    
    model_config = ConfigDict(populate_by_name=True, from_attributes=True)


class RatingResponse(BaseModel):
    """Rating summary response model"""
    averageRating: float = Field(alias="average_rating")
    totalReviews: int = Field(alias="total_reviews")
    reviews: List[ReviewResponse] = Field(default_factory=list)
    
    model_config = ConfigDict(populate_by_name=True, from_attributes=True)


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
    
    model_config = ConfigDict(populate_by_name=True, from_attributes=True)


class CreatorProfileResponse(BaseModel):
    """Creator profile response model"""
    id: str
    name: str
    location: str
    shortDescription: str = Field(alias="short_description")
    portfolioLink: Optional[str] = Field(None, alias="portfolio_link")
    phone: Optional[str] = None
    profilePicture: Optional[str] = Field(None, alias="profile_picture")
    platforms: List[PlatformResponse]
    audienceSize: int = Field(alias="audience_size")
    status: str
    createdAt: datetime = Field(alias="created_at")
    updatedAt: datetime = Field(alias="updated_at")
    
    model_config = ConfigDict(populate_by_name=True, from_attributes=True)


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
                   profile_picture, created_at, updated_at
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
                topCountries=json.loads(p['top_countries']) if p['top_countries'] else None,
                topAgeGroups=json.loads(p['top_age_groups']) if p['top_age_groups'] else None,
                genderSplit=json.loads(p['gender_split']) if p['gender_split'] else None
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
            profile_picture=creator['profile_picture'],
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
    
    For profile picture:
    - Option 1: Upload image first using POST /upload/image/creator-profile, then include the returned URL in profilePicture field
    - Option 2: Provide an existing S3 URL directly in profilePicture field
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
        
        # Get creator profile with completion status
        creator = await Database.fetchrow(
            "SELECT id, profile_complete FROM creators WHERE user_id = $1",
            user_id
        )
        
        if not creator:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Creator profile not found"
            )
        
        creator_id = creator['id']
        was_complete_before = creator.get('profile_complete', False)
        
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
                
                if request.profilePicture is not None:
                    update_fields.append(f"profile_picture = ${param_counter}")
                    update_values.append(request.profilePicture)
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
                        # Prepare analytics data as JSONB (serialize to string for DB)
                        top_countries_data = json.dumps([tc.model_dump() for tc in platform.topCountries]) if platform.topCountries else None
                        top_age_groups_data = json.dumps([tag.model_dump() for tag in platform.topAgeGroups]) if platform.topAgeGroups else None
                        gender_split_data = json.dumps(platform.genderSplit.model_dump()) if platform.genderSplit else None
                        
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
        
        # Fetch updated profile with platforms and check if profile became complete
        creator_data = await Database.fetchrow(
            """
            SELECT c.id, c.location, c.short_description, c.portfolio_link, c.phone, 
                   c.profile_picture, c.created_at, c.updated_at, c.profile_complete, u.status, u.name as user_name, u.email
            FROM creators c
            JOIN users u ON u.id = c.user_id
            WHERE c.id = $1
            """,
            creator_id
        )
        
        # Check if profile just became complete (transition from incomplete to complete)
        is_complete_now = creator_data.get('profile_complete', False)
        profile_just_completed = not was_complete_before and is_complete_now
        
        # Send confirmation email if profile just became complete
        if profile_just_completed:
            try:
                user_email = creator_data['email']
                user_name = creator_data['user_name'] or user_email.split('@')[0]
                
                # Check if email is already verified
                user_record = await Database.fetchrow(
                    "SELECT email_verified FROM users WHERE id = $1",
                    user_id
                )
                email_verified = user_record.get('email_verified', False) if user_record else False
                
                # Generate verification token and link if email is not verified
                verification_link = None
                if not email_verified:
                    try:
                        token = await create_email_verification_token(user_id, expires_in_hours=48)
                        verification_link = f"{settings.FRONTEND_URL}/verify-email?token={token}"
                    except Exception as e:
                        logger.error(f"Error creating email verification token: {str(e)}")
                        # Continue without verification link if token creation fails
                
                html_body = create_profile_completion_email_html(user_name, "creator", verification_link)
                
                email_sent = await send_email(
                    to_email=user_email,
                    subject="🎉 Your Creator Profile is Complete!" + (" - Verify Your Email" if not email_verified else ""),
                    html_body=html_body
                )
                
                if email_sent:
                    logger.info(f"Profile completion email sent to {user_email}" + (" with verification link" if verification_link else ""))
                else:
                    logger.warning(f"Failed to send profile completion email to {user_email}")
            except Exception as e:
                # Don't fail the request if email fails
                logger.error(f"Error sending profile completion email: {str(e)}")
        
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
                top_countries=json.loads(p['top_countries']) if p['top_countries'] else None,
                top_age_groups=json.loads(p['top_age_groups']) if p['top_age_groups'] else None,
                gender_split=json.loads(p['gender_split']) if p['gender_split'] else None
            ))
        
        return CreatorProfileResponse(
            id=str(creator_data['id']),
            name=request.name if request.name is not None else creator_data['user_name'],
            location=creator_data['location'],
            short_description=creator_data['short_description'],
            portfolio_link=creator_data['portfolio_link'],
            phone=creator_data['phone'],
            profile_picture=creator_data['profile_picture'],
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

