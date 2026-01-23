"""
Admin routes for user management
"""
from fastapi import APIRouter, HTTPException, status, Depends, Query
from typing import List, Literal, Optional, Union
from datetime import datetime
from decimal import Decimal
import logging
import json
import bcrypt

from app.database import Database
from app.dependencies import get_current_user_id
from app.routers.collaborations import get_collaboration_deliverables
from app.s3_service import delete_all_objects_in_prefix, delete_file_from_s3, extract_key_from_url

# Import models from centralized location
from app.models.creators import UpdateCreatorProfileRequest, CreatorProfileResponse
from app.models.hotels import (
    CreateListingRequest,
    UpdateListingRequest,
    CollaborationOfferingRequest,
    CreatorRequirementsRequest,
    ListingResponse,
    UpdateHotelProfileRequest,
    HotelProfileResponse,
)
from app.models.common import CollaborationOfferingResponse, CreatorRequirementsResponse, PlatformResponse
from app.models.collaborations import CollaborationResponse
from app.models.admin import (
    UserResponse,
    UserListResponse,
    CollaborationListResponse,
    AdminPlatformRequest,
    CreateCreatorProfileRequest,
    CreateHotelProfileRequest,
    CreateUserRequest,
    UpdateUserRequest,
    AdminPlatformResponse,
    CreatorProfileDetail,
    AdminCollaborationOfferingResponse,
    AdminCreatorRequirementsResponse,
    AdminListingResponse,
    HotelProfileDetail,
    UserDetailResponse,
)

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
                               target_age_min, target_age_max, target_age_groups, created_at, updated_at
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
                            top_countries=requirements_data['target_countries'],
                            target_age_min=requirements_data['target_age_min'],
                            target_age_max=requirements_data['target_age_max'],
                            target_age_groups=requirements_data['target_age_groups'],
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
                                (listing_id, platforms, min_followers, target_countries, target_age_min, target_age_max, target_age_groups)
                                VALUES ($1, $2, $3, $4, $5, $6, $7)
                                """,
                                listing_id,
                                listing_request.creatorRequirements.platforms,
                                listing_request.creatorRequirements.minFollowers,
                                listing_request.creatorRequirements.topCountries,
                                listing_request.creatorRequirements.targetAgeMin,
                                listing_request.creatorRequirements.targetAgeMax,
                                listing_request.creatorRequirements.targetAgeGroups
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


@router.put("/users/{user_id}/profile/hotel", response_model=HotelProfileResponse, status_code=status.HTTP_200_OK)
async def update_hotel_profile(
    user_id: str,
    request: UpdateHotelProfileRequest,
    admin_id: str = Depends(get_admin_user)
):
    """
    Update a hotel's profile (admin endpoint).
    Supports partial updates - only provided fields will be updated.
    
    For picture:
    - Option 1: Upload image first using POST /upload/images?target_user_id={user_id}&prefix=hotels, then include the returned URL in picture field
    - Option 2: Provide an existing S3 URL directly in picture field
    """
    try:
        # Verify user exists and is a hotel
        user = await Database.fetchrow(
            "SELECT id, type, name FROM users WHERE id = $1",
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
            "SELECT id, profile_complete FROM hotel_profiles WHERE user_id = $1",
            user_id
        )
        
        if not hotel:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Hotel profile not found"
            )
        
        hotel_id = hotel['id']
        
        # Build dynamic UPDATE query for hotel_profiles table
        update_fields = []
        update_values = []
        param_counter = 1
        
        if request.name is not None:
            update_fields.append(f"name = ${param_counter}")
            update_values.append(request.name)
            param_counter += 1
        
        if request.location is not None:
            update_fields.append(f"location = ${param_counter}")
            update_values.append(request.location)
            param_counter += 1
        
        if request.about is not None:
            update_fields.append(f"about = ${param_counter}")
            update_values.append(request.about)
            param_counter += 1
        
        if request.website is not None:
            update_fields.append(f"website = ${param_counter}")
            update_values.append(str(request.website))
            param_counter += 1
        
        if request.phone is not None:
            update_fields.append(f"phone = ${param_counter}")
            update_values.append(request.phone)
            param_counter += 1
        
        if request.picture is not None:
            update_fields.append(f"picture = ${param_counter}")
            update_values.append(str(request.picture))
            param_counter += 1
        
        # Update hotel profile if there are fields to update
        if update_fields:
            update_fields.append("updated_at = now()")
            update_values.append(hotel_id)  # WHERE clause parameter
            
            update_query = f"""
                UPDATE hotel_profiles 
                SET {', '.join(update_fields)}
                WHERE id = ${param_counter}
            """
            await Database.execute(update_query, *update_values)
        
        # Update email in users table if provided
        if request.email is not None:
            await Database.execute(
                """
                UPDATE users 
                SET email = $1, updated_at = now()
                WHERE id = $2
                """,
                request.email,
                user_id
            )
        
        # Fetch updated profile with email from users table
        updated_hotel = await Database.fetchrow(
            """
            SELECT hp.id, hp.user_id, hp.name, hp.location, hp.about, hp.website, hp.phone, hp.picture, 
                   hp.status, hp.created_at, hp.updated_at, hp.profile_complete,
                   u.email, u.name as user_name
            FROM hotel_profiles hp
            JOIN users u ON hp.user_id = u.id
            WHERE hp.id = $1
            """,
            hotel_id
        )
        
        logger.info(f"Admin {admin_id} updated hotel profile for user {user_id}")
        
        return HotelProfileResponse(
            id=str(updated_hotel['id']),
            user_id=str(updated_hotel['user_id']),
            name=updated_hotel['name'],
            location=updated_hotel['location'] or "",
            email=updated_hotel['email'],
            about=updated_hotel['about'] or "",
            website=updated_hotel['website'],
            phone=updated_hotel['phone'],
            picture=updated_hotel['picture'],
            status=updated_hotel['status'],
            created_at=updated_hotel['created_at'],
            updated_at=updated_hotel['updated_at']
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating hotel profile: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to update hotel profile: {str(e)}"
        )


@router.put("/users/{user_id}", response_model=UserResponse, status_code=status.HTTP_200_OK)
async def update_user(
    user_id: str,
    request: UpdateUserRequest,
    admin_id: str = Depends(get_admin_user)
):
    """
    Update user fields (admin endpoint).
    Supports partial updates - only provided fields will be updated.
    
    Can update:
    - name: User's name
    - email: User's email (must be unique)
    - status: User status (pending, verified, rejected, suspended)
    - emailVerified: Whether email is verified
    - avatar: Avatar URL
    """
    try:
        # Prevent self-modification of critical fields
        if user_id == admin_id:
            # Allow admins to update their own name and avatar, but not status or emailVerified
            if request.status is not None or request.emailVerified is not None:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Cannot modify your own status or email verification status"
                )
        
        # Verify user exists
        user = await Database.fetchrow(
            "SELECT id, email, name, type, status, email_verified, avatar FROM users WHERE id = $1",
            user_id
        )
        
        if not user:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="User not found"
            )
        
        # Check if email is being changed and if it's already taken
        if request.email is not None and request.email != user['email']:
            existing_user = await Database.fetchrow(
                "SELECT id FROM users WHERE email = $1 AND id != $2",
                request.email,
                user_id
            )
            
            if existing_user:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Email already registered"
                )
        
        # Build dynamic UPDATE query
        update_fields = []
        update_values = []
        param_counter = 1
        
        if request.name is not None:
            update_fields.append(f"name = ${param_counter}")
            update_values.append(request.name)
            param_counter += 1
        
        if request.email is not None:
            update_fields.append(f"email = ${param_counter}")
            update_values.append(request.email)
            param_counter += 1
        
        if request.status is not None:
            update_fields.append(f"status = ${param_counter}")
            update_values.append(request.status)
            param_counter += 1
        
        if request.emailVerified is not None:
            update_fields.append(f"email_verified = ${param_counter}")
            update_values.append(request.emailVerified)
            param_counter += 1
        
        if request.avatar is not None:
            update_fields.append(f"avatar = ${param_counter}")
            update_values.append(request.avatar)
            param_counter += 1
        
        # Update user if there are fields to update
        if update_fields:
            update_fields.append("updated_at = now()")
            update_values.append(user_id)  # WHERE clause parameter
            
            update_query = f"""
                UPDATE users 
                SET {', '.join(update_fields)}
                WHERE id = ${param_counter}
            """
            await Database.execute(update_query, *update_values)
        
        # Fetch updated user
        updated_user = await Database.fetchrow(
            """
            SELECT id, email, name, type, status, email_verified, avatar, created_at, updated_at
            FROM users
            WHERE id = $1
            """,
            user_id
        )
        
        logger.info(f"Admin {admin_id} updated user {user_id} (fields: {list(request.model_dump(exclude_unset=True).keys())})")
        
        return UserResponse(
            id=str(updated_user['id']),
            email=updated_user['email'],
            name=updated_user['name'],
            type=updated_user['type'],
            status=updated_user['status'],
            email_verified=updated_user['email_verified'],
            avatar=updated_user['avatar'],
            created_at=updated_user['created_at'],
            updated_at=updated_user['updated_at']
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating user: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to update user: {str(e)}"
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
                    (listing_id, platforms, min_followers, target_countries, target_age_min, target_age_max, target_age_groups)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                    RETURNING id, platforms, min_followers, target_countries, 
                              target_age_min, target_age_max, target_age_groups, created_at, updated_at
                    """,
                    listing_id,
                    request.creatorRequirements.platforms,
                    request.creatorRequirements.minFollowers,
                    request.creatorRequirements.topCountries,
                    request.creatorRequirements.targetAgeMin,
                    request.creatorRequirements.targetAgeMax,
                    request.creatorRequirements.targetAgeGroups or []
                )
                
                requirements_response = CreatorRequirementsResponse(
                    id=str(requirements['id']),
                    listing_id=str(listing_id),
                    platforms=requirements['platforms'],
                    min_followers=requirements['min_followers'],
                    top_countries=requirements['target_countries'],
                    target_age_min=requirements['target_age_min'],
                    target_age_max=requirements['target_age_max'],
                    target_age_groups=requirements['target_age_groups'],
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


async def _get_listing_with_details_admin(listing_id: str, hotel_profile_id: str) -> dict:
    """Helper function to fetch a listing with its offerings and requirements (admin version)"""
    # Verify listing belongs to hotel
    listing = await Database.fetchrow(
        """
        SELECT id, hotel_profile_id, name, location, description, accommodation_type,
               images, status, created_at, updated_at
        FROM hotel_listings
        WHERE id = $1 AND hotel_profile_id = $2
        """,
        listing_id,
        hotel_profile_id
    )
    
    if not listing:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Listing not found"
        )
    
    # Get collaboration offerings
    offerings_data = await Database.fetch(
        """
        SELECT id, listing_id, collaboration_type, availability_months, platforms,
               free_stay_min_nights, free_stay_max_nights, paid_max_amount, discount_percentage,
               created_at, updated_at
        FROM listing_collaboration_offerings
        WHERE listing_id = $1
        ORDER BY created_at DESC
        """,
        listing_id
    )
    
    offerings_response = [
        CollaborationOfferingResponse.model_validate({
            "id": str(o['id']),
            "listing_id": str(o['listing_id']),
            "collaboration_type": o['collaboration_type'],
            "availability_months": o['availability_months'],
            "platforms": o['platforms'],
            "free_stay_min_nights": o['free_stay_min_nights'],
            "free_stay_max_nights": o['free_stay_max_nights'],
            "paid_max_amount": o['paid_max_amount'],
            "discount_percentage": o['discount_percentage'],
            "created_at": o['created_at'],
            "updated_at": o['updated_at']
        })
        for o in offerings_data
    ]
    
    # Get creator requirements
    requirements = await Database.fetchrow(
        """
        SELECT id, listing_id, platforms, min_followers, target_countries,
               target_age_min, target_age_max, target_age_groups, created_at, updated_at
        FROM listing_creator_requirements
        WHERE listing_id = $1
        """,
        listing_id
    )
    
    requirements_response = None
    if requirements:
        requirements_response = CreatorRequirementsResponse.model_validate({
            "id": str(requirements['id']),
            "listing_id": str(listing['id']),
            "platforms": requirements['platforms'],
            "min_followers": requirements['min_followers'],
            "top_countries": requirements['target_countries'],
            "target_age_min": requirements['target_age_min'],
            "target_age_max": requirements['target_age_max'],
            "target_age_groups": requirements['target_age_groups'],
            "created_at": requirements['created_at'],
            "updated_at": requirements['updated_at']
        })
    
    return {
        "listing": listing,
        "offerings": offerings_response,
        "requirements": requirements_response
    }


