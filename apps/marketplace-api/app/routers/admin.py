"""
Admin routes for user management
"""
from fastapi import APIRouter, HTTPException, status, Depends, Query
from pydantic import BaseModel, Field, ConfigDict
from typing import List, Optional, Union
from datetime import datetime
from decimal import Decimal
import logging
import json

from app.database import Database
from app.dependencies import get_current_user_id

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["admin"])


# Admin dependency - checks if user is admin
async def get_admin_user(user_id: str = Depends(get_current_user_id)) -> str:
    """
    Verify that the current user is an admin.
    """
    user = await Database.fetchrow(
        "SELECT id, type, status FROM users WHERE id = $1",
        user_id
    )
    
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found"
        )
    
    if user['type'] != 'admin':
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin access required"
        )
    
    if user['status'] == 'suspended':
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin account is suspended"
        )
    
    return user_id


# Response models
class UserResponse(BaseModel):
    """User response model"""
    id: str
    email: str
    name: str
    type: str
    status: str
    email_verified: bool
    avatar: Optional[str] = None
    created_at: datetime
    updated_at: datetime


class UserListResponse(BaseModel):
    """User list response"""
    users: List[UserResponse]
    total: int


# Detail response models
class PlatformResponse(BaseModel):
    """Platform response model for creator platforms"""
    id: str
    name: str
    handle: str
    followers: int
    engagementRate: float = Field(alias="engagement_rate")
    topCountries: Optional[List[dict]] = Field(None, alias="top_countries")
    topAgeGroups: Optional[List[dict]] = Field(None, alias="top_age_groups")
    genderSplit: Optional[dict] = Field(None, alias="gender_split")
    createdAt: datetime = Field(alias="created_at")
    updatedAt: datetime = Field(alias="updated_at")
    
    model_config = ConfigDict(populate_by_name=True)


class CreatorProfileDetail(BaseModel):
    """Creator profile detail"""
    id: str
    userId: str = Field(alias="user_id")
    location: Optional[str] = None
    shortDescription: Optional[str] = Field(None, alias="short_description")
    portfolioLink: Optional[str] = Field(None, alias="portfolio_link")
    phone: Optional[str] = None
    profilePicture: Optional[str] = Field(None, alias="profile_picture")
    profileComplete: bool = Field(alias="profile_complete")
    profileCompletedAt: Optional[datetime] = Field(None, alias="profile_completed_at")
    createdAt: datetime = Field(alias="created_at")
    updatedAt: datetime = Field(alias="updated_at")
    platforms: List[PlatformResponse] = Field(default_factory=list)
    
    model_config = ConfigDict(populate_by_name=True)


class CollaborationOfferingResponse(BaseModel):
    """Collaboration offering response model"""
    id: str
    listingId: str = Field(alias="listing_id")
    collaborationType: str = Field(alias="collaboration_type")
    availabilityMonths: List[str] = Field(alias="availability_months")
    platforms: List[str]
    freeStayMinNights: Optional[int] = Field(None, alias="free_stay_min_nights")
    freeStayMaxNights: Optional[int] = Field(None, alias="free_stay_max_nights")
    paidMaxAmount: Optional[Decimal] = Field(None, alias="paid_max_amount")
    discountPercentage: Optional[int] = Field(None, alias="discount_percentage")
    createdAt: datetime = Field(alias="created_at")
    updatedAt: datetime = Field(alias="updated_at")
    
    model_config = ConfigDict(populate_by_name=True, from_attributes=True)


class CreatorRequirementsResponse(BaseModel):
    """Creator requirements response model"""
    id: str
    listingId: str = Field(alias="listing_id")
    platforms: List[str]
    minFollowers: Optional[int] = Field(None, alias="min_followers")
    targetCountries: List[str] = Field(alias="target_countries")
    targetAgeMin: Optional[int] = Field(None, alias="target_age_min")
    targetAgeMax: Optional[int] = Field(None, alias="target_age_max")
    createdAt: datetime = Field(alias="created_at")
    updatedAt: datetime = Field(alias="updated_at")
    
    model_config = ConfigDict(populate_by_name=True, from_attributes=True)


