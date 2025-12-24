"""
Admin routes for user management
"""
from fastapi import APIRouter, HTTPException, status, Depends, Query
from pydantic import BaseModel, EmailStr, Field, field_validator
from typing import List, Optional, Literal
from datetime import datetime
from decimal import Decimal
import logging
import re
from urllib.parse import urlparse

from app.database import Database
from app.dependencies import get_current_user_id

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["admin"])


# Validation helpers
def validate_url(url: str) -> str:
    """Validate URL format"""
    if not url:
        return url
    try:
        result = urlparse(url)
        if not all([result.scheme, result.netloc]):
            raise ValueError("Invalid URL format. Must include scheme (http/https)")
        if result.scheme not in ['http', 'https']:
            raise ValueError("URL must use http or https scheme")
        return url
    except Exception as e:
        raise ValueError(f"Invalid URL: {str(e)}")


def validate_phone(phone: str) -> str:
    """Validate phone number format (optional, basic validation)"""
    if not phone:
        return phone
    # Basic phone validation: allow digits, spaces, +, -, (, )
    phone_pattern = re.compile(r'^[\d\s\+\-\(\)]+$')
    if not phone_pattern.match(phone):
        raise ValueError("Invalid phone number format")
    # Remove spaces and check minimum length
    digits_only = re.sub(r'[\s\+\-\(\)]', '', phone)
    if len(digits_only) < 7:
        raise ValueError("Phone number must contain at least 7 digits")
    return phone


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
class UserListItem(BaseModel):
    """User list item response model"""
    id: str
    email: str
    name: str
    type: str
    status: str
    email_verified: bool
    created_at: datetime
    updated_at: datetime


class UserListResponse(BaseModel):
    """User list response with pagination"""
    users: List[UserListItem]
    total: int
    page: int
    page_size: int
    total_pages: int


class UserDetailResponse(BaseModel):
    """Detailed user response with profile information"""
    id: str
    email: str
    name: str
    type: str
    status: str
    email_verified: bool
    avatar: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    # Profile information (if exists)
    creator_profile: Optional[dict] = None
    hotel_profile: Optional[dict] = None


class UpdateUserRequest(BaseModel):
    """Request model for updating user information"""
    name: Optional[str] = None
    email: Optional[EmailStr] = None
    status: Optional[Literal["pending", "verified", "rejected", "suspended"]] = None
    avatar: Optional[str] = None
    email_verified: Optional[bool] = None
    
    @field_validator('avatar')
    @classmethod
    def validate_avatar_url(cls, v):
        if v is not None:
            return validate_url(v)
        return v


class UpdateUserResponse(BaseModel):
    """Response model for user update"""
    message: str
    user: UserDetailResponse


class UpdateUserStatusRequest(BaseModel):
    """Request model for updating user status"""
    status: Literal["pending", "verified", "rejected", "suspended"]
    reason: Optional[str] = None


class UpdateUserStatusResponse(BaseModel):
    """Response model for status update"""
    message: str
    user_id: str
    old_status: str
    new_status: str


class CreateUserRequest(BaseModel):
    """Request model for creating a new user"""
    name: str = Field(..., min_length=1, description="User's full name")
    email: EmailStr = Field(..., description="User's email address")
    password: str = Field(..., min_length=8, description="User's password (min 8 characters)")
    type: Literal["creator", "hotel", "admin"] = Field(..., description="User type")
    status: Optional[Literal["pending", "verified", "rejected", "suspended"]] = Field(
        default="pending", 
        description="Initial user status"
    )
    avatar: Optional[str] = Field(None, description="Avatar URL")
    email_verified: Optional[bool] = Field(default=False, description="Whether email is verified")
    
    @field_validator('avatar')
    @classmethod
    def validate_avatar_url(cls, v):
        if v is not None:
            return validate_url(v)
        return v


class CreateUserResponse(BaseModel):
    """Response model for user creation"""
    message: str
    user: UserDetailResponse


class DeleteUserResponse(BaseModel):
    """Response model for user deletion"""
    message: str
    deleted_user_id: str
    cascade_deleted: dict


class UpdateCreatorProfileRequest(BaseModel):
    """Request model for updating creator profile"""
    location: Optional[str] = None
    short_description: Optional[str] = None
    portfolio_link: Optional[str] = None
    phone: Optional[str] = None
    profile_picture: Optional[str] = None
    profile_complete: Optional[bool] = None
    profile_completed_at: Optional[datetime] = None
    
    @field_validator('portfolio_link', 'profile_picture')
    @classmethod
    def validate_urls(cls, v):
        if v is not None:
            return validate_url(v)
        return v
    
    @field_validator('phone')
    @classmethod
    def validate_phone(cls, v):
        if v is not None:
            return validate_phone(v)
        return v


class CreatorProfileResponse(BaseModel):
    """Response model for creator profile"""
    id: str
    user_id: str
    location: Optional[str] = None
    short_description: Optional[str] = None
    portfolio_link: Optional[str] = None
    phone: Optional[str] = None
    profile_picture: Optional[str] = None
    profile_complete: bool
    profile_completed_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime


class UpdateCreatorProfileResponse(BaseModel):
    """Response model for creator profile update"""
    message: str
    profile: CreatorProfileResponse


class UpdateHotelProfileRequest(BaseModel):
    """Request model for updating hotel profile"""
    name: Optional[str] = None
    location: Optional[str] = None
    about: Optional[str] = None
    website: Optional[str] = None
    phone: Optional[str] = None
    picture: Optional[str] = None
    profile_complete: Optional[bool] = None
    profile_completed_at: Optional[datetime] = None
    
    @field_validator('website', 'picture')
    @classmethod
    def validate_urls(cls, v):
        if v is not None:
            return validate_url(v)
        return v
    
    @field_validator('phone')
    @classmethod
    def validate_phone(cls, v):
        if v is not None:
            return validate_phone(v)
        return v


class HotelProfileResponse(BaseModel):
    """Response model for hotel profile"""
    id: str
    user_id: str
    name: str
    location: str
    about: Optional[str] = None
    website: Optional[str] = None
    phone: Optional[str] = None
    picture: Optional[str] = None
    profile_complete: bool
    profile_completed_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime


class UpdateHotelProfileResponse(BaseModel):
    """Response model for hotel profile update"""
    message: str
    profile: HotelProfileResponse


