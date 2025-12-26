"""
File upload routes for images
"""
from fastapi import APIRouter, UploadFile, File, HTTPException, status, Depends, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import List, Optional
import logging

from app.dependencies import get_current_user_id
from app.s3_service import upload_file_to_s3, generate_file_key
from app.image_processing import (
    validate_image,
    process_image,
    generate_thumbnail,
    get_image_info
)
from app.config import settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/upload", tags=["upload"])


class ImageUploadResponse(BaseModel):
    """Response model for single image upload"""
    url: str
    thumbnail_url: Optional[str] = None
    key: str
    width: int
    height: int
    size_bytes: int
    format: str


class MultipleImageUploadResponse(BaseModel):
    """Response model for multiple image uploads"""
    images: List[ImageUploadResponse]
    total: int


@router.post("/image", response_model=ImageUploadResponse, status_code=status.HTTP_201_CREATED)
async def upload_image(
    file: UploadFile = File(...),
    user_id: str = Depends(get_current_user_id),
    prefix: str = "images",
    target_user_id: Optional[str] = None
):
    """
    Upload a single image file
    
    - **file**: Image file (JPEG, PNG, or WEBP)
    - **prefix**: Optional prefix for organizing files (default: "images")
    
    Returns the S3 URL of the uploaded image and optional thumbnail.
    """
    try:
        # Check if S3 is configured
        if not settings.S3_BUCKET_NAME:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="S3 storage is not configured. Please configure S3_BUCKET_NAME in environment variables."
            )
        
        # Read file content
        file_content = await file.read()
        
        if not file_content:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Empty file"
            )
        
        # Validate image
        is_valid, error_message = validate_image(
            file_content,
            file.filename or "image",
            file.content_type
        )
        
        if not is_valid:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=error_message or "Invalid image file"
            )
        
        # Get image info
        image_info = get_image_info(file_content)
        
        # Process image (resize if needed)
        processed_content = file_content
        if settings.IMAGE_RESIZE_WIDTH > 0 or settings.IMAGE_RESIZE_HEIGHT > 0:
            processed_content = process_image(
                file_content,
                resize_width=settings.IMAGE_RESIZE_WIDTH if settings.IMAGE_RESIZE_WIDTH > 0 else None,
                resize_height=settings.IMAGE_RESIZE_HEIGHT if settings.IMAGE_RESIZE_HEIGHT > 0 else None,
                quality=85
            )
            # Update image info after processing
            image_info = get_image_info(processed_content)
        
        # Generate file key
        # Use target_user_id if provided (for admin creating users), otherwise use authenticated user_id
        # If target_user_id is None explicitly, don't organize by user_id (for admin creating new users)
        upload_user_id = target_user_id if target_user_id is not None else user_id
        file_key = generate_file_key(prefix, file.filename or "image.jpg", upload_user_id)
        
        # Upload to S3
        content_type = file.content_type or "image/jpeg"
        url = await upload_file_to_s3(
            processed_content,
            file_key,
            content_type=content_type,
            make_public=settings.S3_USE_PUBLIC_URLS
        )
        
        # Generate thumbnail if enabled
        thumbnail_url = None
        if settings.GENERATE_THUMBNAILS:
            try:
                thumbnail_content = generate_thumbnail(
                    file_content,
                    size=settings.THUMBNAIL_SIZE,
                    quality=85
                )
                thumbnail_key = file_key.replace(".", "_thumb.")
                thumbnail_url = await upload_file_to_s3(
                    thumbnail_content,
                    thumbnail_key,
                    content_type="image/jpeg",
                    make_public=settings.S3_USE_PUBLIC_URLS
                )
            except Exception as e:
                logger.warning(f"Failed to generate thumbnail: {e}")
                # Don't fail the upload if thumbnail generation fails
        
        return ImageUploadResponse(
            url=url,
            thumbnail_url=thumbnail_url,
            key=file_key,
            width=image_info.get("width", 0),
            height=image_info.get("height", 0),
            size_bytes=image_info.get("size_bytes", len(processed_content)),
            format=image_info.get("format", "JPEG")
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error uploading image: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to upload image: {str(e)}"
        )


