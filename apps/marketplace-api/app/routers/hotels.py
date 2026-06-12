"""
Hotel profile routes
"""

import json
import logging

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi import status as http_status
from pydantic import EmailStr

from app.auth import create_email_verification_token
from app.config import settings
from app.dependencies import (
    get_current_hotel_profile_id,
    get_current_user_id,
    get_current_user_id_allow_pending,
)
from app.email_service import create_profile_completion_email_html, send_email
from app.image_processing import generate_thumbnail, process_image, validate_image
from app.models.common import CollaborationOfferingResponse, CreatorRequirementsResponse
from app.models.hotels import (
    CreateListingRequest,
    CreatorPlatformDetail,
    CreatorReputation,
    CreatorReview,
    HotelCollaborationDetailResponse,
    HotelCollaborationListResponse,
    HotelProfileResponse,
    HotelProfileStatusHasDefaults,
    HotelProfileStatusResponse,
    ListingResponse,
    UpdateHotelProfileRequest,
    UpdateListingRequest,
)
from app.repositories.collaboration_repo import CollaborationRepository
from app.repositories.creator_repo import CreatorRepository
from app.repositories.hotel_repo import HotelRepository
from app.repositories.user_repo import UserRepository
from app.s3_service import (
    delete_file_from_s3,
    extract_key_from_url,
    generate_file_key,
    upload_file_to_s3,
)
from app.services.hotel_profile import HotelProfileService
from app.services.listings import ListingService, build_listing_response

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/hotels", tags=["hotels"])


@router.get("/me/profile-status", response_model=HotelProfileStatusResponse)
async def get_hotel_profile_status(user_id: str = Depends(get_current_user_id_allow_pending)):
    """
    Get the profile completion status for the currently authenticated hotel user.

    Returns:
    - profile_complete: Whether the profile is fully complete
    - missing_fields: Array of missing field names
    - has_defaults: Object indicating if location is using default value
    - missing_listings: Whether at least one property listing is missing
    - completion_steps: Human-readable steps to complete the profile
    """
    try:
        # Verify user is a hotel
        user = await UserRepository.get_by_id(user_id, columns="id, type, name")

        if not user:
            raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail="User not found")

        if user["type"] != "hotel":
            raise HTTPException(
                status_code=http_status.HTTP_403_FORBIDDEN,
                detail="This endpoint is only available for hotels",
            )

        # Get hotel profile
        hotel = await HotelRepository.get_profile_by_user_id(
            user_id, columns="id, name, location, website, about, picture, phone"
        )

        # Lazy-create a hotel profile for hotel users that don't have one yet
        # (e.g. users who registered via the booking engine, which only writes
        # to the shared auth DB). This lets them complete onboarding in the
        # marketplace without hitting a 404.
        if not hotel:
            await HotelRepository.create_profile(user_id, user.get("name") or "Hotel")
            hotel = await HotelRepository.get_profile_by_user_id(
                user_id, columns="id, name, location, website, about, picture, phone"
            )

        # Check for listings
        listings = await HotelRepository.get_listings_by_profile_id(hotel["id"], columns="id")

        missing_listings = len(listings) == 0

        # Determine missing fields and defaults
        missing_fields = []
        completion_steps = []
        has_default_location = False

        # Check name
        if not hotel["name"] or not hotel["name"].strip():
            missing_fields.append("name")
            completion_steps.append("Update your hotel name")

        # Check location (required field, but check if it's the default)
        if not hotel["location"] or not hotel["location"].strip():
            missing_fields.append("location")
            completion_steps.append("Set your location")
        elif hotel["location"].strip() == "Not specified":
            has_default_location = True
            # Don't add to missing_fields - defaults are tracked separately
            completion_steps.append("Set a custom location (currently using default)")

        # Email is always in users table, so no need to check it here

        # Check optional but recommended fields
        if not hotel["about"] or not hotel["about"].strip():
            missing_fields.append("about")
            completion_steps.append("Add a description about your hotel")

        if not hotel["website"] or not hotel["website"].strip():
            missing_fields.append("website")
            completion_steps.append("Add your website URL")

        # Check for listings
        if missing_listings:
            completion_steps.append("Add at least one property listing")

        # Determine if profile is complete
        # Profile is complete when:
        # - All required fields are filled (name, location)
        # - Location is not using default value
        # - Optional fields like about and website are present (based on business logic)
        # - At least one listing exists
        # Note: Email is always in users table, so not checked here
        profile_complete = (
            len(missing_fields) == 0 and not has_default_location and not missing_listings
        )

        return HotelProfileStatusResponse(
            profile_complete=profile_complete,
            missing_fields=missing_fields,
            has_defaults=HotelProfileStatusHasDefaults(location=has_default_location),
            missing_listings=missing_listings,
            completion_steps=completion_steps,
        )

    except HTTPException:
        raise
    except Exception:
        raise HTTPException(
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get profile status",
        )


