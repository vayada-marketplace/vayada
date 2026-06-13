from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.listing_import_service import create_platform_media_import_job


@pytest.mark.asyncio
async def test_create_platform_media_import_job_calls_apps_api():
    mock_response = MagicMock()
    mock_response.json.return_value = {
        "importJob": {
            "importJobId": "job_123",
            "jobKey": "media.import:pms:room_type_123:listing-import:v1",
        }
    }
    mock_response.raise_for_status = MagicMock()

    mock_client = AsyncMock()
    mock_client.post.return_value = mock_response
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    with patch("app.services.listing_import_service.httpx.AsyncClient", return_value=mock_client):
        result = await create_platform_media_import_job(
            ["https://provider.example.test/room.jpg"],
            "Bearer token",
            "pms_hotel_123",
            "room_type_123",
        )

    mock_client.post.assert_awaited_once()
    _, kwargs = mock_client.post.call_args
    assert kwargs["json"] == {
        "purpose": "pms.import.source_image",
        "resource": {
            "product": "pms",
            "resourceType": "pms_hotel",
            "resourceId": "pms_hotel_123",
            "targetResourceId": "room_type_123",
        },
        "sourceImageUrls": ["https://provider.example.test/room.jpg"],
        "idempotencyKey": "media.import:pms:room_type_123:listing-import:v1",
    }
    assert kwargs["headers"] == {"Authorization": "Bearer token"}
    mock_response.raise_for_status.assert_called_once()
    assert result["importJob"]["importJobId"] == "job_123"


@pytest.mark.asyncio
async def test_create_platform_media_import_job_skips_empty_sources():
    with patch("app.services.listing_import_service.httpx.AsyncClient") as client:
        result = await create_platform_media_import_job([], "Bearer token", "pms_hotel_123", "rt")

    client.assert_not_called()
    assert result == {"message": "No images to import"}
