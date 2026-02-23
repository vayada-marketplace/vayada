"""
Pytest fixtures and configuration for booking engine backend tests.
"""
import os

# Set environment variables BEFORE importing any app modules
os.environ.setdefault("DATABASE_URL", "postgresql://vayada_booking_user:vayada_booking_password@localhost:5434/vayada_booking_db")
os.environ.setdefault("AUTH_DATABASE_URL", "postgresql://vayada_auth_user:vayada_auth_password@localhost:5435/vayada_auth_db")
os.environ.setdefault("MARKETPLACE_DATABASE_URL", "")
os.environ.setdefault("CORS_ORIGINS", "http://localhost:3000,http://localhost:3003")
os.environ.setdefault("JWT_SECRET_KEY", "test-secret-key-for-testing-only")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("ENVIRONMENT", "test")

import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import AsyncGenerator, Dict, Optional
from unittest.mock import patch

import bcrypt
import jwt
import pytest
from httpx import ASGITransport, AsyncClient

from app.config import settings
from app.database import AuthDatabase, Database
from app.main import app

# Test data patterns for cleanup
TEST_EMAIL_PATTERN = "betest%@example.com"
TEST_SLUG_PATTERN = "betest-%"


@pytest.fixture(scope="session")
async def init_database():
    """Initialize database pools for tests."""
    await Database.get_pool()
    await AuthDatabase.get_pool()
    yield
    await AuthDatabase.close_pool()
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
    Deletes in FK-safe order:
      1. booking_hotels by user_id or slug pattern (translations cascade via FK)
      2. consent_history, password_reset_tokens, users by email pattern
    """
    yield

    # Get test user IDs from auth DB
    auth_pool = await AuthDatabase.get_pool()
    async with auth_pool.acquire() as conn:
        test_users = await conn.fetch(
            "SELECT id FROM users WHERE email LIKE $1", TEST_EMAIL_PATTERN
        )
    test_user_ids = [row["id"] for row in test_users]

    # Delete booking_hotels by user_id (translations cascade via FK)
    if test_user_ids:
        for uid in test_user_ids:
            await Database.execute(
                "DELETE FROM booking_hotels WHERE user_id = $1", uid
            )

    # Also delete any booking_hotels matching slug pattern
    await Database.execute(
        "DELETE FROM booking_hotels WHERE slug LIKE $1", TEST_SLUG_PATTERN
    )

    # Clean auth data
    if test_user_ids:
        async with auth_pool.acquire() as conn:
            for uid in test_user_ids:
                await conn.execute(
                    "DELETE FROM consent_history WHERE user_id = $1", uid
                )
                await conn.execute(
                    "DELETE FROM password_reset_tokens WHERE user_id = $1", uid
                )
            await conn.execute(
                "DELETE FROM users WHERE email LIKE $1", TEST_EMAIL_PATTERN
            )


@pytest.fixture(autouse=True)
def mock_exchange_rate_service():
    """Mock exchange rate API calls to avoid external HTTP requests."""
    mock_rates = {
        "EUR": {"USD": 1.08, "GBP": 0.86, "CHF": 0.95, "JPY": 162.5},
        "USD": {"EUR": 0.93, "GBP": 0.80, "CHF": 0.88, "JPY": 150.0},
    }

    async def mock_get_rates(base: str) -> dict:
        base = base.upper()
        return mock_rates.get(base, {"USD": 1.08, "GBP": 0.86})

    with patch("app.routers.hotels.get_rates", side_effect=mock_get_rates):
        yield


# ── Helper functions ──────────────────────────────────────────────


def generate_test_email(prefix: str = "betest") -> str:
    return f"{prefix}_{uuid.uuid4().hex[:8]}@example.com"


def generate_test_slug(prefix: str = "betest") -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def create_jwt_token(
    user_id: str, email: str = "test@example.com", user_type: str = "hotel"
) -> str:
    """Create a JWT token matching what the booking engine issues."""
    from app.jwt_utils import create_access_token

    return create_access_token(
        data={"sub": user_id, "email": email, "type": user_type}
    )


def create_expired_jwt_token(
    user_id: str = "00000000-0000-0000-0000-000000000000",
    email: str = "expired@example.com",
) -> str:
    """Create an expired JWT token using raw PyJWT."""
    payload = {
        "sub": user_id,
        "email": email,
        "type": "hotel",
        "exp": datetime.now(timezone.utc) - timedelta(hours=1),
        "iat": datetime.now(timezone.utc) - timedelta(hours=2),
    }
    return jwt.encode(payload, settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM)


def get_auth_headers(token: str) -> Dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


# ── Factory functions ─────────────────────────────────────────────


async def create_test_user(
    email: Optional[str] = None,
    password: str = "TestPassword123!",
    name: str = "Test Hotel User",
    user_type: str = "hotel",
    user_status: str = "verified",
) -> Dict:
    """Create a test user in the auth database."""
    email = email or generate_test_email()
    password_hash = hash_password(password)

    user = await AuthDatabase.fetchrow(
        """
        INSERT INTO users (email, password_hash, name, type, status, email_verified)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, email, name, type, status
        """,
        email,
        password_hash,
        name,
        user_type,
        user_status,
        user_status == "verified",
    )
    user = dict(user)
    user["token"] = create_jwt_token(str(user["id"]), user["email"], user["type"])
    user["password"] = password
    return user


async def create_test_booking_hotel(
    user_id: str,
    name: str = "Test Hotel",
    slug: Optional[str] = None,
    description: str = "A test hotel description",
    location: str = "Test City",
    country: str = "Test Country",
    star_rating: int = 4,
    currency: str = "USD",
    hero_image: str = "https://example.com/hero.jpg",
    contact_email: str = "hotel@test.com",
    contact_phone: str = "+1234567890",
    contact_address: str = "123 Test Street",
    timezone_val: str = "Europe/Berlin",
    branding_primary_color: str = "#336699",
    branding_accent_color: str = "#FF6600",
    branding_font_pairing: str = "Inter / Merriweather",
) -> Dict:
    """Create a booking hotel in the booking database with all required columns."""
    slug = slug or generate_test_slug()
    row = await Database.fetchrow(
        """
        INSERT INTO booking_hotels (
            name, slug, description, location, country, star_rating,
            currency, hero_image, images, amenities,
            check_in_time, check_out_time,
            contact_address, contact_phone, contact_email, contact_whatsapp,
            branding_primary_color, branding_accent_color, branding_font_pairing,
            branding_logo_url, branding_favicon_url,
            user_id, timezone, supported_languages, supported_currencies
        ) VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9::jsonb, $10::jsonb,
            $11, $12,
            $13, $14, $15, $16,
            $17, $18, $19,
            $20, $21,
            $22, $23, $24::jsonb, $25::jsonb
        ) RETURNING *
        """,
        name,
        slug,
        description,
        location,
        country,
        star_rating,
        currency,
        hero_image,
        json.dumps([]),
        json.dumps(["WiFi", "Pool"]),
        "15:00",
        "11:00",
        contact_address,
        contact_phone,
        contact_email,
        "",
        branding_primary_color,
        branding_accent_color,
        branding_font_pairing,
        None,
        None,
        user_id,
        timezone_val,
        json.dumps(["en"]),
        json.dumps(["EUR", "USD"]),
    )
    return dict(row)


# ── Composite fixtures ────────────────────────────────────────────


@pytest.fixture
async def hotel_user(cleanup_database):
    """Create a hotel-type user in auth DB."""
    return await create_test_user()


@pytest.fixture
async def hotel_with_property(cleanup_database):
    """Create a user + booking_hotel (fully populated)."""
    user = await create_test_user()
    hotel = await create_test_booking_hotel(str(user["id"]))
    return {"user": user, "hotel": hotel}
