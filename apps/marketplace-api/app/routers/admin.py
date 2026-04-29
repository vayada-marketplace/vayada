"""
Admin routes for user management
"""
from fastapi import APIRouter, HTTPException, status as http_status, Depends, Query
from typing import List, Literal, Optional, Union
from datetime import datetime
from decimal import Decimal
from pydantic import ValidationError
import logging
import json
import bcrypt

from app.database import Database, AuthDatabase
from app.dependencies import get_current_user_id, get_admin_user
from app.routers.collaborations import get_collaboration_deliverables
from app.services.affiliate import AffiliateProvisioningService
from app.services.chat_system import create_system_message
from app.services.listings import ListingService, build_listing_response
from app.services.notifications import (
    get_party_email_and_name,
    send_email_background,
    notify_vayada_team,
)
from app.email_service import (
    create_collaboration_response_email_html,
    create_collaboration_approved_email_html,
)
from app.s3_service import delete_all_objects_in_prefix, delete_file_from_s3, extract_key_from_url
from app.repositories.user_repo import UserRepository
from app.repositories.creator_repo import CreatorRepository
from app.repositories.hotel_repo import HotelRepository
from app.repositories.collaboration_repo import CollaborationRepository

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
from app.models.collaborations import (
    CollaborationResponse,
    RespondToCollaborationRequest,
)
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


@router.get("/users", response_model=UserListResponse, status_code=http_status.HTTP_200_OK)
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
            # Use the same placeholder for both name and email comparisons
            where_conditions.append(f"(name ILIKE ${param_counter} OR email ILIKE ${param_counter})")
            search_pattern = f"%{search}%"
            params.append(search_pattern)
            param_counter += 1
        
        where_clause = " AND ".join(where_conditions) if where_conditions else "1=1"
        
        # Get total count
        count_query = f"SELECT COUNT(*) as total FROM users WHERE {where_clause}"
        total_result = await AuthDatabase.fetchrow(count_query, *params)
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
        
        users_data = await AuthDatabase.fetch(users_query, *params)
        
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
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to fetch users: {str(e)}"
        )


@router.get("/users/{user_id}", response_model=UserDetailResponse, status_code=http_status.HTTP_200_OK)
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
        user = await UserRepository.get_by_id(
            user_id,
            columns="id, email, name, type, status, email_verified, avatar, created_at, updated_at"
        )

        if not user:
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND,
                detail="User not found"
            )

        profile = None

        # Get profile based on user type
        if user['type'] == 'creator':
            # Get creator profile
            creator_profile = await CreatorRepository.get_by_user_id(
                user_id,
                columns="id, user_id, location, short_description, portfolio_link, phone, profile_picture, profile_complete, profile_completed_at, created_at, updated_at"
            )

            if creator_profile:
                # Get platforms
                platforms_data = await CreatorRepository.get_platforms(
                    creator_profile['id'],
                    columns="id, name, handle, followers, engagement_rate, top_countries, top_age_groups, gender_split, created_at, updated_at"
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
            hotel_profile = await HotelRepository.get_profile_by_user_id(
                user_id,
                columns="id, user_id, name, location, picture, website, about, phone, status, created_at, updated_at"
            )

            if hotel_profile:
                # Get listings
                listings_data = await HotelRepository.get_listings_by_profile_id(
                    hotel_profile['id'],
                    columns="id, hotel_profile_id, name, location, description, accommodation_type, images, status, created_at, updated_at"
                )
                
                listings = []
                for l in listings_data:
                    listing_id = str(l['id'])
                    
                    # Get collaboration offerings for this listing
                    offerings_data = await HotelRepository.get_offerings(l['id'])
                    
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
                            currency=o.get('currency'),
                            discount_percentage=o['discount_percentage'],
                            commission_percentage=o.get('commission_percentage'),
                            created_at=o['created_at'],
                            updated_at=o['updated_at']
                        )
                        for o in offerings_data
                    ]
                    
                    # Get creator requirements for this listing
                    requirements_data = await HotelRepository.get_requirements(l['id'])
                    
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
                    status=user['status'],
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
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to fetch user details: {str(e)}"
        )


