"""
Pytest fixtures and configuration for Vayada backend tests.
"""
import os

# Set environment variables BEFORE importing any app modules
# These must be set before pydantic Settings loads
os.environ.setdefault("DATABASE_URL", "postgresql://vayada_user:vayada_password@localhost:5432/vayada_db")
os.environ.setdefault("CORS_ORIGINS", "http://localhost:3000,http://localhost:3001")
os.environ.setdefault("JWT_SECRET_KEY", "test-secret-key-for-testing-only")
os.environ.setdefault("EMAIL_ENABLED", "true")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("ENVIRONMENT", "test")
# S3 configuration for tests - required for upload endpoints to not return 503
os.environ.setdefault("S3_BUCKET_NAME", "test-bucket")
os.environ.setdefault("AWS_REGION", "us-east-1")
os.environ.setdefault("AWS_ACCESS_KEY_ID", "test-access-key")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "test-secret-key")

import pytest
import asyncio
from datetime import datetime, timedelta
from typing import AsyncGenerator, Dict, Optional
from unittest.mock import AsyncMock, patch, MagicMock
import uuid
import bcrypt

from httpx import AsyncClient, ASGITransport

from app.main import app
from app.database import Database
from app.jwt_utils import create_access_token
from app.config import settings


# Test data patterns for cleanup
TEST_EMAIL_PATTERN = "test%@example.com"


@pytest.fixture(scope="session")
def event_loop():
    """Create event loop for session."""
    loop = asyncio.get_event_loop_policy().new_event_loop()
    yield loop
    loop.close()


@pytest.fixture(scope="session")
async def init_database():
    """Initialize database pool for tests."""
    await Database.get_pool()
    yield
    await Database.close_pool()


