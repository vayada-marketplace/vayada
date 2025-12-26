"""
Admin routes for user management
"""
from fastapi import APIRouter, HTTPException, status, Depends, Query
from pydantic import BaseModel, Field, ConfigDict, EmailStr, model_validator, ValidationError
from typing import List, Optional, Union, Literal
from datetime import datetime
from decimal import Decimal
import logging
import json
import bcrypt

from app.database import Database
from app.dependencies import get_current_user_id
from app.routers.creators import UpdateCreatorProfileRequest, CreatorProfileResponse
from app.routers.hotels import (
    CreateListingRequest,
    CollaborationOfferingRequest,
    CreatorRequirementsRequest,
    ListingResponse
)
from app.s3_service import delete_all_objects_in_prefix

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


# Request models for creating users
class PlatformRequest(BaseModel):
    """Platform request model for creating platforms"""
    name: Literal["Instagram", "TikTok", "YouTube", "Facebook"]
    handle: str
    followers: int
    engagementRate: float = Field(alias="engagement_rate")
    topCountries: Optional[List[dict]] = Field(None, alias="top_countries")
    topAgeGroups: Optional[List[dict]] = Field(None, alias="top_age_groups")
    genderSplit: Optional[dict] = Field(None, alias="gender_split")
    
    model_config = ConfigDict(populate_by_name=True)


class CreateCreatorProfileRequest(BaseModel):
    """Creator profile data for admin user creation"""
    location: Optional[str] = None
    shortDescription: Optional[str] = Field(None, alias="short_description")
    portfolioLink: Optional[str] = Field(None, alias="portfolio_link")
    phone: Optional[str] = None
    profilePicture: Optional[str] = Field(None, alias="profile_picture")
    platforms: Optional[List[PlatformRequest]] = None
    
    model_config = ConfigDict(populate_by_name=True)


class CreateHotelProfileRequest(BaseModel):
    """Hotel profile data for admin user creation"""
    name: Optional[str] = None
    location: Optional[str] = None
    about: Optional[str] = None
    website: Optional[str] = None
    phone: Optional[str] = None
    listings: Optional[List[CreateListingRequest]] = None
    
    model_config = ConfigDict(populate_by_name=True)


class CreateUserRequest(BaseModel):
    """Request model for creating a user"""
    email: EmailStr
    password: str = Field(..., min_length=8)
    name: str
    type: Literal["creator", "hotel"]
    status: Optional[Literal["pending", "verified", "rejected", "suspended"]] = "pending"
    emailVerified: bool = Field(False, alias="email_verified")
    avatar: Optional[str] = None
    creatorProfile: Optional[CreateCreatorProfileRequest] = Field(None, alias="creator_profile")
    hotelProfile: Optional[CreateHotelProfileRequest] = Field(None, alias="hotel_profile")
    
    @model_validator(mode='after')
    def validate_profile_type(self):
        if self.type == "creator" and self.hotelProfile:
            raise ValueError("Cannot provide hotel_profile for creator user")
        if self.type == "hotel" and self.creatorProfile:
            raise ValueError("Cannot provide creator_profile for hotel user")
        return self
    
    model_config = ConfigDict(populate_by_name=True)


# Response models for user details
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
    listing_id: str
    collaboration_type: str
    availability_months: List[str]
    platforms: List[str]
    free_stay_min_nights: Optional[int] = None
    free_stay_max_nights: Optional[int] = None
    paid_max_amount: Optional[Decimal] = None
    discount_percentage: Optional[Decimal] = None
    created_at: datetime
    updated_at: datetime


class CreatorRequirementsResponse(BaseModel):
    """Creator requirements response model"""
    id: str
    listing_id: str
    platforms: List[str]
    min_followers: Optional[int] = None
    target_countries: Optional[List[str]] = None
    target_age_min: Optional[int] = None
    target_age_max: Optional[int] = None
    created_at: datetime
    updated_at: datetime