@router.post("/users", response_model=UserResponse, status_code=http_status.HTTP_201_CREATED)
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
        if await UserRepository.exists_by_email(request.email):
            raise HTTPException(
                status_code=http_status.HTTP_400_BAD_REQUEST,
                detail="Email already registered"
            )
        
        # Hash password
        password_hash = bcrypt.hashpw(
            request.password.encode('utf-8'),
            bcrypt.gensalt()
        ).decode('utf-8')
        
        # Insert user into auth database
        user = await AuthDatabase.fetchrow(
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

        try:
            # Create profile based on user type (on business Database)
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

                        await CreatorRepository.insert_platform(
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
                                         free_stay_min_nights, free_stay_max_nights, paid_max_amount, discount_percentage, currency,
                                         commission_percentage)
                                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, 'USD'), $10)
                                        """,
                                        listing_id,
                                        offering.collaborationType,
                                        offering.availabilityMonths,
                                        offering.platforms,
                                        offering.freeStayMinNights,
                                        offering.freeStayMaxNights,
                                        offering.paidMaxAmount,
                                        offering.discountPercentage,
                                        offering.currency,
                                        offering.commissionPercentage
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
                                    listing_request.creatorRequirements.targetAgeGroups or []
                                )
        except Exception:
            # Compensating action: delete user from auth DB if profile creation fails
            await UserRepository.delete(user_id)
            raise
        
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
            status_code=http_status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=e.errors()
        )
    except ValueError as e:
        logger.error(f"Value error creating user: {str(e)}")
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        logger.error(f"Error creating user: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to create user: {str(e)}"
        )


@router.put("/users/{user_id}/profile/creator", response_model=CreatorProfileResponse, status_code=http_status.HTTP_200_OK)
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
        user = await UserRepository.get_by_id(user_id, columns="id, type, name")

        if not user:
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND,
                detail="User not found"
            )

        if user['type'] != 'creator':
            raise HTTPException(
                status_code=http_status.HTTP_400_BAD_REQUEST,
                detail="User is not a creator"
            )

        # Get creator profile
        creator = await CreatorRepository.get_by_user_id(
            user_id, columns="id, profile_complete"
        )

        if not creator:
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND,
                detail="Creator profile not found"
            )
        
        creator_id = creator['id']
        
        # Update user name on auth database if provided
        if request.name is not None:
            await UserRepository.update_name(user_id, request.name)

        # Start transaction - update creator profile and platforms
        pool = await Database.get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
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

                if request.creatorType is not None:
                    update_fields.append(f"creator_type = ${param_counter}")
                    update_values.append(request.creatorType)
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
        
        # Fetch updated profile with platforms (split across databases)
        creator_data = await CreatorRepository.get_by_id(
            creator_id,
            columns="id, location, short_description, portfolio_link, phone, profile_picture, creator_type, created_at, updated_at, profile_complete, user_id"
        )

        user_data = await UserRepository.get_by_id(
            creator_data['user_id'], columns="name, status"
        )

        # Get platforms
        platforms_data = await CreatorRepository.get_platforms(
            creator_id,
            columns="id, name, handle, followers, engagement_rate, top_countries, top_age_groups, gender_split, created_at, updated_at"
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
            name=request.name if request.name is not None else user_data['name'],
            location=creator_data['location'] or "",
            shortDescription=creator_data['short_description'] or "",
            portfolioLink=creator_data['portfolio_link'],
            phone=creator_data['phone'],
            profilePicture=creator_data['profile_picture'],
            creatorType=creator_data['creator_type'] or 'Lifestyle',
            platforms=platforms,
            audienceSize=audience_size,
            status=user_data['status'],
            createdAt=creator_data['created_at'],
            updatedAt=creator_data['updated_at']
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating creator profile: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to update creator profile: {str(e)}"
        )


@router.put("/users/{user_id}/profile/hotel", response_model=HotelProfileResponse, status_code=http_status.HTTP_200_OK)
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
        user = await UserRepository.get_by_id(user_id, columns="id, type, name")

        if not user:
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND,
                detail="User not found"
            )

        if user['type'] != 'hotel':
            raise HTTPException(
                status_code=http_status.HTTP_400_BAD_REQUEST,
                detail="User is not a hotel"
            )

        # Get hotel profile
        hotel = await HotelRepository.get_profile_by_user_id(
            user_id, columns="id, profile_complete"
        )

        if not hotel:
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND,
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
            await HotelRepository.update_profile(hotel_id, update_fields, update_values)

        # Update email in users table if provided (auth database)
        if request.email is not None:
            await UserRepository.update_email(user_id, request.email)
        
        # Fetch updated profile (split across databases)
        updated_hotel = await HotelRepository.get_profile_by_id(
            hotel_id,
            columns="id, user_id, name, location, about, website, phone, picture, status, created_at, updated_at, profile_complete"
        )

        updated_user = await UserRepository.get_by_id(
            updated_hotel['user_id'], columns="email, name as user_name"
        )

        logger.info(f"Admin {admin_id} updated hotel profile for user {user_id}")

        return HotelProfileResponse(
            id=str(updated_hotel['id']),
            user_id=str(updated_hotel['user_id']),
            name=updated_hotel['name'],
            location=updated_hotel['location'] or "",
            email=updated_user['email'],
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
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to update hotel profile: {str(e)}"
        )


@router.put("/users/{user_id}", response_model=UserResponse, status_code=http_status.HTTP_200_OK)
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
                    status_code=http_status.HTTP_400_BAD_REQUEST,
                    detail="Cannot modify your own status or email verification status"
                )
        
        # Verify user exists
        user = await UserRepository.get_by_id(
            user_id, columns="id, email, name, type, status, email_verified, avatar"
        )

        if not user:
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND,
                detail="User not found"
            )
        
        # Check if email is being changed and if it's already taken
        if request.email is not None and request.email != user['email']:
            existing_user = await AuthDatabase.fetchrow(
                "SELECT id FROM users WHERE email = $1 AND id != $2",
                request.email,
                user_id
            )
            
            if existing_user:
                raise HTTPException(
                    status_code=http_status.HTTP_400_BAD_REQUEST,
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
            await AuthDatabase.execute(update_query, *update_values)

        # Cascade verification to the hotel profile and its listings. User
        # verification is the only approval gate for the marketplace, so these
        # rows should mirror that state instead of staying stuck on the
        # 'pending' default.
        if request.status == 'verified' and user['type'] == 'hotel':
            await Database.execute(
                """
                UPDATE hotel_profiles
                SET status = 'verified', updated_at = now()
                WHERE user_id = $1 AND status != 'verified'
                """,
                user_id,
            )
            await Database.execute(
                """
                UPDATE hotel_listings
                SET status = 'verified', updated_at = now()
                WHERE hotel_profile_id IN (
                    SELECT id FROM hotel_profiles WHERE user_id = $1
                ) AND status != 'verified'
                """,
                user_id,
            )

        # Fetch updated user
        updated_user = await UserRepository.get_by_id(
            user_id,
            columns="id, email, name, type, status, email_verified, avatar, created_at, updated_at"
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
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
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


async def _resolve_admin_hotel_profile_id(user_id: str) -> str:
    """Look up a hotel user's profile id, raising matching 4xx errors for the admin endpoints."""
    user = await UserRepository.get_by_id(user_id, columns="id, type")
    if not user:
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND,
            detail="User not found"
        )
    if user['type'] != 'hotel':
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="User is not a hotel"
        )
    hotel_profile = await HotelRepository.get_profile_by_user_id(user_id, columns="id")
    if not hotel_profile:
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND,
            detail="Hotel profile not found"
        )
    return str(hotel_profile['id'])