@router.get("/me", response_model=HotelProfileResponse, status_code=http_status.HTTP_200_OK)
async def get_hotel_profile(user_id: str = Depends(get_current_user_id_allow_pending)):
    """
    Get the complete profile data for the currently authenticated hotel user.
    """
    try:
        user = await UserRepository.get_by_id(user_id, columns="id, type, email, name, status")
        if not user:
            raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail="User not found")
        if user["type"] != "hotel":
            raise HTTPException(
                status_code=http_status.HTTP_403_FORBIDDEN,
                detail="This endpoint is only available for hotels",
            )

        hotel = await HotelRepository.get_profile_by_user_id(
            user_id,
            columns="id, user_id, name, location, about, website, phone, picture, status, created_at, updated_at",
        )
        # Lazy-create a hotel profile for hotel users that don't have one yet
        # (e.g. users who registered via the booking engine, which only writes
        # to the shared auth DB).
        if not hotel:
            await HotelRepository.create_profile(user_id, user.get("name") or "Hotel")
            hotel = await HotelRepository.get_profile_by_user_id(
                user_id,
                columns="id, user_id, name, location, about, website, phone, picture, status, created_at, updated_at",
            )

        listings_data = await HotelRepository.get_listings_by_profile_id(hotel["id"])

        listings_response: list[dict] = []
        for listing in listings_data:
            offerings_data = await HotelRepository.get_offerings(listing["id"])
            offerings_response = [
                CollaborationOfferingResponse.model_validate(
                    {
                        "id": str(o["id"]),
                        "listing_id": str(o["listing_id"]),
                        "collaboration_type": o["collaboration_type"],
                        "availability_months": o["availability_months"],
                        "platforms": o["platforms"],
                        "free_stay_min_nights": o["free_stay_min_nights"],
                        "free_stay_max_nights": o["free_stay_max_nights"],
                        "paid_max_amount": o["paid_max_amount"],
                        "currency": o.get("currency"),
                        "discount_percentage": o["discount_percentage"],
                        "commission_percentage": o.get("commission_percentage"),
                        "min_followers": o.get("min_followers"),
                        "created_at": o["created_at"],
                        "updated_at": o["updated_at"],
                    }
                ).model_dump(by_alias=True)
                for o in offerings_data
            ]

            requirements = await HotelRepository.get_requirements(listing["id"])
            requirements_response = None
            if requirements:
                requirements_response = CreatorRequirementsResponse.model_validate(
                    {
                        "id": str(requirements["id"]),
                        "listing_id": str(listing["id"]),
                        "platforms": requirements["platforms"],
                        "target_countries": requirements["target_countries"],
                        "target_age_min": requirements["target_age_min"],
                        "target_age_max": requirements["target_age_max"],
                        "target_age_groups": requirements["target_age_groups"],
                        "creator_types": requirements["creator_types"],
                        "created_at": requirements["created_at"],
                        "updated_at": requirements["updated_at"],
                    }
                ).model_dump(by_alias=True)

            listings_response.append(
                ListingResponse.model_validate(
                    {
                        "id": str(listing["id"]),
                        "hotel_profile_id": str(listing["hotel_profile_id"]),
                        "name": listing["name"],
                        "location": listing["location"],
                        "description": listing["description"],
                        "accommodation_type": listing["accommodation_type"],
                        "images": listing["images"] or [],
                        "status": listing["status"],
                        "created_at": listing["created_at"],
                        "updated_at": listing["updated_at"],
                        "collaboration_offerings": offerings_response,
                        "creator_requirements": requirements_response,
                    }
                ).model_dump(by_alias=True)
            )

        return HotelProfileResponse(
            id=str(hotel["id"]),
            user_id=str(hotel["user_id"]),
            name=hotel["name"],
            location=hotel["location"],
            email=user["email"],
            about=hotel["about"],
            website=hotel["website"],
            phone=hotel["phone"],
            picture=hotel["picture"],
            status=hotel["status"],
            created_at=hotel["created_at"],
            updated_at=hotel["updated_at"],
            listings=listings_response,
        )
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to get profile"
        )