class ListingResponse(BaseModel):
    """Listing response model"""
    id: str
    hotel_profile_id: str
    name: str
    location: str
    description: Optional[str] = None
    accommodation_type: str
    images: List[str] = Field(default_factory=list)
    status: str
    created_at: datetime
    updated_at: datetime
    collaboration_offerings: List[CollaborationOfferingResponse] = Field(default_factory=list)
    creator_requirements: Optional[CreatorRequirementsResponse] = None


class HotelProfileDetail(BaseModel):
    """Hotel profile detail"""
    id: str
    user_id: str
    name: str
    location: str
    picture: Optional[str] = None
    website: Optional[str] = None
    about: Optional[str] = None
    email: str
    phone: Optional[str] = None
    status: str
    created_at: datetime
    updated_at: datetime
    listings: List[ListingResponse] = Field(default_factory=list)


class UserDetailResponse(BaseModel):
    """User detail response"""
    id: str
    email: str
    name: str
    type: str
    status: str
    email_verified: bool
    avatar: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    profile: Optional[Union[CreatorProfileDetail, HotelProfileDetail]] = None


@router.get("/users", response_model=UserListResponse, status_code=status.HTTP_200_OK)
async def get_users(
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int = Query(20, ge=1, le=100, description="Items per page"),
    type: Optional[Literal["creator", "hotel", "admin"]] = Query(None, description="Filter by user type"),
    status: Optional[Literal["pending", "verified", "rejected", "suspended"]] = Query(None, description="Filter by status"),
    search: Optional[str] = Query(None, description="Search by name or email"),
    admin_id: str = Depends(get_admin_user)
):
    """
    Get all users with pagination and filtering.
    
    - **page**: Page number (starts at 1)
    - **page_size**: Number of items per page (1-100)
    - **type**: Filter by user type (creator, hotel, admin)
    - **status**: Filter by status (pending, verified, rejected, suspended)
    - **search**: Search by name or email
    """
    try:
        # Build WHERE clause
        where_conditions = []
        params = []
        param_counter = 1
        
        if type:
            where_conditions.append(f"type = ${param_counter}")
            params.append(type)
            param_counter += 1
        
        if status:
            where_conditions.append(f"status = ${param_counter}")
            params.append(status)
            param_counter += 1
        
        if search:
            where_conditions.append(f"(name ILIKE ${param_counter} OR email ILIKE ${param_counter})")
            search_pattern = f"%{search}%"
            params.append(search_pattern)
            param_counter += 1
            params.append(search_pattern)
            param_counter += 1
        
        where_clause = " AND ".join(where_conditions) if where_conditions else "1=1"
        
        # Get total count
        count_query = f"SELECT COUNT(*) as total FROM users WHERE {where_clause}"
        total_result = await Database.fetchrow(count_query, *params)
        total = total_result['total'] if total_result else 0
        
        # Get users with pagination
        offset = (page - 1) * page_size
        users_query = f"""
            SELECT id, email, name, type, status, email_verified, avatar, created_at, updated_at
            FROM users
            WHERE {where_clause}
            ORDER BY created_at DESC
            LIMIT ${param_counter} OFFSET ${param_counter + 1}
        """
        params.extend([page_size, offset])
        
        users_data = await Database.fetch(users_query, *params)
        
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
        
        logger.info(f"Admin {admin_id} fetched users list (page {page}, total: {total})")
        
        return UserListResponse(users=users, total=total)
        
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
                        name=p['name'],
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
                    userId=str(creator_profile['user_id']),
                    location=creator_profile['location'],
                    shortDescription=creator_profile['short_description'],
                    portfolioLink=creator_profile['portfolio_link'],
                    phone=creator_profile['phone'],
                    profilePicture=creator_profile['profile_picture'],
                    profileComplete=creator_profile['profile_complete'],
                    profileCompletedAt=creator_profile['profile_completed_at'],
                    createdAt=creator_profile['created_at'],
                    updatedAt=creator_profile['updated_at'],
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


