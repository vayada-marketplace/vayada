"""
Tests for /admin/upload/images — image upload proxy.
"""
import base64
from unittest.mock import AsyncMock, patch, MagicMock

from tests.conftest import (
    create_test_user,
    get_auth_headers,
)


class TestUploadImages:
    async def test_upload_no_auth(self, client):
        resp = await client.post(
            "/admin/upload/images",
            json={
                "filename": "test.jpg",
                "content_type": "image/jpeg",
                "data": base64.b64encode(b"fake-image-data").decode(),
            },
        )
        assert resp.status_code == 403

    async def test_upload_success(self, client, cleanup_database):
        user = await create_test_user()
        headers = get_auth_headers(user["token"])

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"urls": ["https://cdn.example.com/test.jpg"]}

        mock_client = AsyncMock()
        mock_client.post.return_value = mock_response
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("app.routers.admin.upload.httpx.AsyncClient", return_value=mock_client):
            resp = await client.post(
                "/admin/upload/images",
                json={
                    "filename": "test.jpg",
                    "content_type": "image/jpeg",
                    "data": base64.b64encode(b"fake-image-data").decode(),
                },
                headers=headers,
            )

        assert resp.status_code == 201
        body = resp.json()
        assert "urls" in body

    async def test_upload_pms_error(self, client, cleanup_database):
        user = await create_test_user()
        headers = get_auth_headers(user["token"])

        mock_response = MagicMock()
        mock_response.status_code = 413
        mock_response.text = "File too large"

        mock_client = AsyncMock()
        mock_client.post.return_value = mock_response
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("app.routers.admin.upload.httpx.AsyncClient", return_value=mock_client):
            resp = await client.post(
                "/admin/upload/images",
                json={
                    "filename": "big.jpg",
                    "content_type": "image/jpeg",
                    "data": base64.b64encode(b"data").decode(),
                },
                headers=headers,
            )

        assert resp.status_code == 413

    async def test_upload_invalid_base64(self, client, cleanup_database):
        user = await create_test_user()
        resp = await client.post(
            "/admin/upload/images",
            json={
                "filename": "test.jpg",
                "data": "not-valid-base64!!!",
            },
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 500
