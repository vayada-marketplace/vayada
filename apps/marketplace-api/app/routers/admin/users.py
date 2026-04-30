"""
Admin user-management endpoints: list/get/create/update/delete users,
plus admin-side updates of creator and hotel profiles.
"""
from fastapi import APIRouter, HTTPException, status as http_status, Depends, Query
from typing import Literal, Optional
from decimal import Decimal
from pydantic import ValidationError
import logging
import json
import bcrypt

from app.database import Database, AuthDatabase
from app.dependencies import get_admin_user
from app.s3_service import delete_all_objects_in_prefix
from app.repositories.user_repo import UserRepository
from app.repositories.creator_repo import CreatorRepository
from app.repositories.hotel_repo import HotelRepository

from app.models.creators import UpdateCreatorProfileRequest, CreatorProfileResponse
from app.models.hotels import (
    UpdateHotelProfileRequest,
    HotelProfileResponse,
    ListingResponse,
)
from app.models.common import (
    CollaborationOfferingResponse,
    CreatorRequirementsResponse,
    PlatformResponse,
)
from app.models.admin import (
    UserResponse,
    UserListResponse,
    CreateCreatorProfileRequest,
    CreateHotelProfileRequest,
    CreateUserRequest,
    UpdateUserRequest,
    CreatorProfileDetail,
    HotelProfileDetail,
    UserDetailResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/users", response_model=UserListResponse, status_code=http_status.HTTP_200_OK)
async def get_users(
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int = Query(20, ge=1, le=100, description="Items per page"),
    type: Optional[Literal["creator", "hotel", "admin"]] = Query(None, description="Filter by user type"),
    status: Optional[Literal["pending", "verified", "rejected", "suspended"]] = Query(None, description="Filter by status"),
    search: Optional[str] = Query(None, description="Search by name or email"),
    admin_id: str = Depends(get_admin_user)
):
    """Get all users with pagination and filtering."""
    try:
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
            params.append(f"%{search}%")
            param_counter += 1

        where_clause = " AND ".join(where_conditions) if where_conditions else "1=1"

        count_query = f"SELECT COUNT(*) as total FROM users WHERE {where_clause}"
        total_result = await AuthDatabase.fetchrow(count_query, *params)
        total = total_result['total'] if total_result else 0

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
            detail="Failed to fetch users"
        )


@router.get("/users/{user_id}", response_model=UserDetailResponse, status_code=http_status.HTTP_200_OK)
async def get_user_details(
    user_id: str,
    admin_id: str = Depends(get_admin_user)
):
    """
    Get complete details for a specific user including profile + listings/platforms.
    """
    try:
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

        if user['type'] == 'creator':
            creator_profile = await CreatorRepository.get_by_user_id(
                user_id,
                columns="id, user_id, location, short_description, portfolio_link, phone, profile_picture, profile_complete, profile_completed_at, created_at, updated_at"
            )

            if creator_profile:
                platforms_data = await CreatorRepository.get_platforms(
                    creator_profile['id'],
                    columns="id, name, handle, followers, engagement_rate, top_countries, top_age_groups, gender_split, created_at, updated_at"
                )

                platforms = []
                for p in platforms_data:
                    def parse_jsonb(value):
                        if value is None:
                            return None
                        if isinstance(value, str):
                            return json.loads(value)
                        return value

                    def convert_top_countries(value):
                        parsed = parse_jsonb(value)
                        if parsed is None:
                            return None
                        if isinstance(parsed, dict):
                            return [{"country": k, "percentage": v} for k, v in parsed.items()]
                        return parsed

                    def convert_top_age_groups(value):
                        parsed = parse_jsonb(value)
                        if parsed is None:
                            return None
                        if isinstance(parsed, dict):
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
            hotel_profile = await HotelRepository.get_profile_by_user_id(
                user_id,
                columns="id, user_id, name, location, picture, website, about, phone, status, created_at, updated_at"
            )

            if hotel_profile:
                listings_data = await HotelRepository.get_listings_by_profile_id(
                    hotel_profile['id'],
                    columns="id, hotel_profile_id, name, location, description, accommodation_type, images, status, created_at, updated_at"
                )

                listings = []
                for l in listings_data:
                    listing_id = str(l['id'])

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
                    email=user['email'],
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
            detail="Failed to fetch user details"
        )