class ListingResponse(BaseModel):
    """Listing response model for hotel listings"""
    id: str
    hotelProfileId: str = Field(alias="hotel_profile_id")
    name: str
    location: str
    description: str
    accommodationType: Optional[str] = Field(None, alias="accommodation_type")
    images: List[str]
    status: str
    createdAt: datetime = Field(alias="created_at")
    updatedAt: datetime = Field(alias="updated_at")
    collaborationOfferings: List[CollaborationOfferingResponse] = Field(alias="collaboration_offerings", default_factory=list)
    creatorRequirements: Optional[CreatorRequirementsResponse] = Field(None, alias="creator_requirements")
    
    model_config = ConfigDict(populate_by_name=True, from_attributes=True)


class HotelProfileDetail(BaseModel):
    """Hotel profile detail"""
    id: str
    userId: str = Field(alias="user_id")
    name: str
    location: str
    picture: Optional[str] = None
    website: Optional[str] = None
    about: Optional[str] = None
    email: str
    phone: Optional[str] = None
    status: str
    createdAt: datetime = Field(alias="created_at")
    updatedAt: datetime = Field(alias="updated_at")
    listings: List[ListingResponse] = Field(default_factory=list)
    
    model_config = ConfigDict(populate_by_name=True)


class UserDetailResponse(BaseModel):
    """Complete user detail response with profile, platforms, and listings"""
    # User info
    id: str
    email: str
    name: str
    type: str
    status: str
    emailVerified: bool = Field(alias="email_verified")
    avatar: Optional[str] = None
    createdAt: datetime = Field(alias="created_at")
    updatedAt: datetime = Field(alias="updated_at")
    
    # Profile (creator or hotel)
    profile: Optional[Union[CreatorProfileDetail, HotelProfileDetail]] = None
    
    model_config = ConfigDict(populate_by_name=True)


@router.get("/users", response_model=UserListResponse, status_code=status.HTTP_200_OK)
async def get_all_users(
    page: int = Query(1, ge=1, description="Page number (starts at 1)"),
    page_size: int = Query(10, ge=1, le=100, description="Number of items per page (max 100)"),
    type: Optional[str] = Query(None, description="Filter by user type (creator, hotel, admin)"),
    status_filter: Optional[str] = Query(None, alias="status", description="Filter by user status (pending, verified, rejected, suspended)"),
    search: Optional[str] = Query(None, description="Search by name or email (case-insensitive)"),
    admin_id: str = Depends(get_admin_user)
):
    """
    Get all users with optional filtering and pagination.
    
    - **page**: Page number (starts at 1)
    - **page_size**: Number of items per page (max 100)
    - **type**: Filter by user type (creator, hotel, admin)
    - **status**: Filter by user status (pending, verified, rejected, suspended)
    - **search**: Search by name or email (case-insensitive)
    """
    try:
        # Build WHERE clause
        where_conditions = []
        params = []
        param_count = 0
        
        if type:
            param_count += 1
            where_conditions.append(f"type = ${param_count}")
            params.append(type)
        
        if status_filter:
            param_count += 1
            where_conditions.append(f"status = ${param_count}")
            params.append(status_filter)
        
        if search:
            param_count += 1
            where_conditions.append(f"(LOWER(name) LIKE ${param_count} OR LOWER(email) LIKE ${param_count + 1})")
            search_pattern = f"%{search.lower()}%"
            params.append(search_pattern)
            params.append(search_pattern)
            param_count += 1  # Increment for the second search parameter
        
        where_clause = f"WHERE {' AND '.join(where_conditions)}" if where_conditions else ""
        
        # Get total count
        count_query = f"SELECT COUNT(*) FROM users {where_clause}"
        if params:
            total = await Database.fetchval(count_query, *params)
        else:
            total = await Database.fetchval(count_query)
        
        # Calculate offset
        offset = (page - 1) * page_size
        
        # Build pagination parameters
        limit_param = param_count + 1
        offset_param = param_count + 2
        
        # Get users with pagination
        query = f"""
            SELECT id, email, name, type, status, email_verified, avatar, created_at, updated_at
            FROM users
            {where_clause}
            ORDER BY created_at DESC
            LIMIT ${limit_param} OFFSET ${offset_param}
        """
        pagination_params = list(params) + [page_size, offset]
        
        users_data = await Database.fetch(query, *pagination_params)
        
        users = [
            UserResponse(
                id=str(u['id']),
                email=u['email'],
                name=u['name'],
                type=u['type'],
                status=u['status'],
                email_verified=u['email_verified'],
                avatar=u['avatar'],
                created_at=u['created_at'],
                updated_at=u['updated_at']
            )
            for u in users_data
        ]
        
        logger.info(f"Admin {admin_id} fetched {len(users)} users (page {page}, total: {total})")
        
        return UserListResponse(
            users=users,
            total=total
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching users: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to fetch users: {str(e)}"
        )


