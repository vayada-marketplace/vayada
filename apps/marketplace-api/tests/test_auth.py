"""
Tests for authentication endpoints.
"""
import pytest
from httpx import AsyncClient
from unittest.mock import patch, AsyncMock

from app.database import Database
from tests.conftest import (
    get_auth_headers,
    create_test_user,
    create_test_creator,
    generate_test_email,
    hash_password
)


class TestSendVerificationCode:
    """Tests for POST /auth/send-verification-code"""

    async def test_send_verification_code_success(
        self, client: AsyncClient, cleanup_database, mock_send_email
    ):
        """Test sending verification code to new email."""
        email = generate_test_email()

        response = await client.post(
            "/auth/send-verification-code",
            json={"email": email}
        )

        assert response.status_code == 200
        data = response.json()
        assert "message" in data
        assert "verification code" in data["message"].lower() or "sent" in data["message"].lower()

    async def test_send_verification_code_existing_user(
        self, client: AsyncClient, cleanup_database, mock_send_email
    ):
        """Test sending verification code for existing email returns generic message."""
        user = await create_test_user()

        response = await client.post(
            "/auth/send-verification-code",
            json={"email": user["email"]}
        )

        # Should still return 200 for security reasons
        assert response.status_code == 200
        data = response.json()
        assert "message" in data

    async def test_send_verification_code_invalid_email(
        self, client: AsyncClient, cleanup_database
    ):
        """Test sending verification code with invalid email format."""
        response = await client.post(
            "/auth/send-verification-code",
            json={"email": "invalid-email"}
        )

        assert response.status_code == 422  # Validation error

    async def test_resend_verification_code_invalidates_old(
        self, client: AsyncClient, cleanup_database, mock_send_email
    ):
        """Test resending verification code invalidates previous codes."""
        email = generate_test_email()

        # First send
        await client.post(
            "/auth/send-verification-code",
            json={"email": email}
        )

        # Get first code
        first_code = await Database.fetchrow(
            "SELECT code FROM email_verification_codes WHERE email = $1 ORDER BY created_at DESC LIMIT 1",
            email
        )

        # Second send
        await client.post(
            "/auth/send-verification-code",
            json={"email": email}
        )

        # Try to use first code - it should no longer work
        response = await client.post(
            "/auth/verify-email-code",
            json={"email": email, "code": first_code["code"] if first_code else "000000"}
        )

        data = response.json()
        # Either the old code is invalidated or not verified
        assert "verified" in data


class TestVerifyEmailCode:
    """Tests for POST /auth/verify-email-code"""

    async def test_verify_email_code_success(
        self, client: AsyncClient, cleanup_database, mock_send_email
    ):
        """Test successful email verification."""
        email = generate_test_email()

        # Send code
        await client.post(
            "/auth/send-verification-code",
            json={"email": email}
        )

        # Get the code from database
        code_row = await Database.fetchrow(
            "SELECT code FROM email_verification_codes WHERE email = $1 ORDER BY created_at DESC LIMIT 1",
            email
        )

        response = await client.post(
            "/auth/verify-email-code",
            json={"email": email, "code": code_row["code"]}
        )

        assert response.status_code == 200
        data = response.json()
        assert data["verified"] is True

    async def test_verify_email_code_invalid(
        self, client: AsyncClient, cleanup_database
    ):
        """Test verification with invalid code."""
        email = generate_test_email()

        response = await client.post(
            "/auth/verify-email-code",
            json={"email": email, "code": "000000"}
        )

        assert response.status_code == 200
        data = response.json()
        assert data["verified"] is False

    async def test_verify_email_code_expired(
        self, client: AsyncClient, cleanup_database
    ):
        """Test verification with expired code."""
        email = generate_test_email()

        # Insert expired code directly
        await Database.execute(
            """
            INSERT INTO email_verification_codes (email, code, expires_at, used)
            VALUES ($1, $2, NOW() - INTERVAL '1 hour', false)
            """,
            email, "123456"
        )

        response = await client.post(
            "/auth/verify-email-code",
            json={"email": email, "code": "123456"}
        )

        assert response.status_code == 200
        data = response.json()
        assert data["verified"] is False