@router.put("/me", response_model=HotelProfileResponse, status_code=http_status.HTTP_200_OK)
async def update_hotel_profile(
    http_request: Request,
    name: str | None = Form(default=None),
    location: str | None = Form(default=None),
    email: EmailStr | None = Form(default=None),
    about: str | None = Form(default=None),
    website: str | None = Form(default=None),
    phone: str | None = Form(default=None),
    picture: UploadFile | None = File(default=None),
    user_id: str = Depends(get_current_user_id_allow_pending),
):
    """
    Update the currently authenticated hotel's profile.
    Supports partial updates - only provided fields will be updated.

    Accepts either:
    - JSON body (UpdateHotelProfileRequest) for text fields
    - multipart/form-data for file uploads (picture) and text fields

    If JSON body is provided, it takes precedence over Form fields.
    """
    try:
        # Check if request is JSON and parse it
        # FastAPI will parse Form data if content-type is multipart/form-data
        # For JSON requests, we need to manually parse the body
        content_type = http_request.headers.get("content-type", "")

        # If it's JSON (not multipart), parse JSON body
        picture_url_from_json = None
        if "application/json" in content_type and "multipart/form-data" not in content_type:
            try:
                json_data = await http_request.json()
                request = UpdateHotelProfileRequest(**json_data)
                # Use JSON body values
                name = request.name
                location = request.location
                email = request.email
                about = request.about
                website = str(request.website) if request.website is not None else None
                phone = request.phone
                # Extract picture URL from JSON if provided
                picture_url_from_json = (
                    str(request.picture) if request.picture is not None else None
                )
            except ValidationError as e:
                # Re-raise validation errors as HTTP 422
                # Convert errors to JSON-serializable format
                import json

                errors = []
                for error in e.errors():
                    # Ensure all values in error dict are JSON serializable
                    serializable_error = {}
                    for key, value in error.items():
                        if key == "loc":
                            # Convert location tuple/list to list of strings
                            serializable_error[key] = [str(v) for v in value] if value else []
                        elif key == "ctx" and value:
                            # Convert context dict to string if it contains non-serializable values
                            try:
                                json.dumps(value)
                                serializable_error[key] = value
                            except (TypeError, ValueError):
                                serializable_error[key] = str(value)
                        else:
                            # Convert other values to strings if not JSON serializable
                            try:
                                json.dumps(value)
                                serializable_error[key] = value
                            except (TypeError, ValueError):
                                serializable_error[key] = str(value)
                    errors.append(serializable_error)
                raise HTTPException(
                    status_code=http_status.HTTP_422_UNPROCESSABLE_ENTITY, detail=errors
                )
            except Exception as e:
                logger.warning(f"Failed to parse JSON body: {e}")
                # If JSON parsing fails, continue with Form data (if any)

        # Verify user is a hotel
        user = await UserRepository.get_by_id(user_id, columns="id, type, email")

        if not user:
            raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail="User not found")

        if user["type"] != "hotel":
            raise HTTPException(
                status_code=http_status.HTTP_403_FORBIDDEN,
                detail="This endpoint is only available for hotels",
            )
        if email is not None and email != user["email"]:
            raise HTTPException(
                status_code=http_status.HTTP_409_CONFLICT,
                detail="Email is identity-owned. Use the identity user lifecycle route to update account email.",
            )

        # Get current hotel profile with completion status
        hotel = await HotelRepository.get_profile_by_user_id(
            user_id,
            columns="id, user_id, name, location, about, website, phone, picture, status, created_at, updated_at, profile_complete",
        )

        if not hotel:
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND, detail="Hotel profile not found"
            )

        was_complete_before = hotel.get("profile_complete", False)

        # Handle picture upload if provided
        picture_url = None
        if picture is not None:
            try:
                # Read file content
                file_content = await picture.read()

                if file_content:
                    # Validate image
                    is_valid, error_message = validate_image(
                        file_content, picture.filename or "image", picture.content_type
                    )

                    if not is_valid:
                        raise HTTPException(
                            status_code=http_status.HTTP_400_BAD_REQUEST,
                            detail=error_message or "Invalid image file",
                        )

                    # Process image (resize if needed)
                    processed_content = file_content
                    if settings.IMAGE_RESIZE_WIDTH > 0 or settings.IMAGE_RESIZE_HEIGHT > 0:
                        processed_content = process_image(
                            file_content,
                            resize_width=settings.IMAGE_RESIZE_WIDTH
                            if settings.IMAGE_RESIZE_WIDTH > 0
                            else None,
                            resize_height=settings.IMAGE_RESIZE_HEIGHT
                            if settings.IMAGE_RESIZE_HEIGHT > 0
                            else None,
                            quality=85,
                        )

                    # Generate file key
                    file_key = generate_file_key("hotels", picture.filename or "image.jpg", user_id)

                    # Upload to S3
                    content_type = picture.content_type or "image/jpeg"
                    picture_url = await upload_file_to_s3(
                        processed_content,
                        file_key,
                        content_type=content_type,
                        make_public=settings.S3_USE_PUBLIC_URLS,
                    )

                    # Generate thumbnail if enabled
                    if settings.GENERATE_THUMBNAILS:
                        try:
                            thumbnail_content = generate_thumbnail(
                                file_content, size=settings.THUMBNAIL_SIZE, quality=85
                            )
                            thumbnail_key = file_key.replace(".", "_thumb.")
                            await upload_file_to_s3(
                                thumbnail_content,
                                thumbnail_key,
                                content_type="image/jpeg",
                                make_public=settings.S3_USE_PUBLIC_URLS,
                            )
                        except Exception as e:
                            logger.warning(f"Failed to generate thumbnail: {e}")
            except HTTPException:
                raise
            except Exception as e:
                logger.error(f"Error uploading picture: {e}")
                raise HTTPException(
                    status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail="Failed to upload picture",
                )

        # Use picture URL from JSON if provided, otherwise use uploaded file URL
        final_picture_url = (
            picture_url_from_json if picture_url_from_json is not None else picture_url
        )

        await HotelProfileService.apply_partial(
            hotel["id"],
            name=name,
            location=location,
            about=about,
            website=website,
            phone=phone,
            picture=final_picture_url,
        )

        # Fetch updated profile and user data separately (different databases)
        updated_hotel = await HotelRepository.get_profile_by_id(
            hotel["id"],
            columns="id, user_id, name, location, about, website, phone, picture, status, created_at, updated_at, profile_complete",
        )

        updated_user = await UserRepository.get_by_id(
            updated_hotel["user_id"], columns="email, name"
        )

        # Check if profile just became complete (transition from incomplete to complete)
        is_complete_now = updated_hotel.get("profile_complete", False)
        profile_just_completed = not was_complete_before and is_complete_now

        # Send confirmation email if profile just became complete
        if profile_just_completed:
            try:
                user_email = updated_user["email"]
                user_name = (
                    updated_user.get("name")
                    or updated_hotel.get("name")
                    or user_email.split("@")[0]
                )

                # Check if email is already verified
                user_record = await UserRepository.get_by_id(user_id, columns="email_verified")
                email_verified = user_record.get("email_verified", False) if user_record else False

                # Generate verification token and link if email is not verified
                verification_link = None
                if not email_verified:
                    try:
                        token = await create_email_verification_token(user_id, expires_in_hours=48)
                        verification_link = f"{settings.FRONTEND_URL}/verify-email?token={token}"
                    except Exception as e:
                        logger.error(f"Error creating email verification token: {str(e)}")
                        # Continue without verification link if token creation fails

                html_body = create_profile_completion_email_html(
                    user_name, "hotel", verification_link
                )

                email_sent = await send_email(
                    to_email=user_email,
                    subject="🎉 Your Hotel Profile is Complete!"
                    + (" - Verify Your Email" if not email_verified else ""),
                    html_body=html_body,
                )

                if email_sent:
                    logger.info(
                        f"Profile completion email sent to {user_email}"
                        + (" with verification link" if verification_link else "")
                    )
                else:
                    logger.warning(f"Failed to send profile completion email to {user_email}")
            except Exception as e:
                # Don't fail the request if email fails
                logger.error(f"Error sending profile completion email: {str(e)}")

        # Get all listings for this hotel (same as GET endpoint)
        listings_data = await HotelRepository.get_listings_by_profile_id(hotel["id"])

        listings_response = []
        for listing in listings_data:
            # Get collaboration offerings for this listing
            offerings_data = await HotelRepository.get_offerings(listing["id"])

            offerings_response = [
                CollaborationOfferingResponse.model_validate(
                    {
                        "id": str(o["id"]),
                        "listing_id": str(o["listing_id"]),
                        "collaboration_type": o["collaboration_type"],
                        "availability_months": o["availability_months"],
                        "platforms": o["platforms"],
                        "free_stay_min_nights": o["free_stay_min_nights"],
                        "free_stay_max_nights": o["free_stay_max_nights"],
                        "paid_max_amount": o["paid_max_amount"],
                        "currency": o.get("currency"),
                        "discount_percentage": o["discount_percentage"],
                        "commission_percentage": o.get("commission_percentage"),
                        "min_followers": o.get("min_followers"),
                        "created_at": o["created_at"],
                        "updated_at": o["updated_at"],
                    }
                ).model_dump(by_alias=True)
                for o in offerings_data
            ]

            # Get creator requirements for this listing
            requirements = await HotelRepository.get_requirements(listing["id"])

            requirements_response = None
            if requirements:
                requirements_response = CreatorRequirementsResponse.model_validate(
                    {
                        "id": str(requirements["id"]),
                        "listing_id": str(listing["id"]),
                        "platforms": requirements["platforms"],
                        "target_countries": requirements["target_countries"],
                        "target_age_min": requirements["target_age_min"],
                        "target_age_max": requirements["target_age_max"],
                        "target_age_groups": requirements["target_age_groups"],
                        "creator_types": requirements["creator_types"],
                        "created_at": requirements["created_at"],
                        "updated_at": requirements["updated_at"],
                    }
                ).model_dump(by_alias=True)

            listings_response.append(
                ListingResponse.model_validate(
                    {
                        "id": str(listing["id"]),
                        "hotel_profile_id": str(listing["hotel_profile_id"]),
                        "name": listing["name"],
                        "location": listing["location"],
                        "description": listing["description"],
                        "accommodation_type": listing["accommodation_type"],
                        "images": listing["images"] or [],
                        "status": listing["status"],
                        "created_at": listing["created_at"],
                        "updated_at": listing["updated_at"],
                        "collaboration_offerings": offerings_response,
                        "creator_requirements": requirements_response,
                    }
                ).model_dump(by_alias=True)
            )

        return HotelProfileResponse(
            id=str(updated_hotel["id"]),
            user_id=str(updated_hotel["user_id"]),
            name=updated_hotel["name"],
            location=updated_hotel["location"],
            email=updated_user["email"],
            about=updated_hotel["about"],
            website=updated_hotel["website"],
            phone=updated_hotel["phone"],
            picture=updated_hotel["picture"],
            status=updated_hotel["status"],
            created_at=updated_hotel["created_at"],
            updated_at=updated_hotel["updated_at"],
            listings=listings_response,
        )

    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=http_status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception:
        raise HTTPException(
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update profile",
        )


