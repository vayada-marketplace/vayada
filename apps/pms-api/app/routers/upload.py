"""
File upload routes for room images
"""

import logging

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status

from app.config import settings
from app.dependencies import require_hotel_admin
from app.image_processing import generate_thumbnail, get_image_info, process_image, validate_image
from app.models.upload import ImageUploadResponse, MultipleImageUploadResponse
from app.s3_service import generate_file_key, upload_file_to_s3

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/upload", tags=["upload"])


@router.post("/images", response_model=MultipleImageUploadResponse, status_code=201)
async def upload_room_images(
    files: list[UploadFile] = File(...),
    user_id: str = Depends(require_hotel_admin),
):
    """Upload multiple room images. Returns S3 URLs."""
    if not settings.S3_BUCKET_NAME:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="S3 storage is not configured",
        )

    if not files:
        raise HTTPException(status_code=400, detail="No files provided")

    uploaded = []

    for file in files:
        try:
            file_content = await file.read()
            if not file_content:
                continue

            resize_enabled = settings.IMAGE_RESIZE_WIDTH > 0 or settings.IMAGE_RESIZE_HEIGHT > 0
            is_valid, error_message = validate_image(
                file_content,
                file.filename or "image",
                file.content_type,
                check_dimensions=not resize_enabled,
            )
            if not is_valid:
                logger.warning(f"Skipping invalid image {file.filename}: {error_message}")
                continue

            image_info = get_image_info(file_content)

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
                )
                image_info = get_image_info(processed_content)

            is_valid, error_message = validate_image(
                processed_content,
                file.filename or "image",
                check_dimensions=True,
            )
            if not is_valid:
                logger.warning(f"Skipping processed image {file.filename}: {error_message}")
                continue

            file_key = generate_file_key("rooms", file.filename or "image.jpg", user_id)

            content_type = file.content_type or "image/jpeg"
            url = await upload_file_to_s3(
                processed_content,
                file_key,
                content_type=content_type,
                make_public=settings.S3_USE_PUBLIC_URLS,
            )

            thumbnail_url = None
            if settings.GENERATE_THUMBNAILS:
                try:
                    thumb = generate_thumbnail(file_content, size=settings.THUMBNAIL_SIZE)
                    thumb_key = file_key.replace(".", "_thumb.")
                    thumbnail_url = await upload_file_to_s3(
                        thumb,
                        thumb_key,
                        content_type="image/jpeg",
                        make_public=settings.S3_USE_PUBLIC_URLS,
                    )
                except Exception as e:
                    logger.warning(f"Thumbnail failed for {file.filename}: {e}")

            uploaded.append(
                ImageUploadResponse(
                    url=url,
                    thumbnail_url=thumbnail_url,
                    key=file_key,
                    width=image_info.get("width", 0),
                    height=image_info.get("height", 0),
                    size_bytes=image_info.get("size_bytes", len(processed_content)),
                    format=image_info.get("format", "JPEG"),
                )
            )

        except Exception as e:
            logger.error(f"Error processing file {file.filename}: {e}")
            continue

    if not uploaded:
        raise HTTPException(status_code=400, detail="No valid images were uploaded")

    return MultipleImageUploadResponse(images=uploaded, total=len(uploaded))