class CreatePlatformRequest(BaseModel):
    """Request model for creating a platform"""
    name: Literal["Instagram", "TikTok", "YouTube", "Facebook"] = Field(..., description="Platform name")
    handle: str = Field(..., min_length=1, description="Platform handle (e.g., @username)")
    followers: int = Field(0, ge=0, description="Number of followers")
    engagement_rate: Decimal = Field(Decimal("0.00"), ge=Decimal("0.00"), le=Decimal("100.00"), description="Engagement rate (0-100)")
    top_countries: Optional[dict] = Field(None, description="Top countries analytics (JSON)")
    top_age_groups: Optional[dict] = Field(None, description="Top age groups analytics (JSON)")
    gender_split: Optional[dict] = Field(None, description="Gender split analytics (JSON)")


class UpdatePlatformRequest(BaseModel):
    """Request model for updating a platform"""
    name: Optional[Literal["Instagram", "TikTok", "YouTube", "Facebook"]] = None
    handle: Optional[str] = None
    followers: Optional[int] = Field(None, ge=0)
    engagement_rate: Optional[Decimal] = Field(None, ge=Decimal("0.00"), le=Decimal("100.00"))
    top_countries: Optional[dict] = None
    top_age_groups: Optional[dict] = None
    gender_split: Optional[dict] = None


class PlatformResponse(BaseModel):
    """Response model for platform"""
    id: str
    creator_id: str
    name: str
    handle: str
    followers: int
    engagement_rate: Decimal
    top_countries: Optional[dict] = None
    top_age_groups: Optional[dict] = None
    gender_split: Optional[dict] = None
    created_at: datetime
    updated_at: datetime


class PlatformListResponse(BaseModel):
    """Response model for platform list"""
    platforms: List[PlatformResponse]


class CreatePlatformResponse(BaseModel):
    """Response model for platform creation"""
    message: str
    platform: PlatformResponse


class UpdatePlatformResponse(BaseModel):
    """Response model for platform update"""
    message: str
    platform: PlatformResponse


class DeletePlatformResponse(BaseModel):
    """Response model for platform deletion"""
    message: str
    deleted_platform_id: str


class CreateListingRequest(BaseModel):
    """Request model for creating a listing"""
    name: str = Field(..., min_length=1, description="Listing name")
    location: str = Field(..., min_length=1, description="Listing location")
    description: str = Field(..., min_length=1, description="Listing description")
    accommodation_type: Optional[Literal["Hotel", "Resort", "Boutique Hotel", "Lodge", "Apartment", "Villa"]] = Field(
        None, description="Type of accommodation"
    )
    images: List[str] = Field(default_factory=list, description="Array of image URLs")
    status: Literal["pending", "verified", "rejected"] = Field("pending", description="Listing status")


class UpdateListingRequest(BaseModel):
    """Request model for updating a listing"""
    name: Optional[str] = None
    location: Optional[str] = None
    description: Optional[str] = None
    accommodation_type: Optional[Literal["Hotel", "Resort", "Boutique Hotel", "Lodge", "Apartment", "Villa"]] = None
    images: Optional[List[str]] = None
    status: Optional[Literal["pending", "verified", "rejected"]] = None


class ListingResponse(BaseModel):
    """Response model for listing"""
    id: str
    hotel_profile_id: str
    name: str
    location: str
    description: str
    accommodation_type: Optional[str] = None
    images: List[str]
    status: str
    created_at: datetime
    updated_at: datetime


class ListingListResponse(BaseModel):
    """Response model for listing list"""
    listings: List[ListingResponse]


class CreateListingResponse(BaseModel):
    """Response model for listing creation"""
    message: str
    listing: ListingResponse


class UpdateListingResponse(BaseModel):
    """Response model for listing update"""
    message: str
    listing: ListingResponse


class DeleteListingResponse(BaseModel):
    """Response model for listing deletion"""
    message: str
    deleted_listing_id: str