@router.post(
    "/me/listings", response_model=ListingResponse, status_code=http_status.HTTP_201_CREATED
)
async def create_hotel_listing(
    request: CreateListingRequest, user_id: str = Depends(get_current_user_id_allow_pending)
):
    """
    Create a new property listing for the currently authenticated hotel.
    Allows pending users for profile completion.
    """
    try:
        hotel_profile_id = await get_current_hotel_profile_id(user_id)

        # If the owning user is already verified, the new listing inherits that
        # status — admin user verification is the only approval gate today.
        user = await UserRepository.get_by_id(user_id, columns="status")
        initial_status = "verified" if user and user["status"] == "verified" else "pending"

        data = await ListingService.create(
            hotel_profile_id,
            request,
            initial_status=initial_status,
        )
        return build_listing_response(data, hotel_profile_id=hotel_profile_id)

    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=http_status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception:
        raise HTTPException(
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create listing",
        )


@router.put(
    "/me/listings/{listing_id}", response_model=ListingResponse, status_code=http_status.HTTP_200_OK
)
async def update_hotel_listing(
    listing_id: str, request: UpdateListingRequest, user_id: str = Depends(get_current_user_id)
):
    """
    Update a hotel listing. Supports partial updates - only provided fields will be updated.
    """
    try:
        hotel_profile_id = await get_current_hotel_profile_id(user_id)

        existing = await ListingService.get_with_details(listing_id, hotel_profile_id)
        if existing is None:
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND, detail="Listing not found"
            )
        old_images = existing["listing"].get("images") or []

        await ListingService.update(listing_id, request)

        # Delete removed images from S3 if images were updated
        if request.images is not None:
            new_images = set(request.images)
            removed_images = [img for img in old_images if img not in new_images]
            for image_url in removed_images:
                try:
                    image_key = extract_key_from_url(image_url)
                    if image_key:
                        await delete_file_from_s3(image_key)
                        thumbnail_key = image_key.replace("/images/", "/thumbnails/")
                        await delete_file_from_s3(thumbnail_key)
                        logger.info(f"Deleted removed listing image from S3: {image_key}")
                except Exception as e:
                    logger.warning(f"Failed to delete image from S3: {e}")

        updated = await ListingService.get_with_details(listing_id, hotel_profile_id)
        return build_listing_response(updated, hotel_profile_id=hotel_profile_id)

    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=http_status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception:
        raise HTTPException(
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update listing",
        )


