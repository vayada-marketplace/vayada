"""
Tests for file upload endpoints.
"""
import pytest
from httpx import AsyncClient
from io import BytesIO
from PIL import Image

from tests.conftest import get_auth_headers


def create_test_image(
    width: int = 100,
    height: int = 100,
    format: str = "JPEG"
) -> bytes:
    """Create a test image file."""
    img = Image.new("RGB", (width, height), color="red")
    buffer = BytesIO()
    img.save(buffer, format=format)
    buffer.seek(0)
    return buffer.getvalue()


def create_invalid_file(content: bytes = b"not an image") -> bytes:
    """Create an invalid file (not an image)."""
    return content


class TestUploadImage:
    """Tests for POST /upload/image"""

    async def test_upload_jpeg_success(
        self, client: AsyncClient, test_creator, mock_s3_upload
    ):
        """Test uploading a JPEG image."""
        image_data = create_test_image(format="JPEG")

        response = await client.post(
            "/upload/image",
            files={"file": ("test.jpg", image_data, "image/jpeg")},
            headers=get_auth_headers(test_creator["token"])
        )

        assert response.status_code == 201
        data = response.json()
        assert "url" in data
        assert "key" in data
        assert data["format"] in ["JPEG", "jpeg"]

    async def test_upload_png_success(
        self, client: AsyncClient, test_creator, mock_s3_upload
    ):
        """Test uploading a PNG image."""
        image_data = create_test_image(format="PNG")

        response = await client.post(
            "/upload/image",
            files={"file": ("test.png", image_data, "image/png")},
            headers=get_auth_headers(test_creator["token"])
        )

        assert response.status_code == 201
        data = response.json()
        assert "url" in data

    async def test_upload_webp_success(
        self, client: AsyncClient, test_creator, mock_s3_upload
    ):
        """Test uploading a WEBP image."""
        image_data = create_test_image(format="WEBP")

        response = await client.post(
            "/upload/image",
            files={"file": ("test.webp", image_data, "image/webp")},
            headers=get_auth_headers(test_creator["token"])
        )

        assert response.status_code == 201
        data = response.json()
        assert "url" in data

    async def test_upload_invalid_format(
        self, client: AsyncClient, test_creator
    ):
        """Test uploading file with invalid format."""
        invalid_file = create_invalid_file()

        response = await client.post(
            "/upload/image",
            files={"file": ("test.txt", invalid_file, "text/plain")},
            headers=get_auth_headers(test_creator["token"])
        )

        assert response.status_code == 400

    async def test_upload_empty_file(
        self, client: AsyncClient, test_creator
    ):
        """Test uploading empty file."""
        response = await client.post(
            "/upload/image",
            files={"file": ("empty.jpg", b"", "image/jpeg")},
            headers=get_auth_headers(test_creator["token"])
        )

        assert response.status_code == 400

    async def test_upload_no_auth(
        self, client: AsyncClient
    ):
        """Test uploading without authentication."""
        image_data = create_test_image()

        response = await client.post(
            "/upload/image",
            files={"file": ("test.jpg", image_data, "image/jpeg")}
        )

        assert response.status_code == 403

    async def test_upload_with_prefix(
        self, client: AsyncClient, test_creator, mock_s3_upload
    ):
        """Test uploading with custom prefix."""
        image_data = create_test_image()

        response = await client.post(
            "/upload/image",
            files={"file": ("test.jpg", image_data, "image/jpeg")},
            params={"prefix": "custom-prefix"},
            headers=get_auth_headers(test_creator["token"])
        )

        assert response.status_code == 201
        data = response.json()
        assert "custom-prefix" in data["key"]