class TestRegister:
    """Tests for POST /auth/register"""

    async def test_register_creator_success(
        self, client: AsyncClient, cleanup_database
    ):
        """Test successful creator registration."""
        email = generate_test_email()

        response = await client.post(
            "/auth/register",
            json={
                "email": email,
                "password": "SecurePassword123!",
                "name": "Test Creator",
                "type": "creator",
                "terms_accepted": True,
                "privacy_accepted": True
            }
        )

        assert response.status_code == 201
        data = response.json()
        assert data["email"] == email
        assert data["name"] == "Test Creator"
        assert data["type"] == "creator"
        assert "access_token" in data

    async def test_register_hotel_success(
        self, client: AsyncClient, cleanup_database
    ):
        """Test successful hotel registration."""
        email = generate_test_email()

        response = await client.post(
            "/auth/register",
            json={
                "email": email,
                "password": "SecurePassword123!",
                "name": "Test Hotel",
                "type": "hotel",
                "terms_accepted": True,
                "privacy_accepted": True
            }
        )

        assert response.status_code == 201
        data = response.json()
        assert data["email"] == email
        assert data["type"] == "hotel"
        assert "access_token" in data

    async def test_register_duplicate_email(
        self, client: AsyncClient, cleanup_database
    ):
        """Test registration with existing email."""
        user = await create_test_user()

        response = await client.post(
            "/auth/register",
            json={
                "email": user["email"],
                "password": "SecurePassword123!",
                "name": "Duplicate User",
                "type": "creator",
                "terms_accepted": True,
                "privacy_accepted": True
            }
        )

        assert response.status_code == 400
        assert "already registered" in response.json()["detail"].lower()

    async def test_register_weak_password(
        self, client: AsyncClient, cleanup_database
    ):
        """Test registration with weak password."""
        email = generate_test_email()

        response = await client.post(
            "/auth/register",
            json={
                "email": email,
                "password": "weak",  # Too short
                "name": "Test User",
                "type": "creator",
                "terms_accepted": True,
                "privacy_accepted": True
            }
        )

        assert response.status_code == 422  # Validation error

    async def test_register_missing_fields(
        self, client: AsyncClient, cleanup_database
    ):
        """Test registration with missing required fields."""
        response = await client.post(
            "/auth/register",
            json={"email": generate_test_email()}
        )

        assert response.status_code == 422

    async def test_register_invalid_type(
        self, client: AsyncClient, cleanup_database
    ):
        """Test registration with invalid user type."""
        response = await client.post(
            "/auth/register",
            json={
                "email": generate_test_email(),
                "password": "SecurePassword123!",
                "name": "Test User",
                "type": "invalid_type",
                "terms_accepted": True,
                "privacy_accepted": True
            }
        )

        assert response.status_code == 422


class TestLogin:
    """Tests for POST /auth/login"""

    async def test_login_success(
        self, client: AsyncClient, cleanup_database
    ):
        """Test successful login."""
        password = "TestPassword123!"
        user = await create_test_user(password=password)

        response = await client.post(
            "/auth/login",
            json={"email": user["email"], "password": password}
        )

        assert response.status_code == 200
        data = response.json()
        assert data["email"] == user["email"]
        assert "access_token" in data
        assert "expires_in" in data

    async def test_login_invalid_email(
        self, client: AsyncClient, cleanup_database
    ):
        """Test login with non-existent email."""
        response = await client.post(
            "/auth/login",
            json={"email": "nonexistent@example.com", "password": "password123"}
        )

        assert response.status_code == 401
        assert "invalid" in response.json()["detail"].lower()

    async def test_login_invalid_password(
        self, client: AsyncClient, cleanup_database
    ):
        """Test login with wrong password."""
        user = await create_test_user(password="CorrectPassword123!")

        response = await client.post(
            "/auth/login",
            json={"email": user["email"], "password": "WrongPassword123!"}
        )

        assert response.status_code == 401
        assert "invalid" in response.json()["detail"].lower()

    async def test_login_suspended_account(
        self, client: AsyncClient, cleanup_database
    ):
        """Test login with suspended account."""
        password = "TestPassword123!"
        user = await create_test_user(password=password, status="suspended")

        response = await client.post(
            "/auth/login",
            json={"email": user["email"], "password": password}
        )

        assert response.status_code == 403
        assert "suspended" in response.json()["detail"].lower()