@router.post("/users", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
async def create_user(
    request: CreateUserRequest,
    admin_id: str = Depends(get_admin_user)
):
    """
    Create a new user (creator or hotel) as admin.
    
    - **email**: User's email address (must be unique)
    - **password**: Password (minimum 8 characters)
    - **name**: User's name
    - **type**: User type - either "creator" or "hotel"
    - **status**: User status (default: "pending")
    - **emailVerified**: Whether email is verified (default: false)
    - **avatar**: Optional avatar URL
    - **creatorProfile**: Optional creator profile data (only for creator type)
    - **hotelProfile**: Optional hotel profile data (only for hotel type)
    """
    try:
        # Check if email already exists
        existing_user = await Database.fetchrow(
            "SELECT id FROM users WHERE email = $1",
            request.email
        )
        
        if existing_user:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Email already registered"
            )
        
        # Hash password
        password_hash = bcrypt.hashpw(
            request.password.encode('utf-8'),
            bcrypt.gensalt()
        ).decode('utf-8')
        
        # Insert user into database
        user = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status, email_verified, avatar)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id, email, name, type, status, email_verified, avatar, created_at, updated_at
            """,
            request.email,
            password_hash,
            request.name,
            request.type,
            request.status,
            request.emailVerified,
            request.avatar
        )
        
        user_id = user['id']
        
        # Create profile based on user type
        if request.type == "creator":
            # Create creator profile
            profile_data = request.creatorProfile or CreateCreatorProfileRequest()
            
            creator = await Database.fetchrow(
                """
                INSERT INTO creators (user_id, location, short_description, portfolio_link, phone, profile_picture)
                VALUES ($1, $2, $3, $4, $5, $6)
                RETURNING id
                """,
                user_id,
                profile_data.location,
                profile_data.shortDescription,
                profile_data.portfolioLink,
                profile_data.phone,
                profile_data.profilePicture
            )
            
            creator_id = creator['id']
            
            # Create platforms if provided
            if profile_data.platforms:
                for platform in profile_data.platforms:
                    # Prepare analytics data as JSONB
                    top_countries_data = None
                    if platform.topCountries:
                        top_countries_data = json.dumps(platform.topCountries)
                    
                    top_age_groups_data = None
                    if platform.topAgeGroups:
                        top_age_groups_data = json.dumps(platform.topAgeGroups)
                    
                    gender_split_data = None
                    if platform.genderSplit:
                        gender_split_data = json.dumps(platform.genderSplit)
                    
                    await Database.execute(
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
        
        elif request.type == "hotel":
            # Create hotel profile
            profile_data = request.hotelProfile or CreateHotelProfileRequest()
            
            hotel_profile = await Database.fetchrow(
                """
                INSERT INTO hotel_profiles (user_id, name, location, about, website, phone)
                VALUES ($1, $2, $3, $4, $5, $6)
                RETURNING id
                """,
                user_id,
                profile_data.name or request.name,
                profile_data.location or "Not specified",
                profile_data.about,
                profile_data.website,
                profile_data.phone
            )
            
            hotel_profile_id = hotel_profile['id']
            
            # Create listings if provided
            if profile_data.listings:
                pool = await Database.get_pool()
                async with pool.acquire() as conn:
                    async with conn.transaction():
                        for listing_request in profile_data.listings:
                            # Create listing
                            listing = await conn.fetchrow(
                                """
                                INSERT INTO hotel_listings 
                                (hotel_profile_id, name, location, description, accommodation_type, images)
                                VALUES ($1, $2, $3, $4, $5, $6)
                                RETURNING id
                                """,
                                hotel_profile_id,
                                listing_request.name,
                                listing_request.location,
                                listing_request.description,
                                listing_request.accommodationType,
                                listing_request.images
                            )
                            
                            listing_id = listing['id']
                            
                            # Create collaboration offerings
                            for offering in listing_request.collaborationOfferings:
                                await conn.execute(
                                    """
                                    INSERT INTO listing_collaboration_offerings
                                    (listing_id, collaboration_type, availability_months, platforms,
                                     free_stay_min_nights, free_stay_max_nights, paid_max_amount, discount_percentage)
                                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                                    """,
                                    listing_id,
                                    offering.collaborationType,
                                    offering.availabilityMonths,
                                    offering.platforms,
                                    offering.freeStayMinNights,
                                    offering.freeStayMaxNights,
                                    offering.paidMaxAmount,
                                    offering.discountPercentage
                                )
                            
                            # Create creator requirements
                            await conn.execute(
                                """
                                INSERT INTO listing_creator_requirements
                                (listing_id, platforms, min_followers, target_countries, target_age_min, target_age_max)
                                VALUES ($1, $2, $3, $4, $5, $6)
                                """,
                                listing_id,
                                listing_request.creatorRequirements.platforms,
                                listing_request.creatorRequirements.minFollowers,
                                listing_request.creatorRequirements.targetCountries,
                                listing_request.creatorRequirements.targetAgeMin,
                                listing_request.creatorRequirements.targetAgeMax
                            )
        
        logger.info(f"Admin {admin_id} created user {user_id} (type: {request.type})")
        
        return UserResponse(
            id=str(user['id']),
            email=user['email'],
            name=user['name'],
            type=user['type'],
            status=user['status'],
            email_verified=user['email_verified'],
            avatar=user['avatar'],
            created_at=user['created_at'],
            updated_at=user['updated_at']
        )
        
    except HTTPException:
        raise
    except ValidationError as e:
        logger.error(f"Validation error creating user: {e.errors()}")
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=e.errors()
        )
    except ValueError as e:
        logger.error(f"Value error creating user: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        logger.error(f"Error creating user: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to create user: {str(e)}"
        )


@router.put("/users/{user_id}/profile/creator", response_model=CreatorProfileResponse, status_code=status.HTTP_200_OK)
async def update_creator_profile(
    user_id: str,
    request: UpdateCreatorProfileRequest,
    admin_id: str = Depends(get_admin_user)
):
    """
    Update a creator's profile (admin endpoint).
    Supports partial updates - only provided fields will be updated.
    
    If platforms are provided, all existing platforms will be replaced with the new ones.
    If platforms are not provided, existing platforms remain unchanged.
    
    For profile picture:
    - Option 1: Upload image first using POST /upload/image/creator-profile?target_user_id={user_id}, then include the returned URL in profilePicture field
    - Option 2: Provide an existing S3 URL directly in profilePicture field
    """
    try:
        # Verify user exists and is a creator
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
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="User is not a creator"
            )
        
        # Get creator profile
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
                        # Prepare analytics data as JSONB
                        top_countries_data = None
                        if platform.topCountries:
                            # Convert list of dicts to JSON string
                            top_countries_data = json.dumps([tc if isinstance(tc, dict) else tc.model_dump() for tc in platform.topCountries])
                        
                        top_age_groups_data = None
                        if platform.topAgeGroups:
                            top_age_groups_data = json.dumps([tag if isinstance(tag, dict) else tag.model_dump() for tag in platform.topAgeGroups])
                        
                        gender_split_data = None
                        if platform.genderSplit:
                            gender_split_data = json.dumps(platform.genderSplit if isinstance(platform.genderSplit, dict) else platform.genderSplit.model_dump())
                        
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
                   c.profile_picture, c.created_at, c.updated_at, c.profile_complete, u.status, u.name as user_name
            FROM creators c
            JOIN users u ON u.id = c.user_id
            WHERE c.id = $1
            """,
            creator_id
        )
        
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
            creator_id
        )
        
        platforms = []
        for p in platforms_data:
            # Parse JSONB fields
            def parse_jsonb(value):
                if value is None:
                    return None
                if isinstance(value, str):
                    return json.loads(value)
                return value
            
            platforms.append(PlatformResponse(
                id=str(p['id']),
                name=p['name'],
                handle=p['handle'],
                followers=p['followers'],
                engagement_rate=float(p['engagement_rate']),
                top_countries=parse_jsonb(p['top_countries']),
                top_age_groups=parse_jsonb(p['top_age_groups']),
                gender_split=parse_jsonb(p['gender_split']),
                created_at=p['created_at'],
                updated_at=p['updated_at']
            ))
        
        # Calculate audience size
        audience_size = sum(p['followers'] for p in platforms_data) if platforms_data else 0
        
        logger.info(f"Admin {admin_id} updated creator profile for user {user_id}")
        
        return CreatorProfileResponse(
            id=str(creator_data['id']),
            name=request.name if request.name is not None else creator_data['user_name'],
            location=creator_data['location'] or "",
            shortDescription=creator_data['short_description'] or "",
            portfolioLink=creator_data['portfolio_link'],
            phone=creator_data['phone'],
            profilePicture=creator_data['profile_picture'],
            platforms=platforms,
            audienceSize=audience_size,
            status=creator_data['status'],
            createdAt=creator_data['created_at'],
            updatedAt=creator_data['updated_at']
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating creator profile: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to update creator profile: {str(e)}"
        )


