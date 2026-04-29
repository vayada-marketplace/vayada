"""
Admin listing-CRUD endpoints. Thin wrappers around ListingService.
"""
import logging

from fastapi import APIRouter, HTTPException, status as http_status, Depends

from app.dependencies import get_admin_user
from app.s3_service import delete_file_from_s3, extract_key_from_url
from app.repositories.user_repo import UserRepository
from app.repositories.hotel_repo import HotelRepository
from app.services.listings import ListingService, build_listing_response
from app.models.hotels import (
    CreateListingRequest,
    UpdateListingRequest,
    ListingResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter()


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


@router.post(
    "/users/{user_id}/listings",
    response_model=ListingResponse,
    status_code=http_status.HTTP_201_CREATED,
)
async def create_hotel_listing(
    user_id: str,
    request: CreateListingRequest,
    admin_id: str = Depends(get_admin_user)
):
    """Create a listing for an existing hotel user (admin endpoint)."""
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


@router.put(
    "/users/{user_id}/listings/{listing_id}",
    response_model=ListingResponse,
    status_code=http_status.HTTP_200_OK,
)
async def update_hotel_listing(
    user_id: str,
    listing_id: str,
    request: UpdateListingRequest,
    admin_id: str = Depends(get_admin_user)
):
    """Update a hotel listing (admin endpoint). Partial updates supported."""
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


@router.delete(
    "/users/{user_id}/listings/{listing_id}",
    status_code=http_status.HTTP_200_OK,
)
async def delete_hotel_listing(
    user_id: str,
    listing_id: str,
    admin_id: str = Depends(get_admin_user)
):
    """Delete a hotel listing and its S3 images (admin endpoint)."""
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