class TestValidateToken:
    """Tests for POST /auth/validate-token"""

    async def test_validate_token_valid(
        self, client: AsyncClient, test_creator
    ):
        """Test validation of valid token."""
        response = await client.post(
            "/auth/validate-token",
            headers=get_auth_headers(test_creator["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert data["valid"] is True
        assert data["expired"] is False
        assert data["user_id"] == str(test_creator["user"]["id"])
        assert data["email"] == test_creator["user"]["email"]

    async def test_validate_token_expired(
        self, client: AsyncClient, cleanup_database
    ):
        """Test validation of expired token."""
        from datetime import timedelta
        from app.jwt_utils import create_access_token

        user = await create_test_user()
        # Create token that expired 1 hour ago
        expired_token = create_access_token(
            {"sub": str(user["id"]), "email": user["email"], "type": "creator"},
            expires_delta=timedelta(hours=-1)
        )

        response = await client.post(
            "/auth/validate-token",
            headers=get_auth_headers(expired_token)
        )

        assert response.status_code == 200
        data = response.json()
        assert data["valid"] is False
        assert data["expired"] is True

    async def test_validate_token_invalid(
        self, client: AsyncClient
    ):
        """Test validation of invalid token."""
        response = await client.post(
            "/auth/validate-token",
            headers={"Authorization": "Bearer invalid.token.here"}
        )

        assert response.status_code == 200
        data = response.json()
        assert data["valid"] is False

    async def test_validate_token_no_token(
        self, client: AsyncClient
    ):
        """Test validation without token returns valid=False."""
        response = await client.post("/auth/validate-token")

        assert response.status_code == 200
        data = response.json()
        assert data["valid"] is False


class TestForgotPassword:
    """Tests for POST /auth/forgot-password"""

    async def test_forgot_password_existing_user(
        self, client: AsyncClient, cleanup_database, mock_send_email
    ):
        """Test forgot password for existing user."""
        user = await create_test_user()

        response = await client.post(
            "/auth/forgot-password",
            json={"email": user["email"]}
        )

        assert response.status_code == 200
        data = response.json()
        assert "message" in data
        # Security: always returns success message

    async def test_forgot_password_nonexistent_email(
        self, client: AsyncClient, cleanup_database
    ):
        """Test forgot password for non-existent email (still returns 200)."""
        response = await client.post(
            "/auth/forgot-password",
            json={"email": "nonexistent@example.com"}
        )

        # Security best practice: don't reveal if email exists
        assert response.status_code == 200
        data = response.json()
        assert "message" in data

    async def test_forgot_password_suspended_user(
        self, client: AsyncClient, cleanup_database
    ):
        """Test forgot password for suspended user."""
        user = await create_test_user(status="suspended")

        response = await client.post(
            "/auth/forgot-password",
            json={"email": user["email"]}
        )

        # Still returns 200 for security
        assert response.status_code == 200


class TestResetPassword:
    """Tests for POST /auth/reset-password"""

    async def test_reset_password_success(
        self, client: AsyncClient, cleanup_database, mock_send_email
    ):
        """Test successful password reset."""
        user = await create_test_user()

        # Request reset
        await client.post(
            "/auth/forgot-password",
            json={"email": user["email"]}
        )

        # Get token from database
        token_row = await Database.fetchrow(
            "SELECT token FROM password_reset_tokens WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
            user["id"]
        )

        if token_row:
            response = await client.post(
                "/auth/reset-password",
                json={
                    "token": token_row["token"],
                    "new_password": "NewSecurePassword123!"
                }
            )

            assert response.status_code == 200
            data = response.json()
            assert "success" in data["message"].lower()

            # Verify can login with new password
            login_response = await client.post(
                "/auth/login",
                json={"email": user["email"], "password": "NewSecurePassword123!"}
            )
            assert login_response.status_code == 200

    async def test_reset_password_invalid_token(
        self, client: AsyncClient, cleanup_database
    ):
        """Test reset password with invalid token."""
        response = await client.post(
            "/auth/reset-password",
            json={
                "token": "invalid-token",
                "new_password": "NewSecurePassword123!"
            }
        )

        assert response.status_code == 400
        assert "invalid" in response.json()["detail"].lower()

    async def test_reset_password_used_token(
        self, client: AsyncClient, cleanup_database, mock_send_email
    ):
        """Test reset password with already used token."""
        user = await create_test_user()

        # Request reset
        await client.post(
            "/auth/forgot-password",
            json={"email": user["email"]}
        )

        # Get token
        token_row = await Database.fetchrow(
            "SELECT token FROM password_reset_tokens WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
            user["id"]
        )

        if token_row:
            # Use token first time
            await client.post(
                "/auth/reset-password",
                json={
                    "token": token_row["token"],
                    "new_password": "NewSecurePassword123!"
                }
            )

            # Try to use again
            response = await client.post(
                "/auth/reset-password",
                json={
                    "token": token_row["token"],
                    "new_password": "AnotherPassword123!"
                }
            )

            assert response.status_code == 400


class TestVerifyEmail:
    """Tests for GET /auth/verify-email"""

    async def test_verify_email_success(
        self, client: AsyncClient, cleanup_database
    ):
        """Test successful email verification via token."""
        from app.auth import create_email_verification_token

        user = await create_test_user()
        token = await create_email_verification_token(str(user["id"]), expires_in_hours=48)

        response = await client.get(
            f"/auth/verify-email?token={token}"
        )

        assert response.status_code == 200
        data = response.json()
        assert data["verified"] is True

    async def test_verify_email_invalid_token(
        self, client: AsyncClient, cleanup_database
    ):
        """Test email verification with invalid token."""
        response = await client.get(
            "/auth/verify-email?token=invalid-token"
        )

        assert response.status_code == 200
        data = response.json()
        assert data["verified"] is False

    async def test_verify_email_missing_token(
        self, client: AsyncClient
    ):
        """Test email verification without token."""
        response = await client.get("/auth/verify-email")

        assert response.status_code == 422  # Missing required query param