@router.post("/users/{user_id}/listings", response_model=ListingResponse, status_code=http_status.HTTP_201_CREATED)
async def create_hotel_listing(
    user_id: str,
    request: CreateListingRequest,
    admin_id: str = Depends(get_admin_user)
):
    """
    Create a listing for an existing hotel user (admin endpoint).
    """
    try:
        logger.info(f"Admin {admin_id} creating listing for hotel user {user_id}")
        hotel_profile_id = await _resolve_admin_hotel_profile_id(user_id)
        data = await ListingService.create(hotel_profile_id, request)
        logger.info(f"Admin {admin_id} created listing for hotel user {user_id}")
        return build_listing_response(data, hotel_profile_id=hotel_profile_id)

    except HTTPException:
        raise
    except ValueError as e:
        logger.error(f"Value error creating listing: {str(e)}")
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        logger.error(f"Error creating listing: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to create listing: {str(e)}"
        )


@router.put("/users/{user_id}/listings/{listing_id}", response_model=ListingResponse, status_code=http_status.HTTP_200_OK)
async def update_hotel_listing(
    user_id: str,
    listing_id: str,
    request: UpdateListingRequest,
    admin_id: str = Depends(get_admin_user)
):
    """
    Update a hotel listing (admin endpoint). Partial updates supported.
    If collaborationOfferings or creatorRequirements are provided, existing
    rows are replaced.
    """
    try:
        hotel_profile_id = await _resolve_admin_hotel_profile_id(user_id)

        existing = await ListingService.get_with_details(listing_id, hotel_profile_id)
        if existing is None:
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND,
                detail="Listing not found"
            )

        await ListingService.update(listing_id, request)

        updated = await ListingService.get_with_details(listing_id, hotel_profile_id)
        logger.info(f"Admin {admin_id} updated listing {listing_id} for hotel user {user_id}")
        return build_listing_response(updated, hotel_profile_id=hotel_profile_id)

    except HTTPException:
        raise
    except ValueError as e:
        logger.error(f"Value error updating listing: {str(e)}")
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        logger.error(f"Error updating listing: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to update listing: {str(e)}"
        )