@router.post("/users", response_model=CreateUserResponse, status_code=status.HTTP_201_CREATED)
async def create_user(
    request: CreateUserRequest,
    admin_id: str = Depends(get_admin_user)
):
    """
    Create a new user.
    
    Admin can create users with initial profile data.
    For creator/hotel types, basic profile records will be created automatically.
    """
    try:
        from app.auth import hash_password
        
        # Check if email already exists
        existing_user = await Database.fetchrow(
            "SELECT id FROM users WHERE email = $1",
            request.email
        )
        if existing_user:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Email already in use"
            )
        
        # Hash password
        password_hash = hash_password(request.password)
        
        # Create user
        new_user = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status, avatar, email_verified)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id, email, name, type, status, email_verified, avatar, created_at, updated_at
            """,
            request.email,
            password_hash,
            request.name,
            request.type,
            request.status,
            request.avatar,
            request.email_verified
        )
        
        user_id = str(new_user['id'])
        
        # Create profile based on user type
        creator_profile = None
        hotel_profile = None
        
        if request.type == 'creator':
            # Create empty creator profile
            creator = await Database.fetchrow(
                """
                INSERT INTO creators (user_id)
                VALUES ($1)
                RETURNING id, location, short_description, portfolio_link, phone,
                        profile_picture, profile_complete, profile_completed_at,
                        created_at, updated_at
                """,
                user_id
            )
            if creator:
                creator_profile = {
                    'id': str(creator['id']),
                    'location': creator['location'],
                    'short_description': creator['short_description'],
                    'portfolio_link': creator['portfolio_link'],
                    'phone': creator['phone'],
                    'profile_picture': creator['profile_picture'],
                    'profile_complete': creator['profile_complete'],
                    'profile_completed_at': creator['profile_completed_at'].isoformat() if creator['profile_completed_at'] else None,
                    'created_at': creator['created_at'].isoformat(),
                    'updated_at': creator['updated_at'].isoformat(),
                    'platforms': []
                }
        
        elif request.type == 'hotel':
            # Create hotel profile with placeholder location
            hotel = await Database.fetchrow(
                """
                INSERT INTO hotel_profiles (user_id, name, location)
                VALUES ($1, $2, 'Not specified')
                RETURNING id, name, location, about, website, phone,
                        picture, profile_complete, profile_completed_at,
                        created_at, updated_at
                """,
                user_id,
                request.name  # Use user name as initial hotel name
            )
            if hotel:
                # Get listings count (will be 0 for new hotel)
                listings_count = await Database.fetchval(
                    "SELECT COUNT(*) FROM hotel_listings WHERE hotel_profile_id = $1",
                    hotel['id']
                )
                
                hotel_profile = {
                    'id': str(hotel['id']),
                    'name': hotel['name'],
                    'location': hotel['location'],
                    'about': hotel['about'],
                    'website': hotel['website'],
                    'phone': hotel['phone'],
                    'picture': hotel['picture'],
                    'profile_complete': hotel['profile_complete'],
                    'profile_completed_at': hotel['profile_completed_at'].isoformat() if hotel['profile_completed_at'] else None,
                    'created_at': hotel['created_at'].isoformat(),
                    'updated_at': hotel['updated_at'].isoformat(),
                    'listings_count': listings_count
                }
        
        user_detail = UserDetailResponse(
            id=user_id,
            email=new_user['email'],
            name=new_user['name'],
            type=new_user['type'],
            status=new_user['status'],
            email_verified=new_user['email_verified'],
            avatar=new_user['avatar'],
            created_at=new_user['created_at'],
            updated_at=new_user['updated_at'],
            creator_profile=creator_profile,
            hotel_profile=hotel_profile
        )
        
        logger.info(f"Admin {admin_id} created user {user_id} (type: {request.type})")
        
        return CreateUserResponse(
            message="User created successfully",
            user=user_detail
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating user: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to create user: {str(e)}"
        )


@router.delete("/users/{user_id}", response_model=DeleteUserResponse, status_code=status.HTTP_200_OK)
async def delete_user(
    user_id: str,
    admin_id: str = Depends(get_admin_user)
):
    """
    Delete a user and all associated data (cascade delete).
    
    This will delete:
    - User record
    - Creator profile (if creator) and all platforms
    - Hotel profile (if hotel) and all listings
    - All related records due to CASCADE constraints
    
    Admins cannot delete their own account.
    """
    try:
        # Check if user exists and get type for cascade info
        user = await Database.fetchrow(
            "SELECT id, type FROM users WHERE id = $1",
            user_id
        )
        
        if not user:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="User not found"
            )
        
        # Prevent admin from deleting themselves
        if user_id == admin_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Cannot delete your own admin account"
            )
        
        # Count related records before deletion (for response)
        cascade_info = {}
        
        if user['type'] == 'creator':
            # Count platforms
            creator = await Database.fetchrow(
                "SELECT id FROM creators WHERE user_id = $1",
                user_id
            )
            if creator:
                platform_count = await Database.fetchrow(
                    "SELECT COUNT(*) as count FROM creator_platforms WHERE creator_id = $1",
                    creator['id']
                )
                cascade_info['platforms'] = platform_count['count'] if platform_count else 0
            else:
                cascade_info['platforms'] = 0
        
        elif user['type'] == 'hotel':
            # Count listings
            hotel = await Database.fetchrow(
                "SELECT id FROM hotel_profiles WHERE user_id = $1",
                user_id
            )
            if hotel:
                listing_count = await Database.fetchrow(
                    "SELECT COUNT(*) as count FROM hotel_listings WHERE hotel_profile_id = $1",
                    hotel['id']
                )
                cascade_info['listings'] = listing_count['count'] if listing_count else 0
            else:
                cascade_info['listings'] = 0
        
        # Delete user (CASCADE will handle related records)
        await Database.execute(
            "DELETE FROM users WHERE id = $1",
            user_id
        )
        
        logger.info(f"Admin {admin_id} deleted user {user_id} (type: {user['type']})")
        
        return DeleteUserResponse(
            message="User deleted successfully",
            deleted_user_id=user_id,
            cascade_deleted=cascade_info
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting user: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to delete user: {str(e)}"
        )


@router.get("/users", response_model=UserListResponse, status_code=status.HTTP_200_OK)
async def list_users(
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int = Query(20, ge=1, le=100, description="Items per page"),
    type: Optional[Literal["creator", "hotel", "admin"]] = Query(None, description="Filter by user type"),
    status_filter: Optional[Literal["pending", "verified", "rejected", "suspended"]] = Query(None, alias="status", description="Filter by status"),
    search: Optional[str] = Query(None, description="Search by name or email"),
    admin_id: str = Depends(get_admin_user)
):
    """
    List all users with pagination and filtering.
    
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
            where_conditions.append(f"u.type = ${param_count}")
            params.append(type)
        
        if status_filter:
            param_count += 1
            where_conditions.append(f"u.status = ${param_count}")
            params.append(status_filter)
        
        if search:
            param_count += 1
            where_conditions.append(f"(LOWER(u.name) LIKE LOWER(${param_count}) OR LOWER(u.email) LIKE LOWER(${param_count}))")
            search_pattern = f"%{search}%"
            params.append(search_pattern)
        
        where_clause = " AND ".join(where_conditions) if where_conditions else "1=1"
        
        # Get total count
        count_query = f"""
            SELECT COUNT(*) as total
            FROM users u
            WHERE {where_clause}
        """
        total_result = await Database.fetchrow(count_query, *params)
        total = total_result['total'] if total_result else 0
        
        # Calculate pagination
        offset = (page - 1) * page_size
        total_pages = (total + page_size - 1) // page_size if total > 0 else 0
        
        # Get users
        users_query = f"""
            SELECT 
                u.id, u.email, u.name, u.type, u.status, 
                u.email_verified, u.created_at, u.updated_at
            FROM users u
            WHERE {where_clause}
            ORDER BY u.created_at DESC
            LIMIT ${param_count + 1} OFFSET ${param_count + 2}
        """
        params.extend([page_size, offset])
        
        users_data = await Database.fetch(users_query, *params)
        
        users = [
            UserListItem(
                id=str(u['id']),
                email=u['email'],
                name=u['name'],
                type=u['type'],
                status=u['status'],
                email_verified=u['email_verified'],
                created_at=u['created_at'],
                updated_at=u['updated_at']
            )
            for u in users_data
        ]
        
        return UserListResponse(
            users=users,
            total=total,
            page=page,
            page_size=page_size,
            total_pages=total_pages
        )
        
    except Exception as e:
        logger.error(f"Error listing users: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to list users: {str(e)}"
        )