@router.delete("/me/listings/{listing_id}", status_code=http_status.HTTP_204_NO_CONTENT)
async def delete_hotel_listing(listing_id: str, user_id: str = Depends(get_current_user_id)):
    """
    Delete a hotel listing and all associated data (offerings, requirements).
    """
    try:
        hotel_profile_id = await get_current_hotel_profile_id(user_id)

        listing = await HotelRepository.get_listing(listing_id, hotel_profile_id, columns="id")
        if not listing:
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND, detail="Listing not found"
            )

        await ListingService.delete(listing_id)
        return None

    except HTTPException:
        raise
    except Exception:
        raise HTTPException(
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to delete listing",
        )


@router.get(
    "/me/collaborations",
    response_model=list[HotelCollaborationListResponse],
    status_code=http_status.HTTP_200_OK,
)
async def get_hotel_collaborations(
    listing_id: str | None = Query(None, description="Filter by listing ID"),
    collab_status: str | None = Query(None, alias="status", description="Filter by status"),
    initiated_by: str | None = Query(None, description="Filter by initiator type (creator/hotel)"),
    user_id: str = Depends(get_current_user_id),
):
    """
    Get all collaborations associated with the authenticated hotel.

    This is a summary endpoint returning a lightweight list of collaborations.
    For full details including creator demographics and deliverables,
    use the GET /collaborations/{id} detail endpoint.
    """
    try:
        # Verify user is a hotel
        user = await UserRepository.get_by_id(user_id, columns="id, type")

        if not user or user["type"] != "hotel":
            raise HTTPException(
                status_code=http_status.HTTP_403_FORBIDDEN,
                detail="This endpoint is only available for hotels",
            )

        hotel_profile = await HotelRepository.get_profile_by_user_id(user_id, columns="id")

        if not hotel_profile:
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND, detail="Hotel profile not found"
            )

        hotel_id = str(hotel_profile["id"])

        collaborations_data = await CollaborationRepository.get_hotel_collaborations(
            hotel_id, listing_id=listing_id, status=collab_status, initiator_type=initiated_by
        )

        if not collaborations_data:
            return []

        # Batch fetch user data for creators
        creator_user_ids = list(set(str(row["creator_user_id"]) for row in collaborations_data))
        users_map = await UserRepository.batch_get_by_ids(creator_user_ids)

        # Fetch all deliverables for these collaborations in one go
        collab_ids = [str(c["id"]) for c in collaborations_data]
        all_deliverables_rows = await CollaborationRepository.get_deliverables_batch(collab_ids)

        # Group deliverables by collaboration_id
        collab_deliverables_map = {}
        for row in all_deliverables_rows:
            c_id = str(row["collaboration_id"])
            if c_id not in collab_deliverables_map:
                collab_deliverables_map[c_id] = {}

            p = row["platform"]
            if p not in collab_deliverables_map[c_id]:
                collab_deliverables_map[c_id][p] = []

            collab_deliverables_map[c_id][p].append(
                {
                    "id": str(row["id"]),
                    "type": row["type"],
                    "quantity": row["quantity"],
                    "status": row["status"],
                }
            )

        # Build response
        response = []
        for collab in collaborations_data:
            c_id = str(collab["id"])
            collab_dils = collab_deliverables_map.get(c_id, {})
            deliverables = [
                {"platform": p, "deliverables": dils} for p, dils in collab_dils.items()
            ]
            creator_user = users_map.get(str(collab["creator_user_id"]), {})

            response.append(
                {
                    "id": c_id,
                    "initiator_type": collab["initiator_type"],
                    "is_initiator": collab["initiator_type"] == "hotel",
                    "status": collab["status"],
                    "created_at": collab["created_at"],
                    "why_great_fit": collab["why_great_fit"],
                    # Creator Summary
                    "creator_id": str(collab["creator_id"]),
                    "creator_name": creator_user.get("name", "Unknown"),
                    "creator_profile_picture": collab["creator_profile_picture"],
                    "creator_location": collab["creator_location"],
                    "primary_handle": collab["primary_handle"],
                    "total_followers": int(collab["total_followers"])
                    if collab["total_followers"] is not None
                    else 0,
                    "avg_engagement_rate": float(collab["avg_engagement_rate"])
                    if collab["avg_engagement_rate"] is not None
                    else 0.0,
                    "active_platform": collab["active_platform"],
                    "is_verified": creator_user.get("status") == "verified",
                    "platform_deliverables": deliverables,
                    "travel_date_from": collab["travel_date_from"],
                    "travel_date_to": collab["travel_date_to"],
                }
            )

        return response

    except HTTPException:
        raise
    except Exception:
        logger.exception("Failed to fetch hotel collaborations")
        raise HTTPException(
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to fetch collaborations",
        )