@router.delete("/users/{user_id}/listings/{listing_id}", status_code=http_status.HTTP_200_OK)
async def delete_hotel_listing(
    user_id: str,
    listing_id: str,
    admin_id: str = Depends(get_admin_user)
):
    """
    Delete a hotel listing and all associated data (admin endpoint).

    Permanently deletes the listing row, its offerings/requirements, and
    all listing images from S3 (including thumbnails).
    """
    try:
        hotel_profile_id = await _resolve_admin_hotel_profile_id(user_id)

        listing = await HotelRepository.get_listing(
            listing_id, hotel_profile_id, columns="id, name, images"
        )
        if not listing:
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND,
                detail="Listing not found"
            )

        deleted_images = 0
        failed_images = 0
        if listing['images']:
            for image_url in listing['images']:
                if image_url:
                    s3_key = extract_key_from_url(image_url)
                    if s3_key:
                        if await delete_file_from_s3(s3_key):
                            deleted_images += 1
                        else:
                            failed_images += 1
                        # Thumbnail key: foo.jpg -> foo_thumb.jpg
                        if '.' in s3_key:
                            parts = s3_key.rsplit('.', 1)
                            thumbnail_key = f"{parts[0]}_thumb.{parts[1]}"
                            if await delete_file_from_s3(thumbnail_key):
                                deleted_images += 1

        await ListingService.delete(listing_id)

        logger.info(
            f"Admin {admin_id} deleted listing {listing_id} for hotel user {user_id} "
            f"(deleted {deleted_images} images, {failed_images} failed)"
        )
        return {
            "message": "Listing deleted successfully",
            "deleted_listing": {
                "id": listing_id,
                "name": listing['name'],
            },
            "images_deleted": deleted_images,
            "images_failed": failed_images,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting listing: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to delete listing: {str(e)}"
        )


@router.delete("/users/{user_id}", status_code=http_status.HTTP_200_OK)
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
                status_code=http_status.HTTP_400_BAD_REQUEST,
                detail="Cannot delete your own account"
            )
        
        # Verify user exists and get user info
        user = await UserRepository.get_by_id(
            user_id, columns="id, email, name, type, status"
        )

        if not user:
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND,
                detail="User not found"
            )

        # Delete all images associated with this user from S3
        image_deletion_stats = await delete_user_images(user_id, user['type'])

        # Delete business data first (different DB, no cross-DB cascade)
        if user['type'] == 'creator':
            creator = await CreatorRepository.get_by_user_id(user_id, columns="id")
            if creator:
                await CreatorRepository.delete_platforms(creator['id'])
                await Database.execute("DELETE FROM creators WHERE id = $1", creator['id'])
        elif user['type'] == 'hotel':
            hotel = await HotelRepository.get_profile_by_user_id(user_id, columns="id")
            if hotel:
                # Delete listings and their children
                listings = await HotelRepository.get_listings_by_profile_id(hotel['id'], columns="id")
                for listing in listings:
                    await HotelRepository.delete_offerings(listing['id'])
                    await HotelRepository.delete_requirements(listing['id'])
                await Database.execute("DELETE FROM hotel_listings WHERE hotel_profile_id = $1", hotel['id'])
                await Database.execute("DELETE FROM hotel_profiles WHERE id = $1", hotel['id'])

        # Delete user from auth DB
        await UserRepository.delete(user_id)
        
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
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to delete user: {str(e)}"
        )