@router.get("/users/{user_id}", response_model=UserDetailResponse, status_code=status.HTTP_200_OK)
async def get_user_details(
    user_id: str,
    admin_id: str = Depends(get_admin_user)
):
    """
    Get detailed information about a specific user, including profile data.
    """
    try:
        # Get user
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
        
        # Get profile information based on user type
        creator_profile = None
        hotel_profile = None
        
        if user['type'] == 'creator':
            creator = await Database.fetchrow(
                """
                SELECT 
                    c.id, c.location, c.short_description, c.portfolio_link, c.phone,
                    c.profile_picture, c.profile_complete, c.profile_completed_at,
                    c.created_at, c.updated_at
                FROM creators c
                WHERE c.user_id = $1
                """,
                user_id
            )
            if creator:
                creator_profile = {
                    'id': str(creator['id']),
                    'location': creator['location'],
                    'short_description': creator['short_description'],
                    'portfolio_link': creator['portfolio_link'],
                    'phone': creator['phone'],
                    'profile_picture': creator['profile_picture'],
                    'profile_complete': creator['profile_complete'],
                    'profile_completed_at': creator['profile_completed_at'].isoformat() if creator['profile_completed_at'] else None,
                    'created_at': creator['created_at'].isoformat(),
                    'updated_at': creator['updated_at'].isoformat()
                }
                
                # Get platforms
                platforms = await Database.fetch(
                    """
                    SELECT id, name, handle, followers, engagement_rate
                    FROM creator_platforms
                    WHERE creator_id = $1
                    ORDER BY name
                    """,
                    creator['id']
                )
                creator_profile['platforms'] = [
                    {
                        'id': str(p['id']),
                        'name': p['name'],
                        'handle': p['handle'],
                        'followers': p['followers'],
                        'engagement_rate': float(p['engagement_rate']) if p['engagement_rate'] else None
                    }
                    for p in platforms
                ]
        
        elif user['type'] == 'hotel':
            hotel = await Database.fetchrow(
                """
                SELECT 
                    hp.id, hp.name, hp.location, hp.about, hp.website, hp.phone,
                    hp.picture, hp.profile_complete, hp.profile_completed_at,
                    hp.created_at, hp.updated_at
                FROM hotel_profiles hp
                WHERE hp.user_id = $1
                """,
                user_id
            )
            if hotel:
                hotel_profile = {
                    'id': str(hotel['id']),
                    'name': hotel['name'],
                    'location': hotel['location'],
                    'about': hotel['about'],
                    'website': hotel['website'],
                    'phone': hotel['phone'],
                    'picture': hotel['picture'],
                    'profile_complete': hotel['profile_complete'],
                    'profile_completed_at': hotel['profile_completed_at'].isoformat() if hotel['profile_completed_at'] else None,
                    'created_at': hotel['created_at'].isoformat(),
                    'updated_at': hotel['updated_at'].isoformat()
                }
                
                # Get all listings
                listings = await Database.fetch(
                    """
                    SELECT id, hotel_profile_id, name, location, description, 
                           accommodation_type, images, status, created_at, updated_at
                    FROM hotel_listings
                    WHERE hotel_profile_id = $1
                    ORDER BY created_at DESC
                    """,
                    hotel['id']
                )
                hotel_profile['listings'] = [
                    {
                        'id': str(l['id']),
                        'hotel_profile_id': str(l['hotel_profile_id']),
                        'name': l['name'],
                        'location': l['location'],
                        'description': l['description'],
                        'accommodation_type': l['accommodation_type'],
                        'images': l['images'] if l['images'] else [],
                        'status': l['status'],
                        'created_at': l['created_at'].isoformat(),
                        'updated_at': l['updated_at'].isoformat()
                    }
                    for l in listings
                ]
                hotel_profile['listings_count'] = len(listings)
        
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
            creator_profile=creator_profile,
            hotel_profile=hotel_profile
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting user details: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get user details: {str(e)}"
        )


@router.put("/users/{user_id}", response_model=UpdateUserResponse, status_code=status.HTTP_200_OK)
async def update_user(
    user_id: str,
    request: UpdateUserRequest,
    admin_id: str = Depends(get_admin_user)
):
    """
    Update user information (name, email, status, avatar, email_verified).
    """
    try:
        # Check if user exists
        user = await Database.fetchrow(
            "SELECT id, name, email, status FROM users WHERE id = $1",
            user_id
        )
        
        if not user:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="User not found"
            )
        
        # Build update query
        update_fields = []
        params = []
        param_count = 0
        
        if request.name is not None:
            param_count += 1
            update_fields.append(f"name = ${param_count}")
            params.append(request.name)
        
        if request.email is not None:
            # Check if email is already taken by another user
            existing = await Database.fetchrow(
                "SELECT id FROM users WHERE email = $1 AND id != $2",
                request.email,
                user_id
            )
            if existing:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Email already in use by another user"
                )
            param_count += 1
            update_fields.append(f"email = ${param_count}")
            params.append(request.email)
        
        if request.status is not None:
            param_count += 1
            update_fields.append(f"status = ${param_count}")
            params.append(request.status)
        
        if request.avatar is not None:
            param_count += 1
            update_fields.append(f"avatar = ${param_count}")
            params.append(request.avatar)
        
        if request.email_verified is not None:
            param_count += 1
            update_fields.append(f"email_verified = ${param_count}")
            params.append(request.email_verified)
        
        if not update_fields:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No fields to update"
            )
        
        # Add updated_at
        update_fields.append("updated_at = now()")
        
        # Add user_id for WHERE clause
        param_count += 1
        params.append(user_id)
        
        # Execute update
        update_query = f"""
            UPDATE users
            SET {', '.join(update_fields)}
            WHERE id = ${param_count}
            RETURNING id, email, name, type, status, email_verified, avatar, created_at, updated_at
        """
        
        updated_user = await Database.fetchrow(update_query, *params)
        
        # Get profile information
        creator_profile = None
        hotel_profile = None
        
        if updated_user['type'] == 'creator':
            creator = await Database.fetchrow(
                "SELECT id FROM creators WHERE user_id = $1",
                user_id
            )
            if creator:
                creator_profile = {'id': str(creator['id'])}
        elif updated_user['type'] == 'hotel':
            hotel = await Database.fetchrow(
                "SELECT id FROM hotel_profiles WHERE user_id = $1",
                user_id
            )
            if hotel:
                hotel_profile = {'id': str(hotel['id'])}
        
        user_detail = UserDetailResponse(
            id=str(updated_user['id']),
            email=updated_user['email'],
            name=updated_user['name'],
            type=updated_user['type'],
            status=updated_user['status'],
            email_verified=updated_user['email_verified'],
            avatar=updated_user['avatar'],
            created_at=updated_user['created_at'],
            updated_at=updated_user['updated_at'],
            creator_profile=creator_profile,
            hotel_profile=hotel_profile
        )
        
        logger.info(f"Admin {admin_id} updated user {user_id}")
        
        return UpdateUserResponse(
            message="User updated successfully",
            user=user_detail
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating user: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to update user: {str(e)}"
        )


@router.patch("/users/{user_id}/status", response_model=UpdateUserStatusResponse, status_code=status.HTTP_200_OK)
async def update_user_status(
    user_id: str,
    request: UpdateUserStatusRequest,
    admin_id: str = Depends(get_admin_user)
):
    """
    Update user status (approve, deny, suspend).
    This is a convenience endpoint specifically for status changes.
    """
    try:
        # Get current status
        user = await Database.fetchrow(
            "SELECT id, status FROM users WHERE id = $1",
            user_id
        )
        
        if not user:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="User not found"
            )
        
        old_status = user['status']
        
        # Update status
        await Database.execute(
            """
            UPDATE users
            SET status = $1, updated_at = now()
            WHERE id = $2
            """,
            request.status,
            user_id
        )
        
        logger.info(f"Admin {admin_id} changed user {user_id} status from {old_status} to {request.status}")
        if request.reason:
            logger.info(f"Reason: {request.reason}")
        
        return UpdateUserStatusResponse(
            message=f"User status updated from {old_status} to {request.status}",
            user_id=user_id,
            old_status=old_status,
            new_status=request.status
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating user status: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to update user status: {str(e)}"
        )


