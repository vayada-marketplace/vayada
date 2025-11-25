"""
Pytest configuration and fixtures
"""
import pytest
import asyncio
from httpx import AsyncClient
from fastapi.testclient import TestClient
from app.main import app
from app.database import Database
import os


@pytest.fixture(scope="session")
def event_loop():
    """Create an instance of the default event loop for the test session."""
    loop = asyncio.get_event_loop_policy().new_event_loop()
    yield loop
    loop.close()


@pytest.fixture(scope="session")
async def db_setup():
    """Setup database connection for tests"""
    await Database.get_pool()
    yield
    await Database.close_pool()


@pytest.fixture
def client(db_setup):
    """Create a test client"""
    return TestClient(app)


@pytest.fixture
async def async_client(db_setup):
    """Create an async test client"""
    async with AsyncClient(app=app, base_url="http://test") as ac:
        yield ac


@pytest.fixture
async def test_user(db_setup):
    """Create a test user and return user_id"""
    from app.database import Database
    import bcrypt
    import uuid
    
    test_email = f"test_creator_{uuid.uuid4().hex[:8]}@test.com"
    password_hash = bcrypt.hashpw("testpassword123".encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
    
    # Clean up if exists
    await Database.execute(
        "DELETE FROM users WHERE email = $1",
        test_email
    )
    
    # Create user
    user = await Database.fetchrow(
        """
        INSERT INTO users (email, password_hash, name, type, status)
        VALUES ($1, $2, $3, $4, 'verified')
        RETURNING id, email, name, type
        """,
        test_email,
        password_hash,
        "Test Creator",
        "creator"
    )
    
    yield str(user['id'])
    
    # Cleanup
    await Database.execute(
        "DELETE FROM creator_platforms WHERE creator_id IN (SELECT id FROM creators WHERE user_id = $1)",
        user['id']
    )
    await Database.execute(
        "DELETE FROM creators WHERE user_id = $1",
        user['id']
    )
    await Database.execute(
        "DELETE FROM users WHERE id = $1",
        user['id']
    )


@pytest.fixture
async def test_creator_profile(test_user, db_setup):
    """Create a test creator profile"""
    from app.database import Database
    
    creator = await Database.fetchrow(
        """
        INSERT INTO creators (user_id, location, short_description)
        VALUES ($1, $2, $3)
        RETURNING id
        """,
        test_user,
        "Test Location",
        "Test description"
    )
    
    yield str(creator['id']), test_user
    
    # Cleanup is handled by test_user fixture