@router.get("/collaborations", response_model=CollaborationListResponse, status_code=http_status.HTTP_200_OK)
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
        # If searching, find matching user IDs from AuthDatabase
        search_user_ids = None
        if search:
            search_users = await AuthDatabase.fetch(
                "SELECT id FROM users WHERE name ILIKE $1",
                f"%{search}%"
            )
            search_user_ids = [r['id'] for r in search_users]

        # Build WHERE clause for business data
        where_conditions = []
        params = []
        param_counter = 1

        if status:
            where_conditions.append(f"c.status = ${param_counter}")
            params.append(status)
            param_counter += 1

        if search:
            # Search by hotel name OR by user name (pre-fetched IDs)
            if search_user_ids:
                where_conditions.append(f"(hp.name ILIKE ${param_counter} OR cr.user_id = ANY(${param_counter + 1}::uuid[]))")
                params.append(f"%{search}%")
                params.append(search_user_ids)
                param_counter += 2
            else:
                where_conditions.append(f"hp.name ILIKE ${param_counter}")
                params.append(f"%{search}%")
                param_counter += 1

        where_clause = " AND ".join(where_conditions) if where_conditions else "1=1"

        # Count query (no JOIN users)
        count_query = f"""
            SELECT COUNT(*) as total
            FROM collaborations c
            JOIN creators cr ON cr.id = c.creator_id
            JOIN hotel_profiles hp ON hp.id = c.hotel_id
            WHERE {where_clause}
        """
        total_result = await Database.fetchrow(count_query, *params)
        total = total_result['total'] if total_result else 0

        # Data query (no JOIN users, add cr.user_id)
        offset = (page - 1) * page_size
        limit_param = param_counter
        offset_param = param_counter + 1

        data_query = f"""
            SELECT c.*,
                   cr.profile_picture as creator_profile_picture,
                   cr.user_id as creator_user_id,
                   hp.name as hotel_name,
                   hl.name as listing_name,
                   hl.location as listing_location
            FROM collaborations c
            JOIN creators cr ON cr.id = c.creator_id
            JOIN hotel_profiles hp ON hp.id = c.hotel_id
            JOIN hotel_listings hl ON hl.id = c.listing_id
            WHERE {where_clause}
            ORDER BY c.created_at DESC
            LIMIT ${limit_param} OFFSET ${offset_param}
        """

        query_params = params + [page_size, offset]
        rows = await Database.fetch(data_query, *query_params)

        # Batch-fetch user names from AuthDatabase
        if rows:
            creator_user_ids = list(set(row['creator_user_id'] for row in rows))
            user_rows = await AuthDatabase.fetch(
                "SELECT id, name FROM users WHERE id = ANY($1::uuid[])",
                creator_user_ids
            )
            users_map = {str(u['id']): u['name'] for u in user_rows}
        else:
            users_map = {}

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
                creator_name=users_map.get(str(row['creator_user_id']), 'Unknown'),
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
                currency=row['currency'],
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
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to fetch collaborations: {str(e)}"
        )


