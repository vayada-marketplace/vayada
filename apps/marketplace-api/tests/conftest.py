"""
Pytest configuration and fixtures
"""
import pytest
import os
from httpx import AsyncClient
from app.main import app
from app.database import Database
from app.config import settings


# Set test environment variables if not already set
# Try to use the same user as docker-compose, fallback to postgres
test_db_url = os.getenv(
    "TEST_DATABASE_URL", 
    os.getenv(
        "DATABASE_URL",
        "postgresql://vayada_user:vayada_password@localhost:5432/vayada_test_db"
    ).replace("/vayada_db", "/vayada_test_db")
)
os.environ.setdefault("DATABASE_URL", test_db_url)
os.environ.setdefault("CORS_ORIGINS", os.getenv("TEST_CORS_ORIGINS", "http://localhost:3000,http://localhost:3001"))
os.environ.setdefault("EMAIL_ENABLED", "true")  # Enable email but it will be mocked
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("JWT_SECRET_KEY", "test-secret-key-for-testing-only")
os.environ.setdefault("FRONTEND_URL", "http://localhost:3000")


@pytest.fixture(scope="function")
async def client():
    """Create a test client"""
    async with AsyncClient(app=app, base_url="http://test") as ac:
        yield ac


@pytest.fixture(scope="function", autouse=True)
async def cleanup_database():
    """Clean up test data before and after each test"""
    # Cleanup before test
    await _cleanup_test_data()
    
    yield
    
    # Cleanup after test
    await _cleanup_test_data()


async def _cleanup_test_data():
    """Remove test data from database"""
    try:
        # Delete email verification codes
        await Database.execute(
            "DELETE FROM email_verification_codes WHERE email LIKE 'test%@example.com'"
        )
        
        # Delete password reset tokens
        await Database.execute(
            """
            DELETE FROM password_reset_tokens 
            WHERE user_id IN (
                SELECT id FROM users WHERE email LIKE 'test%@example.com'
            )
            """
        )
        
        # Delete users (this will cascade to related tables)
        await Database.execute(
            "DELETE FROM users WHERE email LIKE 'test%@example.com'"
        )
    except Exception as e:
        # Ignore errors during cleanup (database might not be connected)
        pass


@pytest.fixture
def mock_send_email(monkeypatch):
    """Mock the send_email function to avoid actually sending emails"""
    sent_emails = []
    
    async def mock_send_email_func(to_email: str, subject: str, html_body: str, text_body=None):
        sent_emails.append({
            "to_email": to_email,
            "subject": subject,
            "html_body": html_body,
            "text_body": text_body
        })
        return True
    
    # Apply mock to the email_service module
    # This needs to be done before the router imports it
    import app.email_service
    monkeypatch.setattr(app.email_service, "send_email", mock_send_email_func)
    
    # Also need to patch it in the router module if it's imported there
    try:
        import app.routers.auth
        if hasattr(app.routers.auth, 'send_email'):
            monkeypatch.setattr(app.routers.auth, "send_email", mock_send_email_func)
    except:
        pass
    
    return sent_emails


@pytest.fixture(scope="session")
def event_loop():
    """Create an instance of the default event loop for the test session."""
    import asyncio
    loop = asyncio.get_event_loop_policy().new_event_loop()
    yield loop
    loop.close()


@pytest.fixture(scope="session", autouse=True)
async def setup_test_database(event_loop):
    """Setup test database connection pool"""
    # Initialize database pool
    await Database.get_pool()
    yield
    # Cleanup
    await Database.close_pool()