@pytest.fixture
async def client(init_database) -> AsyncGenerator[AsyncClient, None]:
    """Create an async HTTP client for testing."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


@pytest.fixture
async def cleanup_database(init_database):
    """
    Cleanup test data after each test.
    Respects foreign key constraints by deleting in correct order.
    """
    yield

    # Cleanup order respects foreign keys
    await Database.execute(
        "DELETE FROM chat_messages WHERE collaboration_id IN "
        "(SELECT id FROM collaborations WHERE creator_id IN "
        "(SELECT id FROM creators WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)))",
        TEST_EMAIL_PATTERN
    )
    await Database.execute(
        "DELETE FROM collaboration_deliverables WHERE collaboration_id IN "
        "(SELECT id FROM collaborations WHERE creator_id IN "
        "(SELECT id FROM creators WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)))",
        TEST_EMAIL_PATTERN
    )
    await Database.execute(
        "DELETE FROM collaborations WHERE creator_id IN "
        "(SELECT id FROM creators WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1))",
        TEST_EMAIL_PATTERN
    )
    await Database.execute(
        "DELETE FROM collaborations WHERE hotel_id IN "
        "(SELECT id FROM hotel_profiles WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1))",
        TEST_EMAIL_PATTERN
    )
    await Database.execute(
        "DELETE FROM listing_collaboration_offerings WHERE listing_id IN "
        "(SELECT id FROM hotel_listings WHERE hotel_profile_id IN "
        "(SELECT id FROM hotel_profiles WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)))",
        TEST_EMAIL_PATTERN
    )
    await Database.execute(
        "DELETE FROM listing_creator_requirements WHERE listing_id IN "
        "(SELECT id FROM hotel_listings WHERE hotel_profile_id IN "
        "(SELECT id FROM hotel_profiles WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)))",
        TEST_EMAIL_PATTERN
    )
    await Database.execute(
        "DELETE FROM hotel_listings WHERE hotel_profile_id IN "
        "(SELECT id FROM hotel_profiles WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1))",
        TEST_EMAIL_PATTERN
    )
    await Database.execute(
        "DELETE FROM creator_platforms WHERE creator_id IN "
        "(SELECT id FROM creators WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1))",
        TEST_EMAIL_PATTERN
    )
    await Database.execute(
        "DELETE FROM creator_ratings WHERE creator_id IN "
        "(SELECT id FROM creators WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1))",
        TEST_EMAIL_PATTERN
    )
    await Database.execute(
        "DELETE FROM creators WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)",
        TEST_EMAIL_PATTERN
    )
    await Database.execute(
        "DELETE FROM hotel_profiles WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)",
        TEST_EMAIL_PATTERN
    )
    await Database.execute(
        "DELETE FROM password_reset_tokens WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)",
        TEST_EMAIL_PATTERN
    )
    await Database.execute(
        "DELETE FROM email_verification_codes WHERE email LIKE $1",
        TEST_EMAIL_PATTERN
    )
    await Database.execute(
        "DELETE FROM email_verification_tokens WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)",
        TEST_EMAIL_PATTERN
    )
    await Database.execute("DELETE FROM users WHERE email LIKE $1", TEST_EMAIL_PATTERN)


@pytest.fixture(autouse=True)
def mock_send_email():
    """Mock email service to track sent emails. Applied to all tests automatically."""
    sent_emails = []

    async def mock_email(to_email: str, subject: str, html_body: str):
        sent_emails.append({
            "to": to_email,
            "subject": subject,
            "body": html_body
        })
        return True

    with patch("app.email_service.send_email", side_effect=mock_email):
        yield sent_emails


@pytest.fixture(autouse=True)
def mock_s3_operations():
    """Mock all S3 operations. Applied to all tests automatically."""
    uploaded_files = []
    deleted_files = []
    listed_files = []

    async def mock_upload(file_content: bytes, file_key: str, content_type: str = "image/jpeg", make_public: bool = True):
        uploaded_files.append({
            "content_length": len(file_content),
            "key": file_key,
            "content_type": content_type
        })
        return f"https://test-bucket.s3.amazonaws.com/{file_key}"

    async def mock_delete(file_key: str):
        deleted_files.append(file_key)
        return True

    async def mock_list_prefix(prefix: str):
        listed_files.append(prefix)
        return []  # Return empty list - no files to delete

    async def mock_delete_prefix(prefix: str):
        deleted_files.append(f"prefix:{prefix}")
        return {"deleted_count": 0, "failed_count": 0, "total_objects": 0}

    # Patch at both source module AND where functions are imported in routers
    # This is necessary because `from module import func` binds func locally
    with patch("app.s3_service.upload_file_to_s3", side_effect=mock_upload), \
         patch("app.s3_service.delete_file_from_s3", side_effect=mock_delete), \
         patch("app.s3_service.list_objects_in_prefix", side_effect=mock_list_prefix), \
         patch("app.s3_service.delete_all_objects_in_prefix", side_effect=mock_delete_prefix), \
         patch("app.routers.upload.upload_file_to_s3", side_effect=mock_upload), \
         patch("app.routers.hotels.upload_file_to_s3", side_effect=mock_upload), \
         patch("app.routers.admin.delete_file_from_s3", side_effect=mock_delete), \
         patch("app.routers.admin.delete_all_objects_in_prefix", side_effect=mock_delete_prefix):
        yield {"uploaded": uploaded_files, "deleted": deleted_files, "listed": listed_files}


# User factory helpers

def generate_test_email(prefix: str = "test") -> str:
    """Generate a unique test email."""
    return f"{prefix}_{uuid.uuid4().hex[:8]}@example.com"


def hash_password(password: str) -> str:
    """Hash a password for testing."""
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


async def create_test_user(
    email: Optional[str] = None,
    password: str = "TestPassword123!",
    name: str = "Test User",
    user_type: str = "creator",
    status: str = "verified",
    email_verified: bool = False
) -> Dict:
    """Create a test user in the database."""
    email = email or generate_test_email()
    password_hash = hash_password(password)

    user = await Database.fetchrow(
        """
        INSERT INTO users (email, password_hash, name, type, status, email_verified)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, email, name, type, status, email_verified, created_at
        """,
        email, password_hash, name, user_type, status, email_verified
    )

    return dict(user)


async def create_test_creator(
    email: Optional[str] = None,
    password: str = "TestPassword123!",
    name: str = "Test Creator",
    status: str = "verified",
    location: str = "New York, USA",
    short_description: str = "Test creator description",
    profile_complete: bool = False
) -> Dict:
    """Create a test creator user with profile."""
    user = await create_test_user(
        email=email,
        password=password,
        name=name,
        user_type="creator",
        status=status
    )

    creator = await Database.fetchrow(
        """
        INSERT INTO creators (user_id, location, short_description, profile_complete)
        VALUES ($1, $2, $3, $4)
        RETURNING id, user_id, location, short_description, profile_complete
        """,
        user["id"], location, short_description, profile_complete
    )

    return {
        "user": user,
        "creator": dict(creator),
        "password": password,
        "token": create_access_token({"sub": str(user["id"]), "email": user["email"], "type": "creator"})
    }


async def create_test_hotel(
    email: Optional[str] = None,
    password: str = "TestPassword123!",
    name: str = "Test Hotel",
    status: str = "verified",
    hotel_name: str = "Grand Test Hotel",
    location: str = "Paris, France",
    about: str = "A luxury test hotel with amazing amenities and service",
    website: str = "https://grandtesthotel.com",
    profile_complete: bool = False
) -> Dict:
    """Create a test hotel user with profile."""
    user = await create_test_user(
        email=email,
        password=password,
        name=name,
        user_type="hotel",
        status=status
    )

    hotel = await Database.fetchrow(
        """
        INSERT INTO hotel_profiles (user_id, name, location, about, website, profile_complete)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, user_id, name, location, about, website, profile_complete
        """,
        user["id"], hotel_name, location, about, website, profile_complete
    )

    return {
        "user": user,
        "hotel": dict(hotel),
        "password": password,
        "token": create_access_token({"sub": str(user["id"]), "email": user["email"], "type": "hotel"})
    }


async def create_test_admin(
    email: Optional[str] = None,
    password: str = "AdminPassword123!",
    name: str = "Test Admin"
) -> Dict:
    """Create a test admin user."""
    user = await create_test_user(
        email=email,
        password=password,
        name=name,
        user_type="admin",
        status="verified",
        email_verified=True
    )

    return {
        "user": user,
        "password": password,
        "token": create_access_token({"sub": str(user["id"]), "email": user["email"], "type": "admin"})
    }


async def create_test_listing(
    hotel_profile_id: str,
    name: str = "Beach Paradise Suite",
    location: str = "Maldives",
    description: str = "A beautiful beachfront suite",
    accommodation_type: str = "Luxury Hotel",
    images: list = None
) -> Dict:
    """Create a test hotel listing."""
    listing = await Database.fetchrow(
        """
        INSERT INTO hotel_listings (hotel_profile_id, name, location, description, accommodation_type, images)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, hotel_profile_id, name, location, description, accommodation_type, images, status, created_at
        """,
        hotel_profile_id, name, location, description, accommodation_type, images or []
    )

    # Create default collaboration offering
    offering = await Database.fetchrow(
        """
        INSERT INTO listing_collaboration_offerings
        (listing_id, collaboration_type, platforms, free_stay_min_nights, free_stay_max_nights)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, listing_id, collaboration_type, platforms, free_stay_min_nights, free_stay_max_nights
        """,
        listing["id"], "Free Stay", ["Instagram", "TikTok"], 3, 7
    )

    # Create default creator requirements
    requirements = await Database.fetchrow(
        """
        INSERT INTO listing_creator_requirements
        (listing_id, platforms, min_followers, target_countries, target_age_groups)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, listing_id, platforms, min_followers, target_countries, target_age_groups
        """,
        listing["id"], ["Instagram"], 10000, ["USA", "UK"], ["25-34", "35-44"]
    )

    return {
        "listing": dict(listing),
        "offering": dict(offering),
        "requirements": dict(requirements)
    }


async def create_test_platform(
    creator_id: str,
    name: str = "Instagram",
    handle: str = "@testcreator",
    followers: int = 50000,
    engagement_rate: float = 3.5
) -> Dict:
    """Create a test creator platform."""
    platform = await Database.fetchrow(
        """
        INSERT INTO creator_platforms (creator_id, name, handle, followers, engagement_rate)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, creator_id, name, handle, followers, engagement_rate
        """,
        creator_id, name, handle, followers, engagement_rate
    )

    return dict(platform)


async def create_test_collaboration(
    creator_id: str,
    hotel_id: str,
    listing_id: str,
    initiator_type: str = "creator",
    status: str = "pending",
    collaboration_type: str = "Free Stay",
    why_great_fit: str = "I love this hotel and would create amazing content!"
) -> Dict:
    """Create a test collaboration."""
    collaboration = await Database.fetchrow(
        """
        INSERT INTO collaborations
        (initiator_type, creator_id, hotel_id, listing_id, status, collaboration_type, why_great_fit,
         free_stay_min_nights, free_stay_max_nights)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *
        """,
        initiator_type, creator_id, hotel_id, listing_id, status, collaboration_type, why_great_fit, 3, 5
    )

    # Create default deliverables
    await Database.execute(
        """
        INSERT INTO collaboration_deliverables (collaboration_id, platform, type, quantity, status)
        VALUES ($1, $2, $3, $4, $5)
        """,
        collaboration["id"], "Instagram", "Reel", 2, "pending"
    )

    return dict(collaboration)


# Auth header helpers

def get_auth_headers(token: str) -> Dict[str, str]:
    """Generate authorization headers with Bearer token."""
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
async def test_creator(cleanup_database, init_database):
    """Create a test creator user with profile."""
    return await create_test_creator()


@pytest.fixture
async def test_creator_verified(cleanup_database, init_database):
    """Create a verified test creator user with complete profile and platforms."""
    creator_data = await create_test_creator(
        status="verified",
        profile_complete=True
    )

    # Add a platform
    platform = await create_test_platform(
        creator_id=str(creator_data["creator"]["id"]),
        name="Instagram",
        handle="@verified_creator",
        followers=100000,
        engagement_rate=4.5
    )
    creator_data["platform"] = platform

    return creator_data


@pytest.fixture
async def test_hotel(cleanup_database, init_database):
    """Create a test hotel user with profile."""
    return await create_test_hotel()


@pytest.fixture
async def test_hotel_verified(cleanup_database, init_database):
    """Create a verified test hotel user with complete profile and listing."""
    hotel_data = await create_test_hotel(
        status="verified",
        profile_complete=True
    )

    # Add a listing
    listing = await create_test_listing(
        hotel_profile_id=str(hotel_data["hotel"]["id"])
    )
    hotel_data["listing"] = listing

    return hotel_data


@pytest.fixture
async def test_admin(cleanup_database, init_database):
    """Create a test admin user."""
    return await create_test_admin()


@pytest.fixture
async def test_collaboration(test_creator_verified, test_hotel_verified, init_database):
    """Create a test collaboration between verified creator and hotel."""
    collaboration = await create_test_collaboration(
        creator_id=str(test_creator_verified["creator"]["id"]),
        hotel_id=str(test_hotel_verified["hotel"]["id"]),
        listing_id=str(test_hotel_verified["listing"]["listing"]["id"]),
        initiator_type="creator",
        status="pending"
    )

    return {
        "collaboration": collaboration,
        "creator": test_creator_verified,
        "hotel": test_hotel_verified
    }