@router.put("/users/{user_id}/profile/creator", response_model=UpdateCreatorProfileResponse, status_code=status.HTTP_200_OK)
async def update_creator_profile(
    user_id: str,
    request: UpdateCreatorProfileRequest,
    admin_id: str = Depends(get_admin_user)
):
    """
    Update creator profile information.
    
    Admin can update all creator profile fields including location, description,
    portfolio link, phone, profile picture, and profile completion status.
    """
    try:
        # Check if user exists and is creator type
        user = await Database.fetchrow(
            "SELECT id, type FROM users WHERE id = $1",
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
        
        # Check if creator profile exists
        creator = await Database.fetchrow(
            "SELECT id FROM creators WHERE user_id = $1",
            user_id
        )
        
        if not creator:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Creator profile not found"
            )
        
        # Build update query
        update_fields = []
        params = []
        param_count = 0
        
        if request.location is not None:
            param_count += 1
            update_fields.append(f"location = ${param_count}")
            params.append(request.location)
        
        if request.short_description is not None:
            param_count += 1
            update_fields.append(f"short_description = ${param_count}")
            params.append(request.short_description)
        
        if request.portfolio_link is not None:
            param_count += 1
            update_fields.append(f"portfolio_link = ${param_count}")
            params.append(request.portfolio_link)
        
        if request.phone is not None:
            param_count += 1
            update_fields.append(f"phone = ${param_count}")
            params.append(request.phone)
        
        if request.profile_picture is not None:
            param_count += 1
            update_fields.append(f"profile_picture = ${param_count}")
            params.append(request.profile_picture)
        
        if request.profile_complete is not None:
            param_count += 1
            update_fields.append(f"profile_complete = ${param_count}")
            params.append(request.profile_complete)
            
            # Auto-set profile_completed_at if profile_complete is True
            if request.profile_complete:
                param_count += 1
                update_fields.append(f"profile_completed_at = ${param_count}")
                params.append(datetime.utcnow())
            elif request.profile_completed_at is None:
                # If setting to False and no explicit date provided, clear it
                param_count += 1
                update_fields.append(f"profile_completed_at = ${param_count}")
                params.append(None)
        
        if request.profile_completed_at is not None and request.profile_complete is None:
            # Only update date if explicitly provided and profile_complete not being set
            param_count += 1
            update_fields.append(f"profile_completed_at = ${param_count}")
            params.append(request.profile_completed_at)
        
        if not update_fields:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No fields to update"
            )
        
        # Add updated_at
        update_fields.append("updated_at = now()")
        
        # Add creator id for WHERE clause
        param_count += 1
        params.append(creator['id'])
        
        # Execute update
        update_query = f"""
            UPDATE creators
            SET {', '.join(update_fields)}
            WHERE id = ${param_count}
            RETURNING id, user_id, location, short_description, portfolio_link, phone,
                    profile_picture, profile_complete, profile_completed_at,
                    created_at, updated_at
        """
        
        updated_profile = await Database.fetchrow(update_query, *params)
        
        profile_response = CreatorProfileResponse(
            id=str(updated_profile['id']),
            user_id=str(updated_profile['user_id']),
            location=updated_profile['location'],
            short_description=updated_profile['short_description'],
            portfolio_link=updated_profile['portfolio_link'],
            phone=updated_profile['phone'],
            profile_picture=updated_profile['profile_picture'],
            profile_complete=updated_profile['profile_complete'],
            profile_completed_at=updated_profile['profile_completed_at'],
            created_at=updated_profile['created_at'],
            updated_at=updated_profile['updated_at']
        )
        
        logger.info(f"Admin {admin_id} updated creator profile for user {user_id}")
        
        return UpdateCreatorProfileResponse(
            message="Creator profile updated successfully",
            profile=profile_response
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating creator profile: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to update creator profile: {str(e)}"
        )


@router.put("/users/{user_id}/profile/hotel", response_model=UpdateHotelProfileResponse, status_code=status.HTTP_200_OK)
async def update_hotel_profile(
    user_id: str,
    request: UpdateHotelProfileRequest,
    admin_id: str = Depends(get_admin_user)
):
    """
    Update hotel profile information.
    
    Admin can update all hotel profile fields including name, location, about,
    website, phone, picture, and profile completion status.
    """
    try:
        # Check if user exists and is hotel type
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
        
        # Check if hotel profile exists
        hotel = await Database.fetchrow(
            "SELECT id FROM hotel_profiles WHERE user_id = $1",
            user_id
        )
        
        if not hotel:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Hotel profile not found"
            )
        
        # Build update query
        update_fields = []
        params = []
        param_count = 0
        
        if request.name is not None:
            param_count += 1
            update_fields.append(f"name = ${param_count}")
            params.append(request.name)
        
        if request.location is not None:
            param_count += 1
            update_fields.append(f"location = ${param_count}")
            params.append(request.location)
        
        if request.about is not None:
            param_count += 1
            update_fields.append(f"about = ${param_count}")
            params.append(request.about)
        
        if request.website is not None:
            param_count += 1
            update_fields.append(f"website = ${param_count}")
            params.append(request.website)
        
        if request.phone is not None:
            param_count += 1
            update_fields.append(f"phone = ${param_count}")
            params.append(request.phone)
        
        if request.picture is not None:
            param_count += 1
            update_fields.append(f"picture = ${param_count}")
            params.append(request.picture)
        
        if request.profile_complete is not None:
            param_count += 1
            update_fields.append(f"profile_complete = ${param_count}")
            params.append(request.profile_complete)
            
            # Auto-set profile_completed_at if profile_complete is True
            if request.profile_complete:
                param_count += 1
                update_fields.append(f"profile_completed_at = ${param_count}")
                params.append(datetime.utcnow())
            elif request.profile_completed_at is None:
                # If setting to False and no explicit date provided, clear it
                param_count += 1
                update_fields.append(f"profile_completed_at = ${param_count}")
                params.append(None)
        
        if request.profile_completed_at is not None and request.profile_complete is None:
            # Only update date if explicitly provided and profile_complete not being set
            param_count += 1
            update_fields.append(f"profile_completed_at = ${param_count}")
            params.append(request.profile_completed_at)
        
        if not update_fields:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No fields to update"
            )
        
        # Add updated_at
        update_fields.append("updated_at = now()")
        
        # Add hotel id for WHERE clause
        param_count += 1
        params.append(hotel['id'])
        
        # Execute update
        update_query = f"""
            UPDATE hotel_profiles
            SET {', '.join(update_fields)}
            WHERE id = ${param_count}
            RETURNING id, user_id, name, location, about, website, phone,
                    picture, profile_complete, profile_completed_at,
                    created_at, updated_at
        """
        
        updated_profile = await Database.fetchrow(update_query, *params)
        
        profile_response = HotelProfileResponse(
            id=str(updated_profile['id']),
            user_id=str(updated_profile['user_id']),
            name=updated_profile['name'],
            location=updated_profile['location'],
            about=updated_profile['about'],
            website=updated_profile['website'],
            phone=updated_profile['phone'],
            picture=updated_profile['picture'],
            profile_complete=updated_profile['profile_complete'],
            profile_completed_at=updated_profile['profile_completed_at'],
            created_at=updated_profile['created_at'],
            updated_at=updated_profile['updated_at']
        )
        
        logger.info(f"Admin {admin_id} updated hotel profile for user {user_id}")
        
        return UpdateHotelProfileResponse(
            message="Hotel profile updated successfully",
            profile=profile_response
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating hotel profile: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to update hotel profile: {str(e)}"
        )


