import pytest
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