async def _build_admin_collaboration_response(collaboration_id: str) -> CollaborationResponse:
    """Re-fetch and build the standard collaboration response payload."""
    updated = await CollaborationRepository.get_full(collaboration_id)
    creator_user = await UserRepository.get_by_id(updated['creator_user_id'], columns="name")
    creator_name = creator_user['name'] if creator_user else 'Unknown'
    plat_delivs_resp = await get_collaboration_deliverables(collaboration_id)

    return CollaborationResponse(
        id=str(updated['id']),
        initiator_type=updated['initiator_type'],
        status=updated['status'],
        creator_id=str(updated['creator_id']),
        creator_name=creator_name,
        creator_profile_picture=updated['creator_profile_picture'],
        hotel_id=str(updated['hotel_id']),
        hotel_name=updated['hotel_name'],
        listing_id=str(updated['listing_id']),
        listing_name=updated['listing_name'],
        listing_location=updated['listing_location'],
        collaboration_type=updated['collaboration_type'],
        free_stay_min_nights=updated['free_stay_min_nights'],
        free_stay_max_nights=updated['free_stay_max_nights'],
        paid_amount=updated['paid_amount'],
        currency=updated.get('currency'),
        discount_percentage=updated['discount_percentage'],
        stay_nights=updated['free_stay_min_nights'] if updated['free_stay_min_nights'] == updated['free_stay_max_nights'] else None,
        travel_date_from=updated['travel_date_from'],
        travel_date_to=updated['travel_date_to'],
        preferred_date_from=updated['preferred_date_from'],
        preferred_date_to=updated['preferred_date_to'],
        preferred_months=updated['preferred_months'],
        why_great_fit=updated['why_great_fit'],
        platform_deliverables=plat_delivs_resp,
        consent=updated['consent'],
        created_at=updated['created_at'],
        updated_at=updated['updated_at'],
        responded_at=updated['responded_at'],
        cancelled_at=updated['cancelled_at'],
        completed_at=updated['completed_at'],
        hotel_agreed_at=updated['hotel_agreed_at'],
        creator_agreed_at=updated['creator_agreed_at'],
        term_last_updated_at=updated['term_last_updated_at'],
        creator_fee=updated.get('creator_fee'),
        affiliate_referral_code=updated.get('affiliate_referral_code'),
        affiliate_link=updated.get('affiliate_link'),
    )


@router.post("/collaborations/{collaboration_id}/respond", response_model=CollaborationResponse)
async def admin_respond_to_collaboration(
    collaboration_id: str,
    request: RespondToCollaborationRequest,
    admin_id: str = Depends(get_admin_user)
):
    """
    Admin accepts or declines a pending collaboration on behalf of the hotel.

    Only valid for creator-initiated, pending collaborations.
    Accept moves status to 'negotiating' and sets hotel_agreed_at.
    Decline moves status to 'declined'.
    """
    collab = await CollaborationRepository.get_by_id(collaboration_id)
    if not collab:
        raise HTTPException(status_code=404, detail="Collaboration not found")

    if collab['status'] != 'pending':
        raise HTTPException(
            status_code=400,
            detail=f"Cannot respond to collaboration with status '{collab['status']}'. Only 'pending' requests can be accepted/declined."
        )

    if collab['initiator_type'] != 'creator':
        raise HTTPException(
            status_code=400,
            detail="Admin can only respond on behalf of the hotel for creator-initiated requests."
        )

    new_status = "negotiating" if request.status == "accepted" else "declined"

    updates = ["status = $1", "responded_at = NOW()", "updated_at = NOW()"]
    params = [new_status, collaboration_id]
    if request.status == "accepted":
        updates.append("hotel_agreed_at = NOW()")

    query = f"UPDATE collaborations SET {', '.join(updates)} WHERE id = ${len(params)}"

    pool = await Database.get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(query, *params)

            if request.status == "accepted":
                msg = "✅ Vayada admin (on behalf of Hotel) is ready to discuss the collaboration terms."
                if request.response_message:
                    msg += f"\n\nMessage: {request.response_message}"
                await create_system_message(collaboration_id, msg, conn=conn)
                await create_system_message(collaboration_id, "💬 Chat is now open! Discuss and finalize the terms.", conn=conn)
            else:
                msg = "❌ Vayada admin (on behalf of Hotel) has declined the collaboration request."
                if request.response_message:
                    msg += f"\n\nMessage: {request.response_message}"
                await create_system_message(collaboration_id, msg, conn=conn)

    response = await _build_admin_collaboration_response(collaboration_id)

    # Notify the creator (initiator) that the hotel responded.
    creator_email, creator_email_name = await get_party_email_and_name(
        "creator", creator_id=str(collab['creator_id'])
    )
    if creator_email:
        accepted = request.status == "accepted"
        html = create_collaboration_response_email_html(
            recipient_name=creator_email_name or "there",
            responder_name=response.hotel_name,
            accepted=accepted,
            collaboration_type=collab['collaboration_type'],
            listing_name=response.listing_name,
            listing_location=response.listing_location,
            response_message=request.response_message,
        )
        subject = "Collaboration Request Accepted" if accepted else "Collaboration Request Declined"
        send_email_background(creator_email, subject, html)
        notify_vayada_team(subject, html)

    return response