class TestUploadMultipleImages:
    """Tests for POST /upload/images"""

    async def test_upload_multiple_success(
        self, client: AsyncClient, test_creator, mock_s3_upload
    ):
        """Test uploading multiple images."""
        image1 = create_test_image()
        image2 = create_test_image()

        response = await client.post(
            "/upload/images",
            files=[
                ("files", ("test1.jpg", image1, "image/jpeg")),
                ("files", ("test2.jpg", image2, "image/jpeg"))
            ],
            headers=get_auth_headers(test_creator["token"])
        )

        assert response.status_code == 201
        data = response.json()
        assert "images" in data
        assert data["total"] == 2
        assert len(data["images"]) == 2

    async def test_upload_multiple_partial_success(
        self, client: AsyncClient, test_creator, mock_s3_upload
    ):
        """Test uploading multiple images with some invalid."""
        valid_image = create_test_image()
        invalid_file = create_invalid_file()

        response = await client.post(
            "/upload/images",
            files=[
                ("files", ("valid.jpg", valid_image, "image/jpeg")),
                ("files", ("invalid.txt", invalid_file, "text/plain"))
            ],
            headers=get_auth_headers(test_creator["token"])
        )

        assert response.status_code == 201
        data = response.json()
        # Only valid image should be uploaded
        assert data["total"] == 1

    async def test_upload_multiple_no_files(
        self, client: AsyncClient, test_creator
    ):
        """Test uploading with no files."""
        response = await client.post(
            "/upload/images",
            files=[],
            headers=get_auth_headers(test_creator["token"])
        )

        # Should fail validation
        assert response.status_code in [400, 422]

    async def test_upload_multiple_all_invalid(
        self, client: AsyncClient, test_creator
    ):
        """Test uploading multiple invalid files."""
        invalid1 = create_invalid_file(b"not image 1")
        invalid2 = create_invalid_file(b"not image 2")

        response = await client.post(
            "/upload/images",
            files=[
                ("files", ("invalid1.txt", invalid1, "text/plain")),
                ("files", ("invalid2.txt", invalid2, "text/plain"))
            ],
            headers=get_auth_headers(test_creator["token"])
        )

        assert response.status_code == 400


class TestUploadHotelProfileImage:
    """Tests for POST /upload/image/hotel-profile"""

    async def test_upload_hotel_profile_success(
        self, client: AsyncClient, test_hotel, mock_s3_upload
    ):
        """Test uploading hotel profile image."""
        image_data = create_test_image()

        response = await client.post(
            "/upload/image/hotel-profile",
            files={"file": ("hotel.jpg", image_data, "image/jpeg")},
            headers=get_auth_headers(test_hotel["token"])
        )

        assert response.status_code == 201
        data = response.json()
        assert "hotels" in data["key"]

    async def test_upload_hotel_profile_no_auth(
        self, client: AsyncClient
    ):
        """Test uploading hotel profile image without auth."""
        image_data = create_test_image()

        response = await client.post(
            "/upload/image/hotel-profile",
            files={"file": ("hotel.jpg", image_data, "image/jpeg")}
        )

        assert response.status_code == 403


class TestUploadListingImage:
    """Tests for POST /upload/image/listing"""

    async def test_upload_listing_image_success(
        self, client: AsyncClient, test_hotel, mock_s3_upload
    ):
        """Test uploading listing image."""
        image_data = create_test_image()

        response = await client.post(
            "/upload/image/listing",
            files={"file": ("listing.jpg", image_data, "image/jpeg")},
            headers=get_auth_headers(test_hotel["token"])
        )

        assert response.status_code == 201
        data = response.json()
        assert "listings" in data["key"]

    async def test_upload_listing_image_no_auth(
        self, client: AsyncClient
    ):
        """Test uploading listing image without auth."""
        image_data = create_test_image()

        response = await client.post(
            "/upload/image/listing",
            files={"file": ("listing.jpg", image_data, "image/jpeg")}
        )

        assert response.status_code == 403