@router.post("/users", response_model=UserResponse, status_code=http_status.HTTP_201_CREATED)
async def create_user(
    request: CreateUserRequest,
    admin_id: str = Depends(get_admin_user)
):
    """Create a new user (creator or hotel) as admin."""
    try:
        if await UserRepository.exists_by_email(request.email):
            raise HTTPException(
                status_code=http_status.HTTP_400_BAD_REQUEST,
                detail="Email already registered"
            )

        password_hash = bcrypt.hashpw(
            request.password.encode('utf-8'),
            bcrypt.gensalt()
        ).decode('utf-8')

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
            if request.type == "creator":
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

                if profile_data.platforms:
                    for platform in profile_data.platforms:
                        top_countries_data = (
                            json.dumps(platform.topCountries) if platform.topCountries else None
                        )
                        top_age_groups_data = (
                            json.dumps(platform.topAgeGroups) if platform.topAgeGroups else None
                        )
                        gender_split_data = (
                            json.dumps(platform.genderSplit) if platform.genderSplit else None
                        )

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

                if profile_data.listings:
                    pool = await Database.get_pool()
                    async with pool.acquire() as conn:
                        async with conn.transaction():
                            for listing_request in profile_data.listings:
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
            detail="Failed to create user"
        )


@router.put("/users/{user_id}/profile/creator", response_model=CreatorProfileResponse, status_code=http_status.HTTP_200_OK)
async def update_creator_profile(
    user_id: str,
    request: UpdateCreatorProfileRequest,
    admin_id: str = Depends(get_admin_user)
):
    """Update a creator's profile (admin endpoint)."""
    try:
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

        creator = await CreatorRepository.get_by_user_id(
            user_id, columns="id, profile_complete"
        )

        if not creator:
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND,
                detail="Creator profile not found"
            )

        creator_id = creator['id']

        if request.name is not None:
            await UserRepository.update_name(user_id, request.name)

        pool = await Database.get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
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

                if update_fields:
                    update_fields.append("updated_at = now()")
                    update_values.append(creator_id)

                    update_query = f"""
                        UPDATE creators
                        SET {', '.join(update_fields)}
                        WHERE id = ${param_counter}
                    """
                    await conn.execute(update_query, *update_values)

                if request.platforms is not None:
                    await conn.execute(
                        "DELETE FROM creator_platforms WHERE creator_id = $1",
                        creator_id
                    )

                    for platform in request.platforms:
                        top_countries_data = None
                        if platform.topCountries:
                            top_countries_data = json.dumps(
                                [tc if isinstance(tc, dict) else tc.model_dump() for tc in platform.topCountries]
                            )

                        top_age_groups_data = None
                        if platform.topAgeGroups:
                            top_age_groups_data = json.dumps(
                                [tag if isinstance(tag, dict) else tag.model_dump() for tag in platform.topAgeGroups]
                            )

                        gender_split_data = None
                        if platform.genderSplit:
                            gender_split_data = json.dumps(
                                platform.genderSplit if isinstance(platform.genderSplit, dict) else platform.genderSplit.model_dump()
                            )

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

        creator_data = await CreatorRepository.get_by_id(
            creator_id,
            columns="id, location, short_description, portfolio_link, phone, profile_picture, creator_type, created_at, updated_at, profile_complete, user_id"
        )

        user_data = await UserRepository.get_by_id(
            creator_data['user_id'], columns="name, status"
        )

        platforms_data = await CreatorRepository.get_platforms(
            creator_id,
            columns="id, name, handle, followers, engagement_rate, top_countries, top_age_groups, gender_split, created_at, updated_at"
        )

        platforms = []
        for p in platforms_data:
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
            detail="Failed to update creator profile"
        )