async def delete_user_images(user_id: str, user_type: str) -> dict:
    """
    Delete all images associated with a user from S3 by deleting the entire user folder.
    
    Args:
        user_id: The user's ID
        user_type: The user's type ('creator' or 'hotel')
    
    Returns:
        Dictionary with deletion statistics:
        {
            "deleted_count": int,
            "failed_count": int,
            "total_objects": int
        }
    """
    # Determine the folder prefix based on user type
    if user_type == 'creator':
        prefix = f"creators/{user_id}/"
    elif user_type == 'hotel':
        prefix = f"listings/{user_id}/"
    else:
        logger.warning(f"Unknown user type {user_type}, skipping image deletion")
        return {
            "deleted_count": 0,
            "failed_count": 0,
            "total_objects": 0
        }
    
    # Delete all objects in the user's folder (includes all images and thumbnails)
    stats = await delete_all_objects_in_prefix(prefix)
    
    logger.info(f"Deleted images from S3 folder {prefix} for user {user_id}: {stats['deleted_count']} deleted, {stats['failed_count']} failed, {stats['total_objects']} total")
    
    return stats


@router.post("/users/{user_id}/listings", response_model=ListingResponse, status_code=status.HTTP_201_CREATED)
async def create_hotel_listing(
    user_id: str,
    request: CreateListingRequest,
    admin_id: str = Depends(get_admin_user)
):
    """
    Create a listing for an existing hotel user (admin endpoint).
    
    This endpoint allows admins to create listings for hotels after the hotel user has been created.
    Use this after uploading listing images via POST /upload/images/listing?target_user_id={user_id}
    """
    try:
        logger.info(f"Admin {admin_id} creating listing for hotel user {user_id}")
        logger.debug(f"Request data: {request.model_dump()}")
        # Verify user exists and is a hotel
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
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="User is not a hotel"
            )
        
        # Get hotel profile
        hotel_profile = await Database.fetchrow(
            "SELECT id FROM hotel_profiles WHERE user_id = $1",
            user_id
        )
        
        if not hotel_profile:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Hotel profile not found"
            )
        
        hotel_profile_id = hotel_profile['id']
        
        # Use transaction to ensure atomicity
        pool = await Database.get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                # Create listing
                listing = await conn.fetchrow(
                    """
                    INSERT INTO hotel_listings 
                    (hotel_profile_id, name, location, description, accommodation_type, images)
                    VALUES ($1, $2, $3, $4, $5, $6)
                    RETURNING id, name, location, description, accommodation_type, images, 
                              status, created_at, updated_at
                    """,
                    hotel_profile_id,
                    request.name,
                    request.location,
                    request.description,
                    request.accommodationType,
                    request.images
                )
                
                listing_id = listing['id']
                
                # Create collaboration offerings
                offerings_response = []
                for offering in request.collaborationOfferings:
                    offering_record = await conn.fetchrow(
                        """
                        INSERT INTO listing_collaboration_offerings
                        (listing_id, collaboration_type, availability_months, platforms,
                         free_stay_min_nights, free_stay_max_nights, paid_max_amount, discount_percentage)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                        RETURNING id, collaboration_type, availability_months, platforms,
                                  free_stay_min_nights, free_stay_max_nights, paid_max_amount, 
                                  discount_percentage, created_at, updated_at
                        """,
                        listing_id,
                        offering.collaborationType,
                        offering.availabilityMonths,
                        offering.platforms,
                        offering.freeStayMinNights,
                        offering.freeStayMaxNights,
                        offering.paidMaxAmount,
                        offering.discountPercentage
                    )
                    
                    offerings_response.append(CollaborationOfferingResponse(
                        id=str(offering_record['id']),
                        listing_id=str(listing_id),
                        collaboration_type=offering_record['collaboration_type'],
                        availability_months=offering_record['availability_months'],
                        platforms=offering_record['platforms'],
                        free_stay_min_nights=offering_record['free_stay_min_nights'],
                        free_stay_max_nights=offering_record['free_stay_max_nights'],
                        paid_max_amount=offering_record['paid_max_amount'],
                        discount_percentage=offering_record['discount_percentage'],
                        created_at=offering_record['created_at'],
                        updated_at=offering_record['updated_at']
                    ))
                
                # Create creator requirements
                requirements = await conn.fetchrow(
                    """
                    INSERT INTO listing_creator_requirements
                    (listing_id, platforms, min_followers, target_countries, target_age_min, target_age_max)
                    VALUES ($1, $2, $3, $4, $5, $6)
                    RETURNING id, platforms, min_followers, target_countries, 
                              target_age_min, target_age_max, created_at, updated_at
                    """,
                    listing_id,
                    request.creatorRequirements.platforms,
                    request.creatorRequirements.minFollowers,
                    request.creatorRequirements.targetCountries,
                    request.creatorRequirements.targetAgeMin,
                    request.creatorRequirements.targetAgeMax
                )
                
                requirements_response = CreatorRequirementsResponse(
                    id=str(requirements['id']),
                    listing_id=str(listing_id),
                    platforms=requirements['platforms'],
                    min_followers=requirements['min_followers'],
                    target_countries=requirements['target_countries'],
                    target_age_min=requirements['target_age_min'],
                    target_age_max=requirements['target_age_max'],
                    created_at=requirements['created_at'],
                    updated_at=requirements['updated_at']
                )
        
        logger.info(f"Admin {admin_id} created listing for hotel user {user_id}")
        
        return ListingResponse(
            id=str(listing_id),
            hotel_profile_id=str(hotel_profile_id),
            name=listing['name'],
            location=listing['location'],
            description=listing['description'],
            accommodation_type=listing['accommodation_type'],
            images=listing['images'],
            status=listing['status'],
            created_at=listing['created_at'],
            updated_at=listing['updated_at'],
            collaboration_offerings=offerings_response,
            creator_requirements=requirements_response
        )
        
    except HTTPException:
        raise
    except ValueError as e:
        logger.error(f"Value error creating listing: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        logger.error(f"Error creating listing: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to create listing: {str(e)}"
        )