@router.get("/users/{user_id}", response_model=UserDetailResponse, status_code=status.HTTP_200_OK)
async def get_user_details(
    user_id: str,
    admin_id: str = Depends(get_admin_user)
):
    """
    Get complete details for a specific user including:
    - User information
    - Profile (creator_profile or hotel_profile)
    - Social media platforms (for creators)
    - Listings (for hotels)
    """
    try:
        # Get user info
        user = await Database.fetchrow(
            """
            SELECT id, email, name, type, status, email_verified, avatar, created_at, updated_at
            FROM users
            WHERE id = $1
            """,
            user_id
        )
        
        if not user:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="User not found"
            )
        
        profile = None
        
        # Get profile based on user type
        if user['type'] == 'creator':
            # Get creator profile
            creator_profile = await Database.fetchrow(
                """
                SELECT id, user_id, location, short_description, portfolio_link, phone,
                       profile_picture, profile_complete, profile_completed_at,
                       created_at, updated_at
                FROM creators
                WHERE user_id = $1
                """,
                user_id
            )
            
            if creator_profile:
                # Get platforms
                platforms_data = await Database.fetch(
                    """
                    SELECT id, name, handle, followers, engagement_rate,
                           top_countries, top_age_groups, gender_split,
                           created_at, updated_at
                    FROM creator_platforms
                    WHERE creator_id = $1
                    ORDER BY created_at DESC
                    """,
                    creator_profile['id']
                )
                
                platforms = []
                for p in platforms_data:
                    # Parse JSONB fields (asyncpg may return them as strings)
                    def parse_jsonb(value):
                        if value is None:
                            return None
                        if isinstance(value, str):
                            return json.loads(value)
                        return value
                    
                    # Convert top_countries from dict to list format if needed
                    def convert_top_countries(value):
                        parsed = parse_jsonb(value)
                        if parsed is None:
                            return None
                        if isinstance(parsed, dict):
                            # Convert dict {"USA": 40, "UK": 25} to [{"country": "USA", "percentage": 40}, ...]
                            return [{"country": k, "percentage": v} for k, v in parsed.items()]
                        return parsed
                    
                    # Convert top_age_groups from dict to list format if needed
                    def convert_top_age_groups(value):
                        parsed = parse_jsonb(value)
                        if parsed is None:
                            return None
                        if isinstance(parsed, dict):
                            # Convert dict {"25-34": 45, "35-44": 30} to [{"ageRange": "25-34", "percentage": 45}, ...]
                            return [{"ageRange": k, "percentage": v} for k, v in parsed.items()]
                        return parsed
                    
                    platforms.append(PlatformResponse(
                        id=str(p['id']),
     ‘                   name=p['name'],
                        handle=p['handle'],
                        followers=p['followers'],
                        engagement_rate=float(p['engagement_rate']),
                        top_countries=convert_top_countries(p['top_countries']),
                        top_age_groups=convert_top_age_groups(p['top_age_groups']),
                        gender_split=parse_jsonb(p['gender_split']),
                        created_at=p['created_at'],
                        updated_at=p['updated_at']
                    ))
                
                profile = CreatorProfileDetail(
                    id=str(creator_profile['id']),
                    user_id=str(creator_profile['user_id']),
                    location=creator_profile['location'],
                    short_description=creator_profile['short_description'],
                    portfolio_link=creator_profile['portfolio_link'],
                    phone=creator_profile['phone'],
                    profile_picture=creator_profile['profile_picture'],
                    profile_complete=creator_profile['profile_complete'],
                    profile_completed_at=creator_profile['profile_completed_at'],
                    created_at=creator_profile['created_at'],
                    updated_at=creator_profile['updated_at'],
                    platforms=platforms
                )
        
        elif user['type'] == 'hotel':
            # Get hotel profile (email comes from users table, not hotel_profiles)
            hotel_profile = await Database.fetchrow(
                """
                SELECT id, user_id, name, location, picture, website, about,
                       phone, status, created_at, updated_at
                FROM hotel_profiles
                WHERE user_id = $1
                """,
                user_id
            )
            
            if hotel_profile:
                # Get listings
                listings_data = await Database.fetch(
                    """
                    SELECT id, hotel_profile_id, name, location, description,
                           accommodation_type, images, status, created_at, updated_at
                    FROM hotel_listings
                    WHERE hotel_profile_id = $1
                    ORDER BY created_at DESC
                    """,
                    hotel_profile['id']
                )
                
                listings = []
                for l in listings_data:
                    listing_id = str(l['id'])
                    
                    # Get collaboration offerings for this listing
                    offerings_data = await Database.fetch(
                        """
                        SELECT id, listing_id, collaboration_type, availability_months, platforms,
                               free_stay_min_nights, free_stay_max_nights, paid_max_amount, discount_percentage,
                               created_at, updated_at
                        FROM listing_collaboration_offerings
                        WHERE listing_id = $1
                        ORDER BY created_at DESC
                        """,
                        l['id']
                    )
                    
                    offerings = [
                        CollaborationOfferingResponse(
                            id=str(o['id']),
                            listing_id=str(o['listing_id']),
                            collaboration_type=o['collaboration_type'],
                            availability_months=o['availability_months'],
                            platforms=o['platforms'],
                            free_stay_min_nights=o['free_stay_min_nights'],
                            free_stay_max_nights=o['free_stay_max_nights'],
                            paid_max_amount=o['paid_max_amount'],
                            discount_percentage=o['discount_percentage'],
                            created_at=o['created_at'],
                            updated_at=o['updated_at']
                        )
                        for o in offerings_data
                    ]
                    
                    # Get creator requirements for this listing
                    requirements_data = await Database.fetchrow(
                        """
                        SELECT id, listing_id, platforms, min_followers, target_countries,
                               target_age_min, target_age_max, created_at, updated_at
                        FROM listing_creator_requirements
                        WHERE listing_id = $1
                        """,
                        l['id']
                    )
                    
                    requirements = None
                    if requirements_data:
                        requirements = CreatorRequirementsResponse(
                            id=str(requirements_data['id']),
                            listing_id=str(requirements_data['listing_id']),
                            platforms=requirements_data['platforms'],
                            min_followers=requirements_data['min_followers'],
                            target_countries=requirements_data['target_countries'],
                            target_age_min=requirements_data['target_age_min'],
                            target_age_max=requirements_data['target_age_max'],
                            created_at=requirements_data['created_at'],
                            updated_at=requirements_data['updated_at']
                        )
                    
                    listings.append(ListingResponse(
                        id=listing_id,
                        hotel_profile_id=str(l['hotel_profile_id']),
                        name=l['name'],
                        location=l['location'],
                        description=l['description'],
                        accommodation_type=l['accommodation_type'],
                        images=l['images'] or [],
                        status=l['status'],
                        created_at=l['created_at'],
                        updated_at=l['updated_at'],
                        collaboration_offerings=offerings,
                        creator_requirements=requirements
                    ))
                
                profile = HotelProfileDetail(
                    id=str(hotel_profile['id']),
                    user_id=str(hotel_profile['user_id']),
                    name=hotel_profile['name'],
                    location=hotel_profile['location'],
                    picture=hotel_profile['picture'],
                    website=hotel_profile['website'],
                    about=hotel_profile['about'],
                    email=user['email'],  # Email comes from users table
                    phone=hotel_profile['phone'],
                    status=hotel_profile['status'],
                    created_at=hotel_profile['created_at'],
                    updated_at=hotel_profile['updated_at'],
                    listings=listings
                )
        
        logger.info(f"Admin {admin_id} fetched details for user {user_id} (type: {user['type']})")
        
        return UserDetailResponse(
            id=str(user['id']),
            email=user['email'],
            name=user['name'],
            type=user['type'],
            status=user['status'],
            email_verified=user['email_verified'],
            avatar=user['avatar'],
            created_at=user['created_at'],
            updated_at=user['updated_at'],
            profile=profile
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching user details: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to fetch user details: {str(e)}"
        )