@router.put("/users/{user_id}/profile/hotel", response_model=HotelProfileResponse, status_code=http_status.HTTP_200_OK)
async def update_hotel_profile(
    user_id: str,
    request: UpdateHotelProfileRequest,
    admin_id: str = Depends(get_admin_user)
):
    """Update a hotel's profile (admin endpoint)."""
    try:
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

        hotel = await HotelRepository.get_profile_by_user_id(
            user_id, columns="id, profile_complete"
        )

        if not hotel:
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND,
                detail="Hotel profile not found"
            )

        hotel_id = hotel['id']

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

        if update_fields:
            await HotelRepository.update_profile(hotel_id, update_fields, update_values)

        if request.email is not None:
            await UserRepository.update_email(user_id, request.email)

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
            detail="Failed to update hotel profile"
        )


@router.put("/users/{user_id}", response_model=UserResponse, status_code=http_status.HTTP_200_OK)
async def update_user(
    user_id: str,
    request: UpdateUserRequest,
    admin_id: str = Depends(get_admin_user)
):
    """Update user fields (admin endpoint). Partial updates supported."""
    try:
        if user_id == admin_id:
            if request.status is not None or request.emailVerified is not None:
                raise HTTPException(
                    status_code=http_status.HTTP_400_BAD_REQUEST,
                    detail="Cannot modify your own status or email verification status"
                )

        user = await UserRepository.get_by_id(
            user_id, columns="id, email, name, type, status, email_verified, avatar"
        )

        if not user:
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND,
                detail="User not found"
            )

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

        if update_fields:
            update_fields.append("updated_at = now()")
            update_values.append(user_id)

            update_query = f"""
                UPDATE users
                SET {', '.join(update_fields)}
                WHERE id = ${param_counter}
            """
            await AuthDatabase.execute(update_query, *update_values)

        # Cascade verification to the hotel profile and its listings. User
        # verification is the only approval gate for the marketplace, so these
        # rows should mirror that state instead of staying stuck on 'pending'.
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
            detail="Failed to update user"
        )


async def delete_user_images(user_id: str, user_type: str) -> dict:
    """Delete all images associated with a user from S3 by deleting their folder."""
    if user_type == 'creator':
        prefix = f"creators/{user_id}/"
    elif user_type == 'hotel':
        prefix = f"listings/{user_id}/"
    else:
        logger.warning(f"Unknown user type {user_type}, skipping image deletion")
        return {"deleted_count": 0, "failed_count": 0, "total_objects": 0}

    stats = await delete_all_objects_in_prefix(prefix)
    logger.info(
        f"Deleted images from S3 folder {prefix} for user {user_id}: "
        f"{stats['deleted_count']} deleted, {stats['failed_count']} failed, "
        f"{stats['total_objects']} total"
    )
    return stats


@router.delete("/users/{user_id}", status_code=http_status.HTTP_200_OK)
async def delete_user(
    user_id: str,
    admin_id: str = Depends(get_admin_user)
):
    """Delete a user and all associated data (admin endpoint)."""
    try:
        if user_id == admin_id:
            raise HTTPException(
                status_code=http_status.HTTP_400_BAD_REQUEST,
                detail="Cannot delete your own account"
            )

        user = await UserRepository.get_by_id(
            user_id, columns="id, email, name, type, status"
        )

        if not user:
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND,
                detail="User not found"
            )

        await delete_user_images(user_id, user['type'])

        # Cross-DB cascade: marketplace business data, then auth.
        if user['type'] == 'creator':
            creator = await CreatorRepository.get_by_user_id(user_id, columns="id")
            if creator:
                await CreatorRepository.delete_platforms(creator['id'])
                await Database.execute("DELETE FROM creators WHERE id = $1", creator['id'])
        elif user['type'] == 'hotel':
            hotel = await HotelRepository.get_profile_by_user_id(user_id, columns="id")
            if hotel:
                listings = await HotelRepository.get_listings_by_profile_id(hotel['id'], columns="id")
                for listing in listings:
                    await HotelRepository.delete_offerings(listing['id'])
                    await HotelRepository.delete_requirements(listing['id'])
                await Database.execute("DELETE FROM hotel_listings WHERE hotel_profile_id = $1", hotel['id'])
                await Database.execute("DELETE FROM hotel_profiles WHERE id = $1", hotel['id'])

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
            detail="Failed to delete user"
        )
