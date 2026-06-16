from unittest.mock import AsyncMock, patch

import pytest
from app.models.listing_import import ImportImagesRequest
from app.routers.admin_import import import_images
from app.services.listing_import_service import create_platform_media_import_job


@pytest.mark.asyncio
async def test_create_platform_media_import_job_skips_legacy_backend():
    result = await create_platform_media_import_job(
        ["https://provider.example.test/room.jpg"],
        "Bearer token",
        "pms_hotel_123",
        "room_type_123",
    )

    assert result == {"message": "Image import is not available on the legacy media backend"}


@pytest.mark.asyncio
async def test_create_platform_media_import_job_skips_empty_sources():
    result = await create_platform_media_import_job([], "Bearer token", "pms_hotel_123", "rt")
    assert result == {"message": "No images to import"}


@pytest.mark.asyncio
async def test_import_images_route_does_not_claim_queued_job_for_legacy_backend():
    request = type(
        "Request",
        (),
        {"headers": {"authorization": "Bearer token"}},
    )()

    with patch("app.routers.admin_import.get_hotel_id", AsyncMock(return_value="hotel_123")):
        result = await import_images(
            ImportImagesRequest(
                room_type_id="room_type_123",
                source_image_urls=["https://provider.example.test/room.jpg"],
            ),
            request,
            user_id="user_123",
        )

    assert result == {
        "message": "Image import is not available on the legacy media backend",
        "import_job_id": None,
        "job_key": None,
    }