@router.post("/images", response_model=MultipleImageUploadResponse, status_code=status.HTTP_201_CREATED)
async def upload_multiple_images(
    files: List[UploadFile] = File(...),
    user_id: str = Depends(get_current_user_id),
    prefix: str = "images"
):
    """
    Upload multiple image files
    
    - **files**: List of image files (JPEG, PNG, or WEBP)
    - **prefix**: Optional prefix for organizing files (default: "images")
    
    Returns the S3 URLs of all uploaded images.
    """
    try:
        # Check if S3 is configured
        if not settings.S3_BUCKET_NAME:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="S3 storage is not configured. Please configure S3_BUCKET_NAME in environment variables."
            )
        
        if not files:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No files provided"
            )
        
        uploaded_images = []
        
        for file in files:
            try:
                # Read file content
                file_content = await file.read()
                
                if not file_content:
                    logger.warning(f"Skipping empty file: {file.filename}")
                    continue
                
                # Validate image
                is_valid, error_message = validate_image(
                    file_content,
                    file.filename or "image",
                    file.content_type
                )
                
                if not is_valid:
                    logger.warning(f"Skipping invalid image {file.filename}: {error_message}")
                    continue
                
                # Get image info
                image_info = get_image_info(file_content)
                
                # Process image (resize if needed)
                processed_content = file_content
                if settings.IMAGE_RESIZE_WIDTH > 0 or settings.IMAGE_RESIZE_HEIGHT > 0:
                    processed_content = process_image(
                        file_content,
                        resize_width=settings.IMAGE_RESIZE_WIDTH if settings.IMAGE_RESIZE_WIDTH > 0 else None,
                        resize_height=settings.IMAGE_RESIZE_HEIGHT if settings.IMAGE_RESIZE_HEIGHT > 0 else None,
                        quality=85
                    )
                    # Update image info after processing
                    image_info = get_image_info(processed_content)
                
                # Generate file key
                file_key = generate_file_key(prefix, file.filename or "image.jpg", user_id)
                
                # Upload to S3
                content_type = file.content_type or "image/jpeg"
                url = await upload_file_to_s3(
                    processed_content,
                    file_key,
                    content_type=content_type,
                    make_public=settings.S3_USE_PUBLIC_URLS
                )
                
                # Generate thumbnail if enabled
                thumbnail_url = None
                if settings.GENERATE_THUMBNAILS:
                    try:
                        thumbnail_content = generate_thumbnail(
                            file_content,
                            size=settings.THUMBNAIL_SIZE,
                            quality=85
                        )
                        thumbnail_key = file_key.replace(".", "_thumb.")
                        thumbnail_url = await upload_file_to_s3(
                            thumbnail_content,
                            thumbnail_key,
                            content_type="image/jpeg",
                            make_public=settings.S3_USE_PUBLIC_URLS
                        )
                    except Exception as e:
                        logger.warning(f"Failed to generate thumbnail for {file.filename}: {e}")
                
                uploaded_images.append(ImageUploadResponse(
                    url=url,
                    thumbnail_url=thumbnail_url,
                    key=file_key,
                    width=image_info.get("width", 0),
                    height=image_info.get("height", 0),
                    size_bytes=image_info.get("size_bytes", len(processed_content)),
                    format=image_info.get("format", "JPEG")
                ))
                
            except Exception as e:
                logger.error(f"Error processing file {file.filename}: {e}")
                # Continue with other files
                continue
        
        if not uploaded_images:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No valid images were uploaded"
            )
        
        return MultipleImageUploadResponse(
            images=uploaded_images,
            total=len(uploaded_images)
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error uploading images: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to upload images: {str(e)}"
        )


@router.post("/image/hotel-profile", response_model=ImageUploadResponse, status_code=status.HTTP_201_CREATED)
async def upload_hotel_profile_image(
    file: UploadFile = File(...),
    user_id: str = Depends(get_current_user_id)
):
    """
    Upload a hotel profile picture
    
    Convenience endpoint that uploads to the 'hotels' prefix.
    """
    return await upload_image(file, user_id, prefix="hotels")


@router.post("/image/listing", response_model=ImageUploadResponse, status_code=status.HTTP_201_CREATED)
async def upload_listing_image(
    file: UploadFile = File(...),
    user_id: str = Depends(get_current_user_id)
):
    """
    Upload a listing image
    
    Convenience endpoint that uploads to the 'listings' prefix.
    """
    return await upload_image(file, user_id, prefix="listings")


@router.post("/images/listing", response_model=MultipleImageUploadResponse, status_code=status.HTTP_201_CREATED)
async def upload_listing_images(
    files: List[UploadFile] = File(...),
    user_id: str = Depends(get_current_user_id)
):
    """
    Upload multiple listing images
    
    Convenience endpoint that uploads to the 'listings' prefix.
    """
    return await upload_multiple_images(files, user_id, prefix="listings")


@router.post("/image/creator-profile", response_model=ImageUploadResponse, status_code=status.HTTP_201_CREATED)
async def upload_creator_profile_image(
    file: UploadFile = File(...),
    user_id: str = Depends(get_current_user_id),
    target_user_id: Optional[str] = Query(None, description="Target creator user_id (for admin uploading on behalf of a creator). When creating a new user, first create the user to get their user_id, then upload using that user_id here.")
):
    """
    Upload a creator profile picture
    
    Convenience endpoint that uploads to the 'creators' prefix.
    
    - For regular creators: Uses authenticated user's ID → `creators/{user_id}/filename.jpg`
    - For admin uploading for a creator: Use `target_user_id` query param → `creators/{target_user_id}/filename.jpg`
    
    **Important for admin creating new users:**
    1. First create the user via `POST /admin/users` (without profilePicture) to get the creator's user_id
    2. Then upload the image using `?target_user_id={creator_user_id}` 
    3. Finally update the profile with the image URL via `PUT /admin/users/{user_id}/profile/creator`
    
    This ensures images are organized by the creator's user_id, not the admin's.
    """
    # Use target_user_id if provided (for admin), otherwise use authenticated user_id
    upload_user_id = target_user_id if target_user_id else user_id
    return await upload_image(file, user_id, prefix="creators", target_user_id=upload_user_id)