@router.post("/collaborations/{collaboration_id}/approve", response_model=CollaborationResponse)
async def admin_approve_collaboration(
    collaboration_id: str,
    admin_id: str = Depends(get_admin_user)
):
    """
    Admin approves the current terms on behalf of the hotel.

    Sets hotel_agreed_at = NOW(). If the creator has already agreed, the
    collaboration flips to 'accepted' and the affiliate record is provisioned.
    """
    collab = await CollaborationRepository.get_by_id(collaboration_id)
    if not collab:
        raise HTTPException(status_code=404, detail="Collaboration not found")

    if collab['status'] not in ('pending', 'negotiating'):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot approve collaboration with status '{collab['status']}'."
        )

    other_agreed = collab['creator_agreed_at'] is not None
    updates = ["hotel_agreed_at = NOW()", "updated_at = NOW()"]
    new_status = None
    if other_agreed:
        updates.append("status = 'accepted'")
        updates.append("responded_at = NOW()")
        new_status = 'accepted'
    elif collab['status'] == 'pending':
        # Approving from pending without responding first — treat like an accept
        # so the conversation can move forward.
        updates.append("status = 'negotiating'")

    query = f"UPDATE collaborations SET {', '.join(updates)} WHERE id = $1"
    pool = await Database.get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(query, collaboration_id)
            await create_system_message(
                collaboration_id,
                "✅ Vayada admin (on behalf of Hotel) approved the terms.",
                conn=conn,
            )
            if new_status == 'accepted':
                await create_system_message(collaboration_id, "🎉 Collaboration Accepted!", conn=conn)

    creator_email, creator_email_name = await get_party_email_and_name(
        "creator", creator_id=str(collab['creator_id'])
    )
    hotel_email, hotel_email_name = await get_party_email_and_name(
        "hotel", hotel_id=str(collab['hotel_id'])
    )

    if new_status == 'accepted':
        affiliate_link = await AffiliateProvisioningService.provision_for_accepted_collab(
            collaboration_id,
            creator_id=str(collab['creator_id']),
            hotel_id=str(collab['hotel_id']),
            creator_email=creator_email,
            creator_name=creator_email_name,
            commission=collab.get('creator_fee'),
        )

        for email, name in [(creator_email, creator_email_name), (hotel_email, hotel_email_name)]:
            if email:
                link_for_email = affiliate_link if email == creator_email else None
                html = create_collaboration_approved_email_html(
                    recipient_name=name or "there",
                    other_party_name="Hotel",
                    collaboration_type=collab['collaboration_type'],
                    listing_name=(await CollaborationRepository.get_full(collaboration_id))['listing_name'],
                    listing_location=None,
                    both_approved=True,
                    affiliate_link=link_for_email,
                )
                send_email_background(email, "Collaboration Confirmed!", html)
        notify_vayada_team("Collaboration Confirmed!", html)
    else:
        if creator_email:
            updated_full = await CollaborationRepository.get_full(collaboration_id)
            html = create_collaboration_approved_email_html(
                recipient_name=creator_email_name or "there",
                other_party_name=updated_full['hotel_name'],
                collaboration_type=collab['collaboration_type'],
                listing_name=updated_full['listing_name'],
                listing_location=updated_full.get('listing_location'),
                both_approved=False,
            )
            send_email_background(creator_email, "Terms Approved — Your Confirmation Needed", html)

    return await _build_admin_collaboration_response(collaboration_id)
