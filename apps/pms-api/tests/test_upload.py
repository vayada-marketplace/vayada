"""
Tests for /upload/images endpoint.
"""

import io

import pytest
from PIL import Image

from tests.conftest import (
    create_test_hotel,
    create_test_user,
    get_auth_headers,
)


def make_test_image(width=800, height=600, fmt="JPEG") -> bytes:
    """Create a minimal test image in memory."""
    img = Image.new("RGB", (width, height), color=(255, 0, 0))
    buf = io.BytesIO()
    img.save(buf, format=fmt)
    buf.seek(0)
    return buf.read()


def make_test_png(width=800, height=600) -> bytes:
    img = Image.new("RGBA", (width, height), color=(0, 255, 0, 128))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return buf.read()


class TestImageUpload:
    async def test_upload_single_image(self, client, cleanup_database, mock_s3_operations):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        image_data = make_test_image()
        resp = await client.post(
            "/upload/images",
            files=[("files", ("room.jpg", image_data, "image/jpeg"))],
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 201
        body = resp.json()
        assert body["total"] == 1
        assert len(body["images"]) == 1
        img = body["images"][0]
        assert img["url"].startswith("https://test-bucket.s3.amazonaws.com/")
        assert img["width"] == 800
        assert img["height"] == 600
        assert img["format"] == "JPEG"
        assert img["size_bytes"] > 0

        # Verify S3 mock was called
        assert len(mock_s3_operations["uploaded"]) >= 1

    async def test_upload_multiple_images(self, client, cleanup_database, mock_s3_operations):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        img1 = make_test_image()
        img2 = make_test_png()
        resp = await client.post(
            "/upload/images",
            files=[
                ("files", ("room1.jpg", img1, "image/jpeg")),
                ("files", ("room2.png", img2, "image/png")),
            ],
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 201
        body = resp.json()
        assert body["total"] == 2

    async def test_upload_requires_auth(self, client):
        image_data = make_test_image()
        resp = await client.post(
            "/upload/images",
            files=[("files", ("room.jpg", image_data, "image/jpeg"))],
        )
        assert resp.status_code == 401

    async def test_upload_non_hotel_user_forbidden(self, client, cleanup_database):
        user = await create_test_user(user_type="creator")
        image_data = make_test_image()
        resp = await client.post(
            "/upload/images",
            files=[("files", ("room.jpg", image_data, "image/jpeg"))],
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 403

    async def test_upload_invalid_file(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        resp = await client.post(
            "/upload/images",
            files=[("files", ("bad.txt", b"not an image", "text/plain"))],
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 400

    async def test_upload_thumbnail_generated(self, client, cleanup_database, mock_s3_operations):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        image_data = make_test_image(1200, 900)
        resp = await client.post(
            "/upload/images",
            files=[("files", ("big.jpg", image_data, "image/jpeg"))],
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 201
        img = resp.json()["images"][0]
        # Thumbnail should be generated (url present)
        assert img["thumbnail_url"] is not None
        assert (
            "thumb" in [u["key"] for u in mock_s3_operations["uploaded"] if "thumb" in u["key"]][0]
        )

    async def test_upload_large_image_resized(self, client, cleanup_database, mock_s3_operations):
        """Phone-sized images over 4000px get resized down instead of rejected."""
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        image_data = make_test_image(4032, 3024)
        resp = await client.post(
            "/upload/images",
            files=[("files", ("huge.jpg", image_data, "image/jpeg"))],
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 201
        img = resp.json()["images"][0]
        # Should have been resized — width or height should be <= 1920
        assert img["width"] <= 1920
        assert img["height"] <= 1920
