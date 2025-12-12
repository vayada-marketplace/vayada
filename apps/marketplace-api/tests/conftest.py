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


def get_token_for_user(user_id: str) -> str:
    """Helper function to get JWT token for a user_id (for use in tests)"""
    from app.jwt_utils import create_access_token
    from app.database import Database
    import asyncio
    
    async def _get_token():
        user = await Database.fetchrow(
            "SELECT id, email, type FROM users WHERE id = $1",
            user_id
        )
        if not user:
            return None
        return create_access_token(
            data={"sub": str(user['id']), "email": user['email'], "type": user['type']}
        )
    
    return asyncio.run(_get_token())


@pytest.fixture
def auth_headers(test_user):
    """Get authentication headers with JWT token for test_user"""
    token = get_token_for_user(test_user)
    if not token:
        return {}
    return {"Authorization": f"Bearer {token}"}


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
        "DELETE FROM users WHERE id = $1",
        user['id']
    )


@pytest.fixture
async def test_creator_user(db_setup):
    """Create a test creator user with profile and return user_id"""
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
    
    # Create creator profile
    await Database.execute(
        """
        INSERT INTO creators (user_id, location, short_description)
        VALUES ($1, NULL, NULL)
        """,
        user['id']
    )
    
    yield str(user['id'])
    
    # Cleanup
    await Database.execute(
        "DELETE FROM users WHERE id = $1",
        user['id']
    )


@pytest.fixture
async def test_hotel_user(db_setup):
    """Create a test hotel user with profile and return user_id"""
    from app.database import Database
    import bcrypt
    import uuid
    
    test_email = f"test_hotel_{uuid.uuid4().hex[:8]}@test.com"
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
        "Test Hotel",
        "hotel"
    )
    
    # Create hotel profile with defaults
    await Database.execute(
        """
        INSERT INTO hotel_profiles (user_id, name, location)
        VALUES ($1, $2, 'Not specified')
        """,
        user['id'],
        user['name']
    )
    
    yield str(user['id'])
    
    # Cleanup
    await Database.execute(
        "DELETE FROM users WHERE id = $1",
        user['id']
    )


def get_auth_headers_for_user(user_id: str) -> dict:
    """Get authentication headers for a specific user_id"""
    token = get_token_for_user(user_id)
    if not token:
        return {}
    return {"Authorization": f"Bearer {token}"}



