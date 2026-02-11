"""
Creator profile routes
"""
from fastapi import APIRouter, HTTPException, status as http_status, Depends, Query
from typing import List, Literal, Optional
from datetime import datetime
from decimal import Decimal
import json
import logging

from app.database import Database
from app.repositories.user_repo import UserRepository
from app.repositories.creator_repo import CreatorRepository
from app.repositories.hotel_repo import HotelRepository
from app.repositories.collaboration_repo import CollaborationRepository
from app.dependencies import get_current_user_id, get_current_user_id_allow_pending, get_current_creator_id
from app.email_service import send_email, create_profile_completion_email_html
from app.auth import create_email_verification_token
from app.config import settings
from app.s3_service import delete_file_from_s3, extract_key_from_url
from app.models.common import PlatformResponse, CreatorRequirementsResponse
from app.models.creators import (
    CreatorProfileStatusResponse,
    PlatformRequest,
    UpdateCreatorProfileRequest,
    ReviewResponse,
    RatingResponse,
    CreatorProfileFullResponse,
    CreatorProfileResponse,
    CreatorCollaborationListResponse,
    CreatorCollaborationDetailResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/creators", tags=["creators"])


@router.get("/me/profile-status", response_model=CreatorProfileStatusResponse)
async def get_creator_profile_status(user_id: str = Depends(get_current_user_id_allow_pending)):
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
        user = await UserRepository.get_by_id(user_id, columns="id, type, name")

        if not user:
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND,
                detail="User not found"
            )

        if user['type'] != 'creator':
            raise HTTPException(
                status_code=http_status.HTTP_403_FORBIDDEN,
                detail="This endpoint is only available for creators"
            )

        # Get creator profile
        creator = await CreatorRepository.get_by_user_id(
            user_id, columns="id, location, short_description, portfolio_link, phone"
        )

        if not creator:
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND,
                detail="Creator profile not found"
            )

        # Check for platforms
        platforms = await CreatorRepository.get_platforms(
            creator['id'], columns="id, name, handle, followers, engagement_rate"
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
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get profile status: {str(e)}"
        )


@router.get("/me", response_model=CreatorProfileFullResponse)
async def get_creator_profile(user_id: str = Depends(get_current_user_id_allow_pending)):
    """
    Get the complete profile data for the currently authenticated creator user.
    """
    try:
        # Verify user is a creator
        user = await UserRepository.get_by_id(user_id, columns="id, type, name, email, status")

        if not user:
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND,
                detail="User not found"
            )

        if user['type'] != 'creator':
            raise HTTPException(
                status_code=http_status.HTTP_403_FORBIDDEN,
                detail="This endpoint is only available for creators"
            )

        # Get creator profile
        creator = await CreatorRepository.get_by_user_id(
            user_id,
            columns="id, location, short_description, portfolio_link, phone, profile_picture, creator_type, created_at, updated_at"
        )

        if not creator:
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND,
                detail="Creator profile not found"
            )

        creator_id = creator['id']

        # Get platforms
        platforms_data = await CreatorRepository.get_platforms(creator_id)
        
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
        ratings_data = await CreatorRepository.get_ratings(creator_id)
        
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
            creator_type=creator['creator_type'] or 'Lifestyle',
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
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get profile: {str(e)}"
        )