@router.get(
    "/me/collaborations/{collaboration_id}", response_model=HotelCollaborationDetailResponse
)
async def get_hotel_collaboration_detail(
    collaboration_id: str, user_id: str = Depends(get_current_user_id)
):
    """
    Get detailed information about a specific collaboration, including
    the creator's full platform metrics (demographics, etc.).
    """
    try:
        # Verify user is a hotel
        user = await UserRepository.get_by_id(user_id, columns="id, type")

        if not user or user["type"] != "hotel":
            raise HTTPException(
                status_code=http_status.HTTP_403_FORBIDDEN,
                detail="This endpoint is only available for hotels",
            )

        hotel_profile = await HotelRepository.get_profile_by_user_id(user_id, columns="id")

        if not hotel_profile:
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND, detail="Hotel profile not found"
            )

        hotel_id = str(hotel_profile["id"])

        # Fetch collaboration details
        collab = await CollaborationRepository.get_hotel_collaboration_detail(
            collaboration_id, hotel_id
        )

        if not collab:
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND, detail="Collaboration not found"
            )

        creator_id = collab["creator_id"]

        # Fetch creator user data from AuthDatabase
        creator_user = await UserRepository.get_by_id(
            collab["creator_user_id"], columns="name, status"
        )

        # Fetch detailed platform metrics for the creator
        platforms_data = await CreatorRepository.get_platforms(
            creator_id,
            columns="name, handle, followers, engagement_rate, top_countries, top_age_groups, gender_split",
        )

        # Calculate aggregates
        total_followers = sum(p["followers"] for p in platforms_data)
        avg_engagement_rate = (
            sum(p["engagement_rate"] for p in platforms_data) / len(platforms_data)
            if platforms_data
            else 0.0
        )

        # Format platform details
        platforms_response = []
        primary_handle = None
        max_followers = -1

        for p in platforms_data:
            if p["followers"] > max_followers:
                max_followers = p["followers"]
                primary_handle = p["handle"]

            platforms_response.append(
                CreatorPlatformDetail(
                    name=p["name"],
                    handle=p["handle"],
                    followers=p["followers"],
                    engagement_rate=float(p["engagement_rate"]),
                    top_countries=json.loads(p["top_countries"]) if p["top_countries"] else None,
                    top_age_groups=json.loads(p["top_age_groups"]) if p["top_age_groups"] else None,
                    gender_split=json.loads(p["gender_split"]) if p["gender_split"] else None,
                )
            )

        # Fetch reputation data
        reputation_data = await CreatorRepository.get_ratings(creator_id)

        reviews = []
        total_rating = 0
        for r in reputation_data:
            total_rating += r["rating"]
            reviews.append(
                CreatorReview(
                    id=str(r["id"]),
                    rating=r["rating"],
                    comment=r["comment"],
                    organization_name=r.get("hotel_name", "Hotel"),
                    created_at=r["created_at"],
                )
            )

        reputation = None
        if reputation_data:
            reputation = CreatorReputation(
                average_rating=total_rating / len(reputation_data),
                total_reviews=len(reputation_data),
                reviews=reviews,
            )

        # Fetch deliverables
        deliverables_rows = await CollaborationRepository.get_deliverables(collaboration_id)

        deliverables = []
        platform_map = {}
        for row in deliverables_rows:
            p = row["platform"]
            if p not in platform_map:
                platform_map[p] = []
            platform_map[p].append(
                {
                    "id": str(row["id"]),
                    "type": row["type"],
                    "quantity": row["quantity"],
                    "status": row["status"],
                }
            )

        deliverables = [{"platform": p, "deliverables": dils} for p, dils in platform_map.items()]

        return HotelCollaborationDetailResponse(
            # List Response Fields
            id=str(collab["id"]),
            initiator_type=collab["initiator_type"],
            is_initiator=collab["initiator_type"] == "hotel",
            status=collab["status"],
            created_at=collab["created_at"],
            why_great_fit=collab["why_great_fit"],
            # Creator Summary
            creator_id=str(collab["creator_id"]),
            creator_name=creator_user["name"] if creator_user else "Unknown",
            creator_profile_picture=collab["creator_profile_picture"],
            creator_location=collab["creator_location"],
            total_followers=total_followers,
            avg_engagement_rate=float(avg_engagement_rate),
            is_verified=(creator_user.get("status") == "verified") if creator_user else False,
            primary_handle=primary_handle,
            # Detail Fields
            platforms=platforms_response,
            reputation=reputation,
            platform_deliverables=deliverables,
            travel_date_from=collab["travel_date_from"],
            travel_date_to=collab["travel_date_to"],
            portfolio_link=collab["creator_portfolio_link"],
            hotel_id=str(collab["hotel_id"]),
            hotel_name=collab["hotel_name"],
            listing_id=str(collab["listing_id"]),
            listing_name=collab["listing_name"],
            listing_location=collab["listing_location"],
            collaboration_type=collab["collaboration_type"],
            free_stay_min_nights=collab["free_stay_min_nights"],
            free_stay_max_nights=collab["free_stay_max_nights"],
            paid_amount=collab["paid_amount"],
            currency=collab.get("currency"),
            discount_percentage=collab["discount_percentage"],
            preferred_date_from=collab["preferred_date_from"],
            preferred_date_to=collab["preferred_date_to"],
            preferred_months=collab["preferred_months"],
            consent=collab["consent"],
            updated_at=collab["updated_at"],
            responded_at=collab["responded_at"],
            cancelled_at=collab["cancelled_at"],
            completed_at=collab["completed_at"],
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching collaboration detail: {str(e)}")
        raise HTTPException(
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to fetch collaboration details",
        )