@router.put("/users/{user_id}/listings/{listing_id}", response_model=ListingResponse, status_code=status.HTTP_200_OK)
async def update_hotel_listing(
    user_id: str,
    listing_id: str,
    request: UpdateListingRequest,
    admin_id: str = Depends(get_admin_user)
):
    """
    Update a hotel listing (admin endpoint).
    Supports partial updates - only provided fields will be updated.
    
    If collaborationOfferings or creatorRequirements are provided, all existing ones will be replaced.
    If not provided, existing ones remain unchanged.
    """
    try:
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
        
        # Get current listing data
        listing_data = await _get_listing_with_details_admin(listing_id, hotel_profile_id)
        current_listing = listing_data["listing"]
        
        # Use transaction to ensure atomicity
        pool = await Database.get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                # Build dynamic UPDATE query for listing
                update_fields = []
                update_values = []
                param_counter = 1
                
                if request.name is not None:
                    update_fields.append(f"name = ${param_counter}")
                    update_values.append(request.name)
                    param_counter += 1
                
                if request.location is not None:
                    update_fields.append(f"location = ${param_counter}")
                    update_values.append(request.location)
                    param_counter += 1
                
                if request.description is not None:
                    update_fields.append(f"description = ${param_counter}")
                    update_values.append(request.description)
                    param_counter += 1
                
                if request.accommodationType is not None:
                    update_fields.append(f"accommodation_type = ${param_counter}")
                    update_values.append(request.accommodationType)
                    param_counter += 1
                
                if request.images is not None:
                    update_fields.append(f"images = ${param_counter}")
                    update_values.append(request.images)
                    param_counter += 1
                
                # Update listing if there are fields to update
                if update_fields:
                    update_fields.append("updated_at = now()")
                    update_values.append(listing_id)  # WHERE clause parameter
                    
                    update_query = f"""
                        UPDATE hotel_listings 
                        SET {', '.join(update_fields)}
                        WHERE id = ${param_counter}
                    """
                    await conn.execute(update_query, *update_values)
                
                # Update collaboration offerings if provided (replace strategy)
                if request.collaborationOfferings is not None:
                    # Delete existing offerings
                    await conn.execute(
                        "DELETE FROM listing_collaboration_offerings WHERE listing_id = $1",
                        listing_id
                    )
                    
                    # Insert new offerings
                    for offering in request.collaborationOfferings:
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
                
                # Update creator requirements if provided
                if request.creatorRequirements is not None:
                    # Delete existing requirements
                    await conn.execute(
                        "DELETE FROM listing_creator_requirements WHERE listing_id = $1",
                        listing_id
                    )
                    
                    # Insert new requirements
                    await conn.execute(
                        """
                        INSERT INTO listing_creator_requirements
                        (listing_id, platforms, min_followers, target_countries, target_age_min, target_age_max, target_age_groups)
                        VALUES ($1, $2, $3, $4, $5, $6, $7)
                        """,
                        listing_id,
                        request.creatorRequirements.platforms,
                        request.creatorRequirements.minFollowers,
                        request.creatorRequirements.topCountries,
                        request.creatorRequirements.targetAgeMin,
                        request.creatorRequirements.targetAgeMax,
                        request.creatorRequirements.targetAgeGroups or []
                    )
        
        # Fetch updated listing with details
        updated_data = await _get_listing_with_details_admin(listing_id, hotel_profile_id)
        updated_listing = updated_data["listing"]
        updated_offerings = updated_data["offerings"]
        updated_requirements = updated_data["requirements"]
        
        logger.info(f"Admin {admin_id} updated listing {listing_id} for hotel user {user_id}")
        
        return ListingResponse.model_validate({
            "id": str(updated_listing['id']),
            "hotel_profile_id": str(updated_listing['hotel_profile_id']),
            "name": updated_listing['name'],
            "location": updated_listing['location'],
            "description": updated_listing['description'],
            "accommodation_type": updated_listing['accommodation_type'],
            "images": updated_listing['images'] or [],
            "status": updated_listing['status'],
            "created_at": updated_listing['created_at'],
            "updated_at": updated_listing['updated_at'],
            "collaboration_offerings": updated_offerings,
            "creator_requirements": updated_requirements
        })
        
    except HTTPException:
        raise
    except ValueError as e:
        logger.error(f"Value error updating listing: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        logger.error(f"Error updating listing: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to update listing: {str(e)}"
        )


