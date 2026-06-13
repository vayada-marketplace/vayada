import logging

from fastapi import APIRouter, Depends, HTTPException, Request

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
    create_platform_media_import_job,
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
    request: Request,
    user_id: str = Depends(require_hotel_admin),
):
    """Create room types and queue platform media import jobs for source images."""
    hotel_id = await get_hotel_id(user_id)
    if not hotel_id:
        raise HTTPException(status_code=404, detail="Hotel not found")

    room_type_ids = []
    queued_image_imports = 0
    failed_image_imports = 0
    auth_header = request.headers.get("authorization", "")

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
            try:
                await create_platform_media_import_job(
                    rt.source_image_urls,
                    auth_header,
                    hotel_id,
                    room_type_id,
                )
                queued_image_imports += 1
            except Exception as e:
                failed_image_imports += 1
                logger.warning(
                    "Failed to queue platform media import job for room type %s: %s",
                    room_type_id,
                    e,
                )

    count = len(room_type_ids)
    img_msg = ""
    if queued_image_imports:
        img_msg = " Image imports were queued in platform media."
    elif failed_image_imports:
        img_msg = " Image import queueing failed; retry from the imported room type."
    return ListingImportResult(
        room_type_ids=room_type_ids,
        images_pending=queued_image_imports > 0,
        message=f"{count} room type{'s' if count != 1 else ''} created.{img_msg}",
    )


@router.post("/import/images", status_code=202)
async def import_images(
    data: ImportImagesRequest,
    request: Request,
    user_id: str = Depends(require_hotel_admin),
):
    """Queue a platform media import job for source image URLs."""
    if not data.source_image_urls:
        return {"message": "No images to import"}

    hotel_id = await get_hotel_id(user_id)
    if not hotel_id:
        raise HTTPException(status_code=404, detail="Hotel not found")

    result = await create_platform_media_import_job(
        data.source_image_urls,
        request.headers.get("authorization", ""),
        hotel_id,
        data.room_type_id,
    )
    import_job = result.get("importJob", {})
    return {
        "message": f"Queued {len(data.source_image_urls)} image import job in platform media",
        "import_job_id": import_job.get("importJobId"),
        "job_key": import_job.get("jobKey"),
    }