@router.get("/users/{user_id}/platforms", response_model=PlatformListResponse, status_code=status.HTTP_200_OK)
async def list_platforms(
    user_id: str,
    admin_id: str = Depends(get_admin_user)
):
    """
    List all platforms for a creator user.
    """
    try:
        # Check if user exists and is creator type
        user = await Database.fetchrow(
            "SELECT id, type FROM users WHERE id = $1",
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
            "SELECT id FROM creators WHERE user_id = $1",
            user_id
        )
        
        if not creator:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Creator profile not found"
            )
        
        # Get all platforms
        platforms_data = await Database.fetch(
            """
            SELECT id, creator_id, name, handle, followers, engagement_rate,
                   top_countries, top_age_groups, gender_split,
                   created_at, updated_at
            FROM creator_platforms
            WHERE creator_id = $1
            ORDER BY name
            """,
            creator['id']
        )
        
        platforms = [
            PlatformResponse(
                id=str(p['id']),
                creator_id=str(p['creator_id']),
                name=p['name'],
                handle=p['handle'],
                followers=p['followers'],
                engagement_rate=p['engagement_rate'],
                top_countries=p['top_countries'],
                top_age_groups=p['top_age_groups'],
                gender_split=p['gender_split'],
                created_at=p['created_at'],
                updated_at=p['updated_at']
            )
            for p in platforms_data
        ]
        
        return PlatformListResponse(platforms=platforms)
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error listing platforms: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to list platforms: {str(e)}"
        )


@router.post("/users/{user_id}/platforms", response_model=CreatePlatformResponse, status_code=status.HTTP_201_CREATED)
async def create_platform(
    user_id: str,
    request: CreatePlatformRequest,
    admin_id: str = Depends(get_admin_user)
):
    """
    Create a new platform for a creator user.
    """
    try:
        # Check if user exists and is creator type
        user = await Database.fetchrow(
            "SELECT id, type FROM users WHERE id = $1",
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
            "SELECT id FROM creators WHERE user_id = $1",
            user_id
        )
        
        if not creator:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Creator profile not found"
            )
        
        # Check if platform already exists (unique constraint: creator_id + name)
        existing = await Database.fetchrow(
            "SELECT id FROM creator_platforms WHERE creator_id = $1 AND name = $2",
            creator['id'],
            request.name
        )
        
        if existing:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Platform '{request.name}' already exists for this creator"
            )
        
        # Create platform
        new_platform = await Database.fetchrow(
            """
            INSERT INTO creator_platforms 
                (creator_id, name, handle, followers, engagement_rate, 
                 top_countries, top_age_groups, gender_split)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id, creator_id, name, handle, followers, engagement_rate,
                      top_countries, top_age_groups, gender_split,
                      created_at, updated_at
            """,
            creator['id'],
            request.name,
            request.handle,
            request.followers,
            request.engagement_rate,
            request.top_countries,
            request.top_age_groups,
            request.gender_split
        )
        
        platform_response = PlatformResponse(
            id=str(new_platform['id']),
            creator_id=str(new_platform['creator_id']),
            name=new_platform['name'],
            handle=new_platform['handle'],
            followers=new_platform['followers'],
            engagement_rate=new_platform['engagement_rate'],
            top_countries=new_platform['top_countries'],
            top_age_groups=new_platform['top_age_groups'],
            gender_split=new_platform['gender_split'],
            created_at=new_platform['created_at'],
            updated_at=new_platform['updated_at']
        )
        
        logger.info(f"Admin {admin_id} created platform {platform_response.id} for creator {user_id}")
        
        return CreatePlatformResponse(
            message="Platform created successfully",
            platform=platform_response
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating platform: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to create platform: {str(e)}"
        )


@router.get("/users/{user_id}/platforms/{platform_id}", response_model=PlatformResponse, status_code=status.HTTP_200_OK)
async def get_platform(
    user_id: str,
    platform_id: str,
    admin_id: str = Depends(get_admin_user)
):
    """
    Get a specific platform for a creator user.
    """
    try:
        # Check if user exists and is creator type
        user = await Database.fetchrow(
            "SELECT id, type FROM users WHERE id = $1",
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
            "SELECT id FROM creators WHERE user_id = $1",
            user_id
        )
        
        if not creator:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Creator profile not found"
            )
        
        # Get platform and verify it belongs to this creator
        platform = await Database.fetchrow(
            """
            SELECT id, creator_id, name, handle, followers, engagement_rate,
                   top_countries, top_age_groups, gender_split,
                   created_at, updated_at
            FROM creator_platforms
            WHERE id = $1 AND creator_id = $2
            """,
            platform_id,
            creator['id']
        )
        
        if not platform:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Platform not found"
            )
        
        return PlatformResponse(
            id=str(platform['id']),
            creator_id=str(platform['creator_id']),
            name=platform['name'],
            handle=platform['handle'],
            followers=platform['followers'],
            engagement_rate=platform['engagement_rate'],
            top_countries=platform['top_countries'],
            top_age_groups=platform['top_age_groups'],
            gender_split=platform['gender_split'],
            created_at=platform['created_at'],
            updated_at=platform['updated_at']
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting platform: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get platform: {str(e)}"
        )