@router.delete("/users/{user_id}/listings/{listing_id}", status_code=status.HTTP_200_OK)
async def delete_hotel_listing(
    user_id: str,
    listing_id: str,
    admin_id: str = Depends(get_admin_user)
):
    """
    Delete a hotel listing and all associated data (admin endpoint).
    
    This will permanently delete:
    - Listing record
    - All collaboration offerings for this listing
    - All creator requirements for this listing
    - All listing images from S3 (including thumbnails)
    
    **Warning**: This action cannot be undone!
    """
    try:
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
        
        # Verify listing exists and belongs to hotel
        listing = await Database.fetchrow(
            """
            SELECT id, name, images FROM hotel_listings
            WHERE id = $1 AND hotel_profile_id = $2
            """,
            listing_id,
            hotel_profile_id
        )
        
        if not listing:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Listing not found"
            )
        
        # Delete listing images from S3
        deleted_images = 0
        failed_images = 0
        if listing['images']:
            for image_url in listing['images']:
                if image_url:
                    # Extract S3 key from URL
                    s3_key = extract_key_from_url(image_url)
                    if s3_key:
                        # Delete main image
                        if await delete_file_from_s3(s3_key):
                            deleted_images += 1
                        else:
                            failed_images += 1
                        
                        # Delete thumbnail if it exists (thumbnail key is the same but with _thumb before extension)
                        # e.g., listings/user_id/file.jpg -> listings/user_id/file_thumb.jpg
                        if '.' in s3_key:
                            parts = s3_key.rsplit('.', 1)
                            thumbnail_key = f"{parts[0]}_thumb.{parts[1]}"
                            if await delete_file_from_s3(thumbnail_key):
                                deleted_images += 1
                            # Don't count thumbnail failures as critical
        
        # Use transaction to ensure atomicity
        pool = await Database.get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                # Delete collaboration offerings (cascade should handle this, but being explicit)
                await conn.execute(
                    "DELETE FROM listing_collaboration_offerings WHERE listing_id = $1",
                    listing_id
                )
                
                # Delete creator requirements (cascade should handle this, but being explicit)
                await conn.execute(
                    "DELETE FROM listing_creator_requirements WHERE listing_id = $1",
                    listing_id
                )
                
                # Delete the listing itself
                await conn.execute(
                    "DELETE FROM hotel_listings WHERE id = $1",
                    listing_id
                )
        
        logger.info(f"Admin {admin_id} deleted listing {listing_id} for hotel user {user_id} (deleted {deleted_images} images, {failed_images} failed)")
        
        return {
            "message": "Listing deleted successfully",
            "deleted_listing": {
                "id": listing_id,
                "name": listing['name']
            },
            "images_deleted": deleted_images,
            "images_failed": failed_images
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting listing: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to delete listing: {str(e)}"
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


@router.get("/collaborations", response_model=CollaborationListResponse, status_code=status.HTTP_200_OK)
async def get_admin_collaborations(
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int = Query(20, ge=1, le=100, description="Items per page"),
    status: Optional[str] = Query(None, description="Filter by status"),
    search: Optional[str] = Query(None, description="Search by creator name or hotel name"),
    admin_id: str = Depends(get_admin_user)
):
    """
    Get all collaborations for admin monitoring.
    """
    try:
        where_conditions = []
        params = []
        param_counter = 1
        
        if status:
            where_conditions.append(f"c.status = ${param_counter}")
            params.append(status)
            param_counter += 1
            
        if search:
            search_pattern = f"%{search}%"
            where_conditions.append(f"(cr_user.name ILIKE ${param_counter} OR hp.name ILIKE ${param_counter})")
            params.append(search_pattern)
            param_counter += 1
            
        where_clause = " AND ".join(where_conditions) if where_conditions else "1=1"
        
        # Count query
        count_query = f"""
            SELECT COUNT(*) as total
            FROM collaborations c
            JOIN creators cr ON cr.id = c.creator_id
            JOIN users cr_user ON cr_user.id = cr.user_id
            JOIN hotel_profiles hp ON hp.id = c.hotel_id
            WHERE {where_clause}
        """
        # Execute count query (params contains only filters)
        total_result = await Database.fetchrow(count_query, *params)
        total = total_result['total'] if total_result else 0
        
        # Data query
        offset = (page - 1) * page_size
        
        # We need to extend params for LIMIT and OFFSET
        limit_param = param_counter
        offset_param = param_counter + 1
        
        data_query = f"""
            SELECT c.*, 
                   cr_user.name as creator_name, 
                   cr.profile_picture as creator_profile_picture,
                   hp.name as hotel_name, 
                   hl.name as listing_name, 
                   hl.location as listing_location
            FROM collaborations c
            JOIN creators cr ON cr.id = c.creator_id
            JOIN users cr_user ON cr_user.id = cr.user_id
            JOIN hotel_profiles hp ON hp.id = c.hotel_id
            JOIN hotel_listings hl ON hl.id = c.listing_id
            WHERE {where_clause}
            ORDER BY c.created_at DESC
            LIMIT ${limit_param} OFFSET ${offset_param}
        """
        
        # Extend params list with pagination values
        query_params = params + [page_size, offset]
        
        rows = await Database.fetch(data_query, *query_params)
        
        collaborations = []
        for row in rows:
            # Fetch deliverables for each collaboration
            collab_id = str(row['id'])
            deliverables = await get_collaboration_deliverables(collab_id)
            
            collaborations.append(CollaborationResponse(
                id=collab_id,
                initiator_type=row['initiator_type'],
                status=row['status'],
                creator_id=str(row['creator_id']),
                creator_name=row['creator_name'],
                creator_profile_picture=row['creator_profile_picture'],
                hotel_id=str(row['hotel_id']),
                hotel_name=row['hotel_name'],
                listing_id=str(row['listing_id']),
                listing_name=row['listing_name'],
                listing_location=row['listing_location'],
                collaboration_type=row['collaboration_type'],
                free_stay_min_nights=row['free_stay_min_nights'],
                free_stay_max_nights=row['free_stay_max_nights'],
                paid_amount=row['paid_amount'],
                discount_percentage=row['discount_percentage'],
                stay_nights=row['free_stay_min_nights'] if row['free_stay_min_nights'] == row['free_stay_max_nights'] else None,
                travel_date_from=row['travel_date_from'],
                travel_date_to=row['travel_date_to'],
                preferred_date_from=row['preferred_date_from'],
                preferred_date_to=row['preferred_date_to'],
                preferred_months=row['preferred_months'],
                why_great_fit=row['why_great_fit'],
                platform_deliverables=deliverables,
                consent=row['consent'],
                created_at=row['created_at'],
                updated_at=row['updated_at'],
                responded_at=row['responded_at'],
                cancelled_at=row['cancelled_at'],
                completed_at=row['completed_at'],
                hotel_agreed_at=row['hotel_agreed_at'],
                creator_agreed_at=row['creator_agreed_at'],
                term_last_updated_at=row['term_last_updated_at']
            ))
            
        return CollaborationListResponse(collaborations=collaborations, total=total)
        
    except Exception as e:
        logger.error(f"Error fetching admin collaborations: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to fetch collaborations: {str(e)}"
        )