@router.delete("/users/{user_id}", status_code=status.HTTP_200_OK)
async def delete_user(
    user_id: str,
    admin_id: str = Depends(get_admin_user)
):
    """
    Delete a user and all associated data (admin endpoint).
    
    This will permanently delete:
    - User account
    - Creator profile (if creator) - including all platforms
    - Hotel profile (if hotel) - including all listings, offerings, and requirements
    - All associated S3 images (profile pictures, listing images, and their thumbnails)
    - All related records (cascade delete)
    
    **Warning**: This action cannot be undone!
    """
    try:
        # Prevent self-deletion
        if user_id == admin_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Cannot delete your own account"
            )
        
        # Verify user exists and get user info
        user = await Database.fetchrow(
            """
            SELECT id, email, name, type, status
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
        
        # Delete all images associated with this user from S3
        image_deletion_stats = await delete_user_images(user_id, user['type'])
        
        # Delete user (CASCADE will handle related records)
        await Database.execute(
            "DELETE FROM users WHERE id = $1",
            user_id
        )
        
        logger.info(f"Admin {admin_id} deleted user {user_id} (type: {user['type']}, email: {user['email']})")
        
        return {
            "message": "User deleted successfully",
            "deleted_user": {
                "id": user_id,
                "email": user['email'],
                "name": user['name'],
                "type": user['type']
            }
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting user: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to delete user: {str(e)}"
        )