@router.put("/users/{user_id}/platforms/{platform_id}", response_model=UpdatePlatformResponse, status_code=status.HTTP_200_OK)
async def update_platform(
    user_id: str,
    platform_id: str,
    request: UpdatePlatformRequest,
    admin_id: str = Depends(get_admin_user)
):
    """
    Update a platform for a creator user.
    """
    try:
        # Check if user exists and is creator type
        user = await Database.fetchrow(
            "SELECT id, type FROM users WHERE id = $1",
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
            "SELECT id FROM creators WHERE user_id = $1",
            user_id
        )
        
        if not creator:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Creator profile not found"
            )
        
        # Check if platform exists and belongs to this creator
        existing_platform = await Database.fetchrow(
            "SELECT id, name FROM creator_platforms WHERE id = $1 AND creator_id = $2",
            platform_id,
            creator['id']
        )
        
        if not existing_platform:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Platform not found"
            )
        
        # If name is being changed, check uniqueness
        if request.name is not None and request.name != existing_platform['name']:
            name_check = await Database.fetchrow(
                "SELECT id FROM creator_platforms WHERE creator_id = $1 AND name = $2 AND id != $3",
                creator['id'],
                request.name,
                platform_id
            )
            if name_check:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Platform '{request.name}' already exists for this creator"
                )
        
        # Build update query
        update_fields = []
        params = []
        param_count = 0
        
        if request.name is not None:
            param_count += 1
            update_fields.append(f"name = ${param_count}")
            params.append(request.name)
        
        if request.handle is not None:
            param_count += 1
            update_fields.append(f"handle = ${param_count}")
            params.append(request.handle)
        
        if request.followers is not None:
            param_count += 1
            update_fields.append(f"followers = ${param_count}")
            params.append(request.followers)
        
        if request.engagement_rate is not None:
            param_count += 1
            update_fields.append(f"engagement_rate = ${param_count}")
            params.append(request.engagement_rate)
        
        if request.top_countries is not None:
            param_count += 1
            update_fields.append(f"top_countries = ${param_count}")
            params.append(request.top_countries)
        
        if request.top_age_groups is not None:
            param_count += 1
            update_fields.append(f"top_age_groups = ${param_count}")
            params.append(request.top_age_groups)
        
        if request.gender_split is not None:
            param_count += 1
            update_fields.append(f"gender_split = ${param_count}")
            params.append(request.gender_split)
        
        if not update_fields:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No fields to update"
            )
        
        # Add updated_at
        update_fields.append("updated_at = now()")
        
        # Add platform_id for WHERE clause
        param_count += 1
        params.append(platform_id)
        
        # Execute update
        update_query = f"""
            UPDATE creator_platforms
            SET {', '.join(update_fields)}
            WHERE id = ${param_count}
            RETURNING id, creator_id, name, handle, followers, engagement_rate,
                      top_countries, top_age_groups, gender_split,
                      created_at, updated_at
        """
        
        updated_platform = await Database.fetchrow(update_query, *params)
        
        platform_response = PlatformResponse(
            id=str(updated_platform['id']),
            creator_id=str(updated_platform['creator_id']),
            name=updated_platform['name'],
            handle=updated_platform['handle'],
            followers=updated_platform['followers'],
            engagement_rate=updated_platform['engagement_rate'],
            top_countries=updated_platform['top_countries'],
            top_age_groups=updated_platform['top_age_groups'],
            gender_split=updated_platform['gender_split'],
            created_at=updated_platform['created_at'],
            updated_at=updated_platform['updated_at']
        )
        
        logger.info(f"Admin {admin_id} updated platform {platform_id} for creator {user_id}")
        
        return UpdatePlatformResponse(
            message="Platform updated successfully",
            platform=platform_response
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating platform: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to update platform: {str(e)}"
        )


@router.delete("/users/{user_id}/platforms/{platform_id}", response_model=DeletePlatformResponse, status_code=status.HTTP_200_OK)
async def delete_platform(
    user_id: str,
    platform_id: str,
    admin_id: str = Depends(get_admin_user)
):
    """
    Delete a platform for a creator user.
    """
    try:
        # Check if user exists and is creator type
        user = await Database.fetchrow(
            "SELECT id, type FROM users WHERE id = $1",
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
            "SELECT id FROM creators WHERE user_id = $1",
            user_id
        )
        
        if not creator:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Creator profile not found"
            )
        
        # Check if platform exists and belongs to this creator
        platform = await Database.fetchrow(
            "SELECT id FROM creator_platforms WHERE id = $1 AND creator_id = $2",
            platform_id,
            creator['id']
        )
        
        if not platform:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Platform not found"
            )
        
        # Delete platform
        await Database.execute(
            "DELETE FROM creator_platforms WHERE id = $1",
            platform_id
        )
        
        logger.info(f"Admin {admin_id} deleted platform {platform_id} for creator {user_id}")
        
        return DeletePlatformResponse(
            message="Platform deleted successfully",
            deleted_platform_id=platform_id
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting platform: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to delete platform: {str(e)}"
        )


@router.get("/users/{user_id}/listings", response_model=ListingListResponse, status_code=status.HTTP_200_OK)
async def list_listings(
    user_id: str,
    admin_id: str = Depends(get_admin_user)
):
    """
    List all listings for a hotel user.
    """
    try:
        # Check if user exists and is hotel type
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
        hotel = await Database.fetchrow(
            "SELECT id FROM hotel_profiles WHERE user_id = $1",
            user_id
        )
        
        if not hotel:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Hotel profile not found"
            )
        
        # Get all listings
        listings_data = await Database.fetch(
            """
            SELECT id, hotel_profile_id, name, location, description, 
                   accommodation_type, images, status, created_at, updated_at
            FROM hotel_listings
            WHERE hotel_profile_id = $1
            ORDER BY created_at DESC
            """,
            hotel['id']
        )
        
        listings = [
            ListingResponse(
                id=str(l['id']),
                hotel_profile_id=str(l['hotel_profile_id']),
                name=l['name'],
                location=l['location'],
                description=l['description'],
                accommodation_type=l['accommodation_type'],
                images=l['images'] if l['images'] else [],
                status=l['status'],
                created_at=l['created_at'],
                updated_at=l['updated_at']
            )
            for l in listings_data
        ]
        
        return ListingListResponse(listings=listings)
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error listing listings: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to list listings: {str(e)}"
        )