@router.put("/me", response_model=CreatorProfileResponse, status_code=http_status.HTTP_200_OK)
async def update_creator_profile(
    request: UpdateCreatorProfileRequest,
    user_id: str = Depends(get_current_user_id_allow_pending)
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
        user = await UserRepository.get_by_id(user_id, columns="id, type, name")

        if not user:
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND,
                detail="User not found"
            )

        if user['type'] != 'creator':
            raise HTTPException(
                status_code=http_status.HTTP_403_FORBIDDEN,
                detail="This endpoint is only available for creators"
            )

        # Get creator profile with completion status and current profile picture
        creator = await CreatorRepository.get_by_user_id(
            user_id, columns="id, profile_complete, profile_picture"
        )

        if not creator:
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND,
                detail="Creator profile not found"
            )

        creator_id = creator['id']
        was_complete_before = creator.get('profile_complete', False)
        old_profile_picture = creator.get('profile_picture')

        # Update user name on auth database (separate from business DB transaction)
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

        # Delete old profile picture from S3 if replaced with a new one
        if request.profilePicture is not None and old_profile_picture and old_profile_picture != request.profilePicture:
            try:
                old_key = extract_key_from_url(old_profile_picture)
                if old_key:
                    await delete_file_from_s3(old_key)
                    logger.info(f"Deleted old profile picture from S3: {old_key}")
            except Exception as e:
                logger.warning(f"Failed to delete old profile picture from S3: {e}")

        # Fetch updated profile with platforms and check if profile became complete
        creator_data = await CreatorRepository.get_by_id(
            creator_id,
            columns="id, location, short_description, portfolio_link, phone, profile_picture, creator_type, created_at, updated_at, profile_complete, user_id"
        )

        user_data = await UserRepository.get_by_id(
            creator_data['user_id'], columns="name, email, status, email_verified"
        )

        # Check if profile just became complete (transition from incomplete to complete)
        is_complete_now = creator_data.get('profile_complete', False)
        profile_just_completed = not was_complete_before and is_complete_now

        # Send confirmation email if profile just became complete
        if profile_just_completed:
            try:
                user_email = user_data['email']
                user_name = user_data['name'] or user_email.split('@')[0]

                # Check if email is already verified
                email_verified = user_data.get('email_verified', False)
                
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
        
        platforms_data = await CreatorRepository.get_platforms(creator_id)
        
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
            name=request.name if request.name is not None else user_data['name'],
            location=creator_data['location'],
            short_description=creator_data['short_description'],
            portfolio_link=creator_data['portfolio_link'],
            phone=creator_data['phone'],
            profile_picture=creator_data['profile_picture'],
            creator_type=creator_data['creator_type'] or 'Lifestyle',
            platforms=platforms_response,
            audience_size=audience_size,
            status=user_data['status'],
            created_at=creator_data['created_at'],
            updated_at=creator_data['updated_at']
        )
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to update profile: {str(e)}"
        )


@router.get("/me/collaborations", response_model=List[CreatorCollaborationListResponse])
async def get_creator_collaborations(
    collab_status: Optional[Literal["pending", "accepted", "declined", "completed", "cancelled"]] = Query(None, alias="status", description="Filter by status"),
    initiated_by: Optional[Literal["creator", "hotel"]] = Query(None, description="Filter by who initiated"),
    user_id: str = Depends(get_current_user_id)
):
    """
    Get all collaborations for the currently authenticated creator.
    
    Returns collaborations where the creator is involved, whether they initiated it
    or were invited by a hotel.
    """
    try:
        # Verify user is a creator and get creator profile
        user = await UserRepository.get_by_id(user_id, columns="id, type")

        if not user or user['type'] != 'creator':
            raise HTTPException(
                status_code=http_status.HTTP_403_FORBIDDEN,
                detail="This endpoint is only available for creators"
            )

        creator = await CreatorRepository.get_by_user_id(user_id, columns="id")

        if not creator:
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND,
                detail="Creator profile not found"
            )
        
        creator_id = str(creator['id'])
        
        collaborations_data = await CollaborationRepository.get_creator_collaborations(
            creator_id, status=collab_status, initiator_type=initiated_by
        )

        # Fetch all deliverables for these collaborations in one go
        collab_ids = [str(c['id']) for c in collaborations_data]
        all_deliverables_rows = await CollaborationRepository.get_deliverables_batch(collab_ids)
        
        # Group deliverables by collaboration_id
        collab_deliverables_map = {}
        for row in all_deliverables_rows:
            c_id = str(row['collaboration_id'])
            if c_id not in collab_deliverables_map:
                collab_deliverables_map[c_id] = {}
            
            p = row['platform']
            if p not in collab_deliverables_map[c_id]:
                collab_deliverables_map[c_id][p] = []
                
            collab_deliverables_map[c_id][p].append({
                "id": str(row['id']),
                "type": row['type'],
                "quantity": row['quantity'],
                "status": row['status']
            })

        # Build response using the model
        response = []
        for collab in collaborations_data:
            c_id = str(collab['id'])
            collab_dils = collab_deliverables_map.get(c_id, {})
            deliverables = [{"platform": p, "deliverables": dils} for p, dils in collab_dils.items()]

            response.append(CreatorCollaborationListResponse(
                id=c_id,
                initiator_type=collab['initiator_type'],
                is_initiator=collab['initiator_type'] == 'creator',
                status=collab['status'],
                created_at=collab['created_at'],
                why_great_fit=collab['why_great_fit'],
                hotel_id=str(collab['hotel_id']),
                hotel_name=collab['hotel_name'],
                hotel_profile_picture=collab['hotel_profile_picture'],
                listing_id=str(collab['listing_id']),
                listing_name=collab['listing_name'],
                listing_location=collab['listing_location'],
                listing_images=collab['listing_images'] or [],
                collaboration_type=collab['collaboration_type'],
                travel_date_from=collab['travel_date_from'],
                travel_date_to=collab['travel_date_to'],
                free_stay_min_nights=collab['free_stay_min_nights'],
                free_stay_max_nights=collab['free_stay_max_nights'],
                paid_amount=collab['paid_amount'],
                discount_percentage=collab['discount_percentage'],
                platform_deliverables=deliverables
            ))
        return response
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching creator collaborations: {str(e)}")
        raise HTTPException(
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to fetch collaborations: {str(e)}"
        )