class TestUploadListingImages:
    """Tests for POST /upload/images/listing"""

    async def test_upload_listing_images_success(
        self, client: AsyncClient, test_hotel, mock_s3_upload
    ):
        """Test uploading multiple listing images."""
        image1 = create_test_image()
        image2 = create_test_image()

        response = await client.post(
            "/upload/images/listing",
            files=[
                ("files", ("listing1.jpg", image1, "image/jpeg")),
                ("files", ("listing2.jpg", image2, "image/jpeg"))
            ],
            headers=get_auth_headers(test_hotel["token"])
        )

        assert response.status_code == 201
        data = response.json()
        assert data["total"] == 2
        for img in data["images"]:
            assert "listings" in img["key"]

    async def test_upload_listing_images_with_target_user(
        self, client: AsyncClient, test_admin, test_hotel, mock_s3_upload
    ):
        """Test admin uploading listing images for another user."""
        image_data = create_test_image()
        target_user_id = str(test_hotel["user"]["id"])

        response = await client.post(
            f"/upload/images/listing?target_user_id={target_user_id}",
            files=[("files", ("listing.jpg", image_data, "image/jpeg"))],
            headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 201
        data = response.json()
        # Key should contain target user ID
        assert target_user_id in data["images"][0]["key"]


class TestUploadCreatorProfileImage:
    """Tests for POST /upload/image/creator-profile"""

    async def test_upload_creator_profile_success(
        self, client: AsyncClient, test_creator, mock_s3_upload
    ):
        """Test uploading creator profile image."""
        image_data = create_test_image()

        response = await client.post(
            "/upload/image/creator-profile",
            files={"file": ("profile.jpg", image_data, "image/jpeg")},
            headers=get_auth_headers(test_creator["token"])
        )

        assert response.status_code == 201
        data = response.json()
        assert "creators" in data["key"]

    async def test_upload_creator_profile_with_target_user(
        self, client: AsyncClient, test_admin, test_creator, mock_s3_upload
    ):
        """Test admin uploading creator profile image for another user."""
        image_data = create_test_image()
        target_user_id = str(test_creator["user"]["id"])

        response = await client.post(
            f"/upload/image/creator-profile?target_user_id={target_user_id}",
            files={"file": ("profile.jpg", image_data, "image/jpeg")},
            headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 201
        data = response.json()
        assert target_user_id in data["key"]


class TestS3Configuration:
    """Tests for S3 configuration requirements"""

    async def test_upload_requires_s3_config(
        self, client: AsyncClient, test_creator
    ):
        """Test that upload fails gracefully when S3 is not configured."""
        from unittest.mock import patch

        image_data = create_test_image()

        # Mock settings to have empty S3 bucket name
        with patch("app.routers.upload.settings") as mock_settings:
            mock_settings.S3_BUCKET_NAME = ""

            response = await client.post(
                "/upload/image",
                files={"file": ("test.jpg", image_data, "image/jpeg")},
                headers=get_auth_headers(test_creator["token"])
            )

            assert response.status_code == 503
            assert "s3" in response.json()["detail"].lower()


class TestImageValidation:
    """Tests for image validation"""

    async def test_upload_returns_image_dimensions(
        self, client: AsyncClient, test_creator, mock_s3_upload
    ):
        """Test that upload returns image dimensions."""
        image_data = create_test_image(width=800, height=600)

        response = await client.post(
            "/upload/image",
            files={"file": ("test.jpg", image_data, "image/jpeg")},
            headers=get_auth_headers(test_creator["token"])
        )

        assert response.status_code == 201
        data = response.json()
        assert "width" in data
        assert "height" in data
        assert "size_bytes" in data

    async def test_upload_corrupted_image(
        self, client: AsyncClient, test_creator
    ):
        """Test uploading corrupted image file."""
        # Create corrupted JPEG-like data
        corrupted_data = b"\xff\xd8\xff" + b"corrupted_data_here"

        response = await client.post(
            "/upload/image",
            files={"file": ("corrupted.jpg", corrupted_data, "image/jpeg")},
            headers=get_auth_headers(test_creator["token"])
        )

        assert response.status_code == 400