@router.post("/users/{user_id}/listings", response_model=CreateListingResponse, status_code=status.HTTP_201_CREATED)
async def create_listing(
    user_id: str,
    request: CreateListingRequest,
    admin_id: str = Depends(get_admin_user)
):
    """
    Create a new listing for a hotel user.
    """
    try:
        # Check if user exists and is hotel type
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
        hotel = await Database.fetchrow(
            "SELECT id FROM hotel_profiles WHERE user_id = $1",
            user_id
        )
        
        if not hotel:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Hotel profile not found"
            )
        
        # Create listing
        new_listing = await Database.fetchrow(
            """
            INSERT INTO hotel_listings 
                (hotel_profile_id, name, location, description, accommodation_type, images, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id, hotel_profile_id, name, location, description, 
                      accommodation_type, images, status, created_at, updated_at
            """,
            hotel['id'],
            request.name,
            request.location,
            request.description,
            request.accommodation_type,
            request.images if request.images else [],
            request.status
        )
        
        listing_response = ListingResponse(
            id=str(new_listing['id']),
            hotel_profile_id=str(new_listing['hotel_profile_id']),
            name=new_listing['name'],
            location=new_listing['location'],
            description=new_listing['description'],
            accommodation_type=new_listing['accommodation_type'],
            images=new_listing['images'] if new_listing['images'] else [],
            status=new_listing['status'],
            created_at=new_listing['created_at'],
            updated_at=new_listing['updated_at']
        )
        
        logger.info(f"Admin {admin_id} created listing {listing_response.id} for hotel {user_id}")
        
        return CreateListingResponse(
            message="Listing created successfully",
            listing=listing_response
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating listing: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to create listing: {str(e)}"
        )


@router.get("/users/{user_id}/listings/{listing_id}", response_model=ListingResponse, status_code=status.HTTP_200_OK)
async def get_listing(
    user_id: str,
    listing_id: str,
    admin_id: str = Depends(get_admin_user)
):
    """
    Get a specific listing for a hotel user.
    """
    try:
        # Check if user exists and is hotel type
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
        hotel = await Database.fetchrow(
            "SELECT id FROM hotel_profiles WHERE user_id = $1",
            user_id
        )
        
        if not hotel:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Hotel profile not found"
            )
        
        # Get listing and verify it belongs to this hotel
        listing = await Database.fetchrow(
            """
            SELECT id, hotel_profile_id, name, location, description, 
                   accommodation_type, images, status, created_at, updated_at
            FROM hotel_listings
            WHERE id = $1 AND hotel_profile_id = $2
            """,
            listing_id,
            hotel['id']
        )
        
        if not listing:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Listing not found"
            )
        
        return ListingResponse(
            id=str(listing['id']),
            hotel_profile_id=str(listing['hotel_profile_id']),
            name=listing['name'],
            location=listing['location'],
            description=listing['description'],
            accommodation_type=listing['accommodation_type'],
            images=listing['images'] if listing['images'] else [],
            status=listing['status'],
            created_at=listing['created_at'],
            updated_at=listing['updated_at']
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting listing: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get listing: {str(e)}"
        )


@router.put("/users/{user_id}/listings/{listing_id}", response_model=UpdateListingResponse, status_code=status.HTTP_200_OK)
async def update_listing(
    user_id: str,
    listing_id: str,
    request: UpdateListingRequest,
    admin_id: str = Depends(get_admin_user)
):
    """
    Update a listing for a hotel user.
    """
    try:
        # Check if user exists and is hotel type
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
        hotel = await Database.fetchrow(
            "SELECT id FROM hotel_profiles WHERE user_id = $1",
            user_id
        )
        
        if not hotel:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Hotel profile not found"
            )
        
        # Check if listing exists and belongs to this hotel
        existing_listing = await Database.fetchrow(
            "SELECT id FROM hotel_listings WHERE id = $1 AND hotel_profile_id = $2",
            listing_id,
            hotel['id']
        )
        
        if not existing_listing:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Listing not found"
            )
        
        # Build update query
        update_fields = []
        params = []
        param_count = 0
        
        if request.name is not None:
            param_count += 1
            update_fields.append(f"name = ${param_count}")
            params.append(request.name)
        
        if request.location is not None:
            param_count += 1
            update_fields.append(f"location = ${param_count}")
            params.append(request.location)
        
        if request.description is not None:
            param_count += 1
            update_fields.append(f"description = ${param_count}")
            params.append(request.description)
        
        if request.accommodation_type is not None:
            param_count += 1
            update_fields.append(f"accommodation_type = ${param_count}")
            params.append(request.accommodation_type)
        
        if request.images is not None:
            param_count += 1
            update_fields.append(f"images = ${param_count}")
            params.append(request.images)
        
        if request.status is not None:
            param_count += 1
            update_fields.append(f"status = ${param_count}")
            params.append(request.status)
        
        if not update_fields:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No fields to update"
            )
        
        # Add updated_at
        update_fields.append("updated_at = now()")
        
        # Add listing_id for WHERE clause
        param_count += 1
        params.append(listing_id)
        
        # Execute update
        update_query = f"""
            UPDATE hotel_listings
            SET {', '.join(update_fields)}
            WHERE id = ${param_count}
            RETURNING id, hotel_profile_id, name, location, description, 
                      accommodation_type, images, status, created_at, updated_at
        """
        
        updated_listing = await Database.fetchrow(update_query, *params)
        
        listing_response = ListingResponse(
            id=str(updated_listing['id']),
            hotel_profile_id=str(updated_listing['hotel_profile_id']),
            name=updated_listing['name'],
            location=updated_listing['location'],
            description=updated_listing['description'],
            accommodation_type=updated_listing['accommodation_type'],
            images=updated_listing['images'] if updated_listing['images'] else [],
            status=updated_listing['status'],
            created_at=updated_listing['created_at'],
            updated_at=updated_listing['updated_at']
        )
        
        logger.info(f"Admin {admin_id} updated listing {listing_id} for hotel {user_id}")
        
        return UpdateListingResponse(
            message="Listing updated successfully",
            listing=listing_response
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating listing: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to update listing: {str(e)}"
        )


@router.delete("/users/{user_id}/listings/{listing_id}", response_model=DeleteListingResponse, status_code=status.HTTP_200_OK)
async def delete_listing(
    user_id: str,
    listing_id: str,
    admin_id: str = Depends(get_admin_user)
):
    """
    Delete a listing for a hotel user.
    """
    try:
        # Check if user exists and is hotel type
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
        hotel = await Database.fetchrow(
            "SELECT id FROM hotel_profiles WHERE user_id = $1",
            user_id
        )
        
        if not hotel:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Hotel profile not found"
            )
        
        # Check if listing exists and belongs to this hotel
        listing = await Database.fetchrow(
            "SELECT id FROM hotel_listings WHERE id = $1 AND hotel_profile_id = $2",
            listing_id,
            hotel['id']
        )
        
        if not listing:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Listing not found"
            )
        
        # Delete listing (CASCADE will handle related data)
        await Database.execute(
            "DELETE FROM hotel_listings WHERE id = $1",
            listing_id
        )
        
        logger.info(f"Admin {admin_id} deleted listing {listing_id} for hotel {user_id}")
        
        return DeleteListingResponse(
            message="Listing deleted successfully",
            deleted_listing_id=listing_id
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting listing: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to delete listing: {str(e)}"
        )