@router.get("/me/collaborations/{collaboration_id}", response_model=CreatorCollaborationDetailResponse)
async def get_creator_collaboration_detail(
    collaboration_id: str,
    user_id: str = Depends(get_current_user_id)
):
    """
    Get detailed information about a specific collaboration from the creator's perspective,
    including full hotel and listing details.
    """
    try:
        # Verify user is a creator
        user = await UserRepository.get_by_id(user_id, columns="id, type")

        if not user or user['type'] != 'creator':
            raise HTTPException(
                status_code=http_status.HTTP_403_FORBIDDEN,
                detail="This endpoint is only available for creators"
            )

        creator_profile = await CreatorRepository.get_by_user_id(user_id, columns="id")

        if not creator_profile:
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND,
                detail="Creator profile not found"
            )
        
        creator_id = str(creator_profile['id'])
        
        # Fetch collaboration details with full hotel and listing info
        collab = await CollaborationRepository.get_creator_collaboration_detail(
            collaboration_id, creator_id
        )
        
        if not collab:
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND,
                detail="Collaboration not found"
            )
            
        # Fetch deliverables
        deliverables_rows = await CollaborationRepository.get_deliverables(collaboration_id)
        
        deliverables = []
        platform_map = {}
        for row in deliverables_rows:
            p = row['platform']
            if p not in platform_map:
                platform_map[p] = []
            platform_map[p].append({
                "id": str(row['id']),
                "type": row['type'],
                "quantity": row['quantity'],
                "status": row['status']
            })
            
        deliverables = [{"platform": p, "deliverables": dils} for p, dils in platform_map.items()]

        # Fetch allowed collaboration types from listing
        allowed_collaboration_types = await HotelRepository.get_listing_collaboration_types(
            str(collab['listing_id'])
        )

        # Prepare creator requirements if they exist
        creator_requirements = None
        if collab['req_id']:
            creator_requirements = CreatorRequirementsResponse(
                id=str(collab['req_id']),
                listing_id=str(collab['listing_id']),
                platforms=collab['req_platforms'],
                min_followers=collab['req_min_followers'],
                topCountries=collab['req_target_countries'],
                target_age_min=collab['req_target_age_min'],
                target_age_max=collab['req_target_age_max'],
                target_age_groups=collab['req_target_age_groups'],
                creator_types=collab['req_creator_types'],
                created_at=collab['req_created_at'],
                updated_at=collab['req_updated_at']
            )

        return CreatorCollaborationDetailResponse(
            id=str(collab['id']),
            initiator_type=collab['initiator_type'],
            is_initiator=collab['initiator_type'] == 'creator',
            status=collab['status'],
            created_at=collab['created_at'],
            why_great_fit=collab['why_great_fit'],
            
            # Hotel/Listing Summary
            hotel_id=str(collab['hotel_id']),
            hotel_name=collab['hotel_name'],
            hotel_profile_picture=collab['hotel_profile_picture'],
            listing_id=str(collab['listing_id']),
            listing_name=collab['listing_name'],
            listing_location=collab['listing_location'],
            listing_images=collab['listing_images'] or [],
            
            # Extended Hotel Details
            hotel_location=collab['hotel_location'],
            hotel_website=collab['hotel_website'],
            hotel_about=collab['hotel_about'],
            hotel_phone=collab['hotel_phone'],
            
            # Listing Requirements (Looking for)
            creator_requirements=creator_requirements,

            # Listing's allowed collaboration types
            allowed_collaboration_types=allowed_collaboration_types,

            # Collaboration terms
            collaboration_type=collab['collaboration_type'],
            free_stay_min_nights=collab['free_stay_min_nights'],
            free_stay_max_nights=collab['free_stay_max_nights'],
            paid_amount=collab['paid_amount'],
            discount_percentage=collab['discount_percentage'],
            travel_date_from=collab['travel_date_from'],
            travel_date_to=collab['travel_date_to'],
            preferred_date_from=collab['preferred_date_from'],
            preferred_date_to=collab['preferred_date_to'],
            preferred_months=collab['preferred_months'],
            platform_deliverables=deliverables,
            consent=collab['consent'],
            
            updated_at=collab['updated_at'],
            responded_at=collab['responded_at'],
            cancelled_at=collab['cancelled_at'],
            completed_at=collab['completed_at']
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching collaboration detail: {str(e)}")
        raise HTTPException(
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to fetch collaboration details: {str(e)}"
        )

