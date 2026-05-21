import logging

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException

from app.config import settings
from app.dependencies import require_hotel_admin
from app.models.listing_import import (
    ImportImagesRequest,
    ListingImportConfirm,
    ListingImportPreview,
    ListingImportRequest,
    ListingImportResult,
)
from app.repositories.room_type_repo import RoomTypeRepository
from app.services.listing_import_service import (
    download_and_upload_images,
    extract_listing_data,
)
from app.utils import get_hotel_id

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["admin-import"])


@router.post("/import/preview", response_model=ListingImportPreview)
async def import_preview(
    data: ListingImportRequest,
    user_id: str = Depends(require_hotel_admin),
):
    """Scrape a Booking.com or Airbnb listing and return extracted room type data."""
    if not settings.ANTHROPIC_API_KEY or not settings.FIRECRAWL_API_KEY:
        raise HTTPException(status_code=503, detail="Listing import is not configured")

    try:
        preview = await extract_listing_data(data.url)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("Failed to extract listing from %s: %s", data.url, e)
        raise HTTPException(
            status_code=422,
            detail="Could not extract data from this listing. The page may have blocked our request or the format is not supported.",
        )

    if not preview.room_types:
        raise HTTPException(
            status_code=422,
            detail="No room types could be extracted from this listing.",
        )

    return preview


@router.post("/import/confirm", response_model=ListingImportResult, status_code=201)
async def import_confirm(
    data: ListingImportConfirm,
    background_tasks: BackgroundTasks,
    user_id: str = Depends(require_hotel_admin),
):
    """Create room types from the confirmed import data. Images are processed in the background."""
    hotel_id = await get_hotel_id(user_id)
    if not hotel_id:
        raise HTTPException(status_code=404, detail="Hotel not found")

    room_type_ids = []
    has_images = False

    for rt in data.room_types:
        room_data = {
            "name": rt.name,
            "description": rt.description,
            "short_description": rt.short_description,
            "max_occupancy": rt.max_occupancy,
            "size": rt.size,
            "bed_type": rt.bed_type,
            "base_rate": rt.base_rate,
            "currency": rt.currency,
            "amenities": rt.amenities,
            "features": rt.features,
            "total_rooms": rt.total_rooms,
            "images": [],
            "is_active": True,
        }

        created = await RoomTypeRepository.create(hotel_id, room_data)
        room_type_id = str(created["id"])
        room_type_ids.append(room_type_id)

        if rt.source_image_urls:
            has_images = True
            background_tasks.add_task(
                download_and_upload_images,
                rt.source_image_urls,
                user_id,
                room_type_id,
            )

    count = len(room_type_ids)
    img_msg = " Images are being processed in the background." if has_images else ""
    return ListingImportResult(
        room_type_ids=room_type_ids,
        images_pending=has_images,
        message=f"{count} room type{'s' if count != 1 else ''} created.{img_msg}",
    )


@router.post("/import/images", status_code=202)
async def import_images(
    data: ImportImagesRequest,
    background_tasks: BackgroundTasks,
    user_id: str = Depends(require_hotel_admin),
):
    """Download images from source URLs and attach them to an existing room type."""
    if not data.source_image_urls:
        return {"message": "No images to import"}

    background_tasks.add_task(
        download_and_upload_images,
        data.source_image_urls,
        user_id,
        data.room_type_id,
    )
    return {"message": f"Downloading {len(data.source_image_urls)} images in the background"}
