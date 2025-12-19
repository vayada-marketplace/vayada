"""
Tests for authentication endpoints
"""
import pytest
import bcrypt
from httpx import AsyncClient
from app.database import Database
from app.auth import (
    create_email_verification_code, 
    verify_email_code, 
    hash_password,
    create_password_reset_token,
    validate_password_reset_token
)
from app.jwt_utils import decode_access_token, create_access_token
from app.config import settings
from datetime import datetime, timedelta, timezone


class TestSendVerificationCode:
    """Tests for POST /auth/send-verification-code endpoint"""
    
    @pytest.mark.asyncio
    async def test_send_verification_code_success(self, client: AsyncClient, mock_send_email):
        """Test successfully sending verification code to new email"""
        response = await client.post(
            "/auth/send-verification-code",
            json={"email": "test_new@example.com"}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert "message" in data
        assert "code" in data
        
        # In DEBUG mode, code should be returned
        if settings.DEBUG:
            assert data["code"] is not None
            assert len(data["code"]) == 6
            assert data["code"].isdigit()
        
        # Verify email was sent
        assert len(mock_send_email) == 1
        assert mock_send_email[0]["to_email"] == "test_new@example.com"
        assert "verify" in mock_send_email[0]["subject"].lower() or "verification" in mock_send_email[0]["subject"].lower()
        
        # Verify code was stored in database
        code_record = await Database.fetchrow(
            "SELECT * FROM email_verification_codes WHERE email = $1",
            "test_new@example.com"
        )
        assert code_record is not None
        assert code_record["email"] == "test_new@example.com"
        assert code_record["code"] == data["code"]
        assert code_record["used"] is False
    
    @pytest.mark.asyncio
    async def test_send_verification_code_existing_user(self, client: AsyncClient, mock_send_email):
        """Test sending verification code when email already exists (should still return success for security)"""
        # Create a user first
        await Database.execute(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'pending')
            """,
            "test_existing@example.com",
            "hashed_password",
            "Test User",
            "creator"
        )
        
        response = await client.post(
            "/auth/send-verification-code",
            json={"email": "test_existing@example.com"}
        )
        
        assert response.status_code == 200
        data = response.json()
        # Should return generic message (security best practice)
        assert "message" in data
        # Code should not be returned for existing users
        assert data.get("code") is None
    
    @pytest.mark.asyncio
    async def test_send_verification_code_invalid_email(self, client: AsyncClient):
        """Test sending verification code with invalid email format"""
        response = await client.post(
            "/auth/send-verification-code",
            json={"email": "invalid-email"}
        )
        
        assert response.status_code == 422  # Validation error
    
    @pytest.mark.asyncio
    async def test_send_verification_code_missing_email(self, client: AsyncClient):
        """Test sending verification code without email field"""
        response = await client.post(
            "/auth/send-verification-code",
            json={}
        )
        
        assert response.status_code == 422  # Validation error
    
    @pytest.mark.asyncio
    async def test_send_verification_code_invalidates_old_codes(self, client: AsyncClient, mock_send_email):
        """Test that sending a new code invalidates old unused codes"""
        email = "test_invalidate@example.com"
        
        # Send first code
        response1 = await client.post(
            "/auth/send-verification-code",
            json={"email": email}
        )
        assert response1.status_code == 200
        first_code = response1.json().get("code")
        
        # Send second code
        response2 = await client.post(
            "/auth/send-verification-code",
            json={"email": email}
        )
        assert response2.status_code == 200
        second_code = response2.json().get("code")
        
        # Verify codes are different
        assert first_code != second_code
        
        # Verify first code is marked as used (invalidated)
        first_code_record = await Database.fetchrow(
            "SELECT used FROM email_verification_codes WHERE email = $1 AND code = $2",
            email, first_code
        )
        assert first_code_record is not None
        assert first_code_record["used"] is True
        
        # Verify second code is still valid
        second_code_record = await Database.fetchrow(
            "SELECT used FROM email_verification_codes WHERE email = $1 AND code = $2",
            email, second_code
        )
        assert second_code_record is not None
        assert second_code_record["used"] is False


class TestVerifyEmailCode:
    """Tests for POST /auth/verify-email-code endpoint"""
    
    @pytest.mark.asyncio
    async def test_verify_email_code_success(self, client: AsyncClient):
        """Test successfully verifying a valid code"""
        email = "test_verify@example.com"
        
        # Create a verification code
        code = await create_email_verification_code(email, expires_in_minutes=15)
        
        # Verify the code
        response = await client.post(
            "/auth/verify-email-code",
            json={"email": email, "code": code}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["verified"] is True
        assert "successfully" in data["message"].lower()
        
        # Verify code is marked as used
        code_record = await Database.fetchrow(
            "SELECT used FROM email_verification_codes WHERE email = $1 AND code = $2",
            email, code
        )
        assert code_record is not None
        assert code_record["used"] is True
    
    @pytest.mark.asyncio
    async def test_verify_email_code_invalid_code(self, client: AsyncClient):
        """Test verifying with an invalid code"""
        email = "test_invalid@example.com"
        
        # Create a verification code
        valid_code = await create_email_verification_code(email, expires_in_minutes=15)
        
        # Try to verify with wrong code
        response = await client.post(
            "/auth/verify-email-code",
            json={"email": email, "code": "999999"}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["verified"] is False
        assert "invalid" in data["message"].lower() or "expired" in data["message"].lower()
    
    @pytest.mark.asyncio
    async def test_verify_email_code_wrong_email(self, client: AsyncClient):
        """Test verifying code with wrong email"""
        email1 = "test_email1@example.com"
        email2 = "test_email2@example.com"
        
        # Create a verification code for email1
        code = await create_email_verification_code(email1, expires_in_minutes=15)
        
        # Try to verify with email2
        response = await client.post(
            "/auth/verify-email-code",
            json={"email": email2, "code": code}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["verified"] is False
    
    @pytest.mark.asyncio
    async def test_verify_email_code_already_used(self, client: AsyncClient):
        """Test verifying a code that has already been used"""
        email = "test_used@example.com"
        
        # Create and use a verification code
        code = await create_email_verification_code(email, expires_in_minutes=15)
        
        # Verify it once (should succeed)
        response1 = await client.post(
            "/auth/verify-email-code",
            json={"email": email, "code": code}
        )
        assert response1.status_code == 200
        assert response1.json()["verified"] is True
        
        # Try to verify again (should fail)
        response2 = await client.post(
            "/auth/verify-email-code",
            json={"email": email, "code": code}
        )
        assert response2.status_code == 200
        data = response2.json()
        assert data["verified"] is False
    
    @pytest.mark.asyncio
    async def test_verify_email_code_expired(self, client: AsyncClient):
        """Test verifying an expired code"""
        email = "test_expired@example.com"
        
        # Manually create an expired code
        from app.database import Database
        expired_code = "123456"
        expired_at = datetime.now(timezone.utc) - timedelta(minutes=1)  # Expired 1 minute ago
        
        await Database.execute(
            """
            INSERT INTO email_verification_codes (email, code, expires_at, used)
            VALUES ($1, $2, $3, false)
            """,
            email, expired_code, expired_at
        )
        
        # Try to verify expired code
        response = await client.post(
            "/auth/verify-email-code",
            json={"email": email, "code": expired_code}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["verified"] is False
        assert "expired" in data["message"].lower() or "invalid" in data["message"].lower()
    
    @pytest.mark.asyncio
    async def test_verify_email_code_invalid_format(self, client: AsyncClient):
        """Test verifying with invalid code format"""
        response = await client.post(
            "/auth/verify-email-code",
            json={"email": "test@example.com", "code": "12345"}  # Too short
        )
        
        assert response.status_code == 422  # Validation error
        
        response2 = await client.post(
            "/auth/verify-email-code",
            json={"email": "test@example.com", "code": "1234567"}  # Too long
        )
        
        assert response2.status_code == 422  # Validation error
    
    @pytest.mark.asyncio
    async def test_verify_email_code_missing_fields(self, client: AsyncClient):
        """Test verifying with missing fields"""
        # Missing code
        response1 = await client.post(
            "/auth/verify-email-code",
            json={"email": "test@example.com"}
        )
        assert response1.status_code == 422
        
        # Missing email
        response2 = await client.post(
            "/auth/verify-email-code",
            json={"code": "123456"}
        )
        assert response2.status_code == 422
    
    @pytest.mark.asyncio
    async def test_verify_email_code_marks_email_as_verified(self, client: AsyncClient):
        """Test that verifying a code marks the email as verified in users table"""
        email = "test_mark_verified@example.com"
        
        # Create a user first
        await Database.execute(
            """
            INSERT INTO users (email, password_hash, name, type, status, email_verified)
            VALUES ($1, $2, $3, $4, 'pending', false)
            """,
            email,
            "hashed_password",
            "Test User",
            "creator"
        )
        
        # Create and verify code
        code = await create_email_verification_code(email, expires_in_minutes=15)
        
        response = await client.post(
            "/auth/verify-email-code",
            json={"email": email, "code": code}
        )
        
        assert response.status_code == 200
        assert response.json()["verified"] is True
        
        # Verify email_verified is set to true
        user = await Database.fetchrow(
            "SELECT email_verified FROM users WHERE email = $1",
            email
        )
        assert user is not None
        assert user["email_verified"] is True


class TestRegister:
    """Tests for POST /auth/register endpoint"""
    
    @pytest.mark.asyncio
    async def test_register_creator_success(self, client: AsyncClient):
        """Test successfully registering a creator"""
        response = await client.post(
            "/auth/register",
            json={
                "email": "test_creator@example.com",
                "password": "password123",
                "type": "creator",
                "name": "Test Creator"
            }
        )
        
        assert response.status_code == 201
        data = response.json()
        assert data["email"] == "test_creator@example.com"
        assert data["name"] == "Test Creator"
        assert data["type"] == "creator"
        assert data["status"] == "pending"
        assert "access_token" in data
        assert data["token_type"] == "bearer"
        assert "expires_in" in data
        assert data["expires_in"] > 0
        
        # Verify user was created in database
        user = await Database.fetchrow(
            "SELECT * FROM users WHERE email = $1",
            "test_creator@example.com"
        )
        assert user is not None
        assert user["email"] == "test_creator@example.com"
        assert user["type"] == "creator"
        assert user["status"] == "pending"
        
        # Verify creator profile was created
        creator = await Database.fetchrow(
            "SELECT * FROM creators WHERE user_id = $1",
            user["id"]
        )
        assert creator is not None
    
    @pytest.mark.asyncio
    async def test_register_hotel_success(self, client: AsyncClient):
        """Test successfully registering a hotel"""
        response = await client.post(
            "/auth/register",
            json={
                "email": "test_hotel@example.com",
                "password": "password123",
                "type": "hotel",
                "name": "Test Hotel"
            }
        )
        
        assert response.status_code == 201
        data = response.json()
        assert data["email"] == "test_hotel@example.com"
        assert data["name"] == "Test Hotel"
        assert data["type"] == "hotel"
        assert data["status"] == "pending"
        assert "access_token" in data
        
        # Verify user was created in database
        user = await Database.fetchrow(
            "SELECT * FROM users WHERE email = $1",
            "test_hotel@example.com"
        )
        assert user is not None
        
        # Verify hotel profile was created
        hotel = await Database.fetchrow(
            "SELECT * FROM hotel_profiles WHERE user_id = $1",
            user["id"]
        )
        assert hotel is not None
        assert hotel["name"] == "Test Hotel"
    
    @pytest.mark.asyncio
    async def test_register_without_name(self, client: AsyncClient):
        """Test registering without name (should use email prefix)"""
        response = await client.post(
            "/auth/register",
            json={
                "email": "testuser@example.com",
                "password": "password123",
                "type": "creator"
            }
        )
        
        assert response.status_code == 201
        data = response.json()
        # Name should default to email prefix (capitalized)
        assert data["name"] == "Testuser"
    
    @pytest.mark.asyncio
    async def test_register_duplicate_email(self, client: AsyncClient):
        """Test registering with an email that already exists"""
        # Create existing user
        password_hash = hash_password("password123")
        await Database.execute(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'pending')
            """,
            "test_duplicate@example.com",
            password_hash,
            "Existing User",
            "creator"
        )
        
        # Try to register with same email
        response = await client.post(
            "/auth/register",
            json={
                "email": "test_duplicate@example.com",
                "password": "password123",
                "type": "creator"
            }
        )
        
        assert response.status_code == 400
        assert "already registered" in response.json()["detail"].lower()
    
    @pytest.mark.asyncio
    async def test_register_invalid_email(self, client: AsyncClient):
        """Test registering with invalid email format"""
        response = await client.post(
            "/auth/register",
            json={
                "email": "invalid-email",
                "password": "password123",
                "type": "creator"
            }
        )
        
        assert response.status_code == 422  # Validation error
    
    @pytest.mark.asyncio
    async def test_register_password_too_short(self, client: AsyncClient):
        """Test registering with password shorter than 8 characters"""
        response = await client.post(
            "/auth/register",
            json={
                "email": "test@example.com",
                "password": "short",
                "type": "creator"
            }
        )
        
        assert response.status_code == 422  # Validation error
    
    @pytest.mark.asyncio
    async def test_register_invalid_type(self, client: AsyncClient):
        """Test registering with invalid user type"""
        response = await client.post(
            "/auth/register",
            json={
                "email": "test@example.com",
                "password": "password123",
                "type": "invalid_type"
            }
        )
        
        assert response.status_code == 422  # Validation error
    
    @pytest.mark.asyncio
    async def test_register_missing_fields(self, client: AsyncClient):
        """Test registering with missing required fields"""
        # Missing email
        response1 = await client.post(
            "/auth/register",
            json={
                "password": "password123",
                "type": "creator"
            }
        )
        assert response1.status_code == 422
        
        # Missing password
        response2 = await client.post(
            "/auth/register",
            json={
                "email": "test@example.com",
                "type": "creator"
            }
        )
        assert response2.status_code == 422
        
        # Missing type
        response3 = await client.post(
            "/auth/register",
            json={
                "email": "test@example.com",
                "password": "password123"
            }
        )
        assert response3.status_code == 422
    
    @pytest.mark.asyncio
    async def test_register_token_valid(self, client: AsyncClient):
        """Test that the access token returned from register is valid"""
        response = await client.post(
            "/auth/register",
            json={
                "email": "test_token@example.com",
                "password": "password123",
                "type": "creator"
            }
        )
        
        assert response.status_code == 201
        data = response.json()
        token = data["access_token"]
        
        # Verify token can be decoded
        payload = decode_access_token(token)
        assert payload is not None
        assert payload["email"] == "test_token@example.com"
        assert payload["type"] == "creator"
        assert payload["sub"] is not None  # user_id


class TestLogin:
    """Tests for POST /auth/login endpoint"""
    
    @pytest.mark.asyncio
    async def test_login_success(self, client: AsyncClient):
        """Test successfully logging in with correct credentials"""
        # Create a user first
        email = "test_login@example.com"
        password = "password123"
        password_hash = hash_password(password)
        
        user = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'pending')
            RETURNING *
            """,
            email,
            password_hash,
            "Test User",
            "creator"
        )
        
        # Login
        response = await client.post(
            "/auth/login",
            json={
                "email": email,
                "password": password
            }
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["email"] == email
        assert data["id"] == str(user["id"])
        assert data["type"] == "creator"
        assert "access_token" in data
        assert data["token_type"] == "bearer"
        assert "expires_in" in data
    
    @pytest.mark.asyncio
    async def test_login_wrong_password(self, client: AsyncClient):
        """Test logging in with wrong password"""
        # Create a user first
        email = "test_wrong_pass@example.com"
        password_hash = hash_password("correct_password")
        
        await Database.execute(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'pending')
            """,
            email,
            password_hash,
            "Test User",
            "creator"
        )
        
        # Try to login with wrong password
        response = await client.post(
            "/auth/login",
            json={
                "email": email,
                "password": "wrong_password"
            }
        )
        
        assert response.status_code == 401
        assert "invalid" in response.json()["detail"].lower()
    
    @pytest.mark.asyncio
    async def test_login_wrong_email(self, client: AsyncClient):
        """Test logging in with non-existent email"""
        response = await client.post(
            "/auth/login",
            json={
                "email": "nonexistent@example.com",
                "password": "password123"
            }
        )
        
        assert response.status_code == 401
        assert "invalid" in response.json()["detail"].lower()
    
    @pytest.mark.asyncio
    async def test_login_suspended_account(self, client: AsyncClient):
        """Test logging in with suspended account"""
        # Create a suspended user
        email = "test_suspended@example.com"
        password = "password123"
        password_hash = hash_password(password)
        
        await Database.execute(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'suspended')
            """,
            email,
            password_hash,
            "Test User",
            "creator"
        )
        
        # Try to login
        response = await client.post(
            "/auth/login",
            json={
                "email": email,
                "password": password
            }
        )
        
        assert response.status_code == 403
        assert "suspended" in response.json()["detail"].lower()
    
    @pytest.mark.asyncio
    async def test_login_invalid_email_format(self, client: AsyncClient):
        """Test logging in with invalid email format"""
        response = await client.post(
            "/auth/login",
            json={
                "email": "invalid-email",
                "password": "password123"
            }
        )
        
        assert response.status_code == 422  # Validation error
    
    @pytest.mark.asyncio
    async def test_login_missing_fields(self, client: AsyncClient):
        """Test logging in with missing fields"""
        # Missing email
        response1 = await client.post(
            "/auth/login",
            json={"password": "password123"}
        )
        assert response1.status_code == 422
        
        # Missing password
        response2 = await client.post(
            "/auth/login",
            json={"email": "test@example.com"}
        )
        assert response2.status_code == 422
    
    @pytest.mark.asyncio
    async def test_login_token_valid(self, client: AsyncClient):
        """Test that the access token returned from login is valid"""
        # Create a user first
        email = "test_token_login@example.com"
        password = "password123"
        password_hash = hash_password(password)
        
        user = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'pending')
            RETURNING *
            """,
            email,
            password_hash,
            "Test User",
            "creator"
        )
        
        # Login
        response = await client.post(
            "/auth/login",
            json={
                "email": email,
                "password": password
            }
        )
        
        assert response.status_code == 200
        token = response.json()["access_token"]
        
        # Verify token can be decoded
        payload = decode_access_token(token)
        assert payload is not None
        assert payload["email"] == email
        assert payload["type"] == "creator"
        assert payload["sub"] == str(user["id"])


class TestValidateToken:
    """Tests for POST /auth/validate-token endpoint"""
    
    @pytest.mark.asyncio
    async def test_validate_token_success(self, client: AsyncClient):
        """Test validating a valid token"""
        # Create a user and get a token
        email = "test_validate@example.com"
        password = "password123"
        password_hash = hash_password(password)
        
        user = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'pending')
            RETURNING *
            """,
            email,
            password_hash,
            "Test User",
            "creator"
        )
        
        # Login to get token
        login_response = await client.post(
            "/auth/login",
            json={"email": email, "password": password}
        )
        token = login_response.json()["access_token"]
        
        # Validate token
        response = await client.post(
            "/auth/validate-token",
            headers={"Authorization": f"Bearer {token}"}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["valid"] is True
        assert data["expired"] is False
        assert data["user_id"] == str(user["id"])
        assert data["email"] == email
        assert data["type"] == "creator"
    
    @pytest.mark.asyncio
    async def test_validate_token_no_token(self, client: AsyncClient):
        """Test validating without providing a token"""
        response = await client.post(
            "/auth/validate-token"
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["valid"] is False
        assert data["expired"] is False
        assert data["user_id"] is None
        assert data["email"] is None
        assert data["type"] is None
    
    @pytest.mark.asyncio
    async def test_validate_token_invalid_token(self, client: AsyncClient):
        """Test validating with an invalid token"""
        response = await client.post(
            "/auth/validate-token",
            headers={"Authorization": "Bearer invalid_token_12345"}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["valid"] is False
        assert data["expired"] is False
        assert data["user_id"] is None
    
    @pytest.mark.asyncio
    async def test_validate_token_expired(self, client: AsyncClient):
        """Test validating an expired token"""
        # Create an expired token
        expired_token = create_access_token(
            data={"sub": "test_user_id", "email": "test@example.com", "type": "creator"},
            expires_delta=timedelta(seconds=-1)  # Already expired
        )
        
        response = await client.post(
            "/auth/validate-token",
            headers={"Authorization": f"Bearer {expired_token}"}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["valid"] is False
        assert data["expired"] is True
        assert data["user_id"] is None
    
    @pytest.mark.asyncio
    async def test_validate_token_user_not_found(self, client: AsyncClient):
        """Test validating a token for a user that no longer exists"""
        # Create a token for a non-existent user
        fake_user_id = "00000000-0000-0000-0000-000000000000"
        token = create_access_token(
            data={"sub": fake_user_id, "email": "nonexistent@example.com", "type": "creator"}
        )
        
        response = await client.post(
            "/auth/validate-token",
            headers={"Authorization": f"Bearer {token}"}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["valid"] is False
        assert data["expired"] is False
        assert data["user_id"] is None
    
    @pytest.mark.asyncio
    async def test_validate_token_malformed_header(self, client: AsyncClient):
        """Test validating with malformed authorization header"""
        # Missing "Bearer " prefix
        response1 = await client.post(
            "/auth/validate-token",
            headers={"Authorization": "some_token"}
        )
        assert response1.status_code == 200
        assert response1.json()["valid"] is False
        
        # Empty authorization header
        response2 = await client.post(
            "/auth/validate-token",
            headers={"Authorization": ""}
        )
        assert response2.status_code == 200
        assert response2.json()["valid"] is False
    
    @pytest.mark.asyncio
    async def test_validate_token_different_user_types(self, client: AsyncClient):
        """Test validating tokens for different user types"""
        # Test creator token
        creator_email = "test_creator_validate@example.com"
        creator_password = "password123"
        creator_password_hash = hash_password(creator_password)
        
        creator_user = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'pending')
            RETURNING *
            """,
            creator_email,
            creator_password_hash,
            "Creator User",
            "creator"
        )
        
        creator_login = await client.post(
            "/auth/login",
            json={"email": creator_email, "password": creator_password}
        )
        creator_token = creator_login.json()["access_token"]
        
        creator_validate = await client.post(
            "/auth/validate-token",
            headers={"Authorization": f"Bearer {creator_token}"}
        )
        assert creator_validate.json()["type"] == "creator"
        
        # Test hotel token
        hotel_email = "test_hotel_validate@example.com"
        hotel_password = "password123"
        hotel_password_hash = hash_password(hotel_password)
        
        hotel_user = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'pending')
            RETURNING *
            """,
            hotel_email,
            hotel_password_hash,
            "Hotel User",
            "hotel"
        )
        
        hotel_login = await client.post(
            "/auth/login",
            json={"email": hotel_email, "password": hotel_password}
        )
        hotel_token = hotel_login.json()["access_token"]
        
        hotel_validate = await client.post(
            "/auth/validate-token",
            headers={"Authorization": f"Bearer {hotel_token}"}
        )
        assert hotel_validate.json()["type"] == "hotel"


class TestForgotPassword:
    """Tests for POST /auth/forgot-password endpoint"""
    
    @pytest.mark.asyncio
    async def test_forgot_password_success(self, client: AsyncClient, mock_send_email):
        """Test successfully requesting password reset for existing user"""
        # Create a user first
        email = "test_forgot@example.com"
        password_hash = hash_password("old_password")
        
        user = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'pending')
            RETURNING *
            """,
            email,
            password_hash,
            "Test User",
            "creator"
        )
        
        # Request password reset
        response = await client.post(
            "/auth/forgot-password",
            json={"email": email}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert "message" in data
        assert "token" in data
        # Token should be None in production, or returned in DEBUG mode if email failed
        # Since we're mocking email, token should be None
        
        # Verify email was sent
        assert len(mock_send_email) == 1
        assert mock_send_email[0]["to_email"] == email
        assert "reset" in mock_send_email[0]["subject"].lower()
        
        # Verify token was created in database
        token_record = await Database.fetchrow(
            """
            SELECT * FROM password_reset_tokens 
            WHERE user_id = $1 AND used = false
            ORDER BY created_at DESC
            LIMIT 1
            """,
            user["id"]
        )
        assert token_record is not None
        assert token_record["used"] is False
    
    @pytest.mark.asyncio
    async def test_forgot_password_nonexistent_email(self, client: AsyncClient, mock_send_email):
        """Test requesting password reset for non-existent email (should still return success for security)"""
        response = await client.post(
            "/auth/forgot-password",
            json={"email": "nonexistent@example.com"}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert "message" in data
        assert data.get("token") is None
        
        # Should not send email for non-existent user
        assert len(mock_send_email) == 0
    
    @pytest.mark.asyncio
    async def test_forgot_password_suspended_user(self, client: AsyncClient, mock_send_email):
        """Test requesting password reset for suspended user (should still return success for security)"""
        # Create a suspended user
        email = "test_suspended_forgot@example.com"
        password_hash = hash_password("password123")
        
        await Database.execute(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'suspended')
            """,
            email,
            password_hash,
            "Suspended User",
            "creator"
        )
        
        # Request password reset
        response = await client.post(
            "/auth/forgot-password",
            json={"email": email}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert "message" in data
        assert data.get("token") is None
        
        # Should not send email for suspended user
        assert len(mock_send_email) == 0
        
        # Should not create token for suspended user
        token_record = await Database.fetchrow(
            "SELECT * FROM password_reset_tokens WHERE user_id IN (SELECT id FROM users WHERE email = $1)",
            email
        )
        assert token_record is None
    
    @pytest.mark.asyncio
    async def test_forgot_password_invalid_email(self, client: AsyncClient):
        """Test requesting password reset with invalid email format"""
        response = await client.post(
            "/auth/forgot-password",
            json={"email": "invalid-email"}
        )
        
        assert response.status_code == 422  # Validation error
    
    @pytest.mark.asyncio
    async def test_forgot_password_missing_email(self, client: AsyncClient):
        """Test requesting password reset without email field"""
        response = await client.post(
            "/auth/forgot-password",
            json={}
        )
        
        assert response.status_code == 422  # Validation error
    
    @pytest.mark.asyncio
    async def test_forgot_password_creates_token(self, client: AsyncClient, mock_send_email):
        """Test that forgot password creates a valid reset token"""
        # Create a user
        email = "test_token_create@example.com"
        password_hash = hash_password("password123")
        
        user = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'pending')
            RETURNING *
            """,
            email,
            password_hash,
            "Test User",
            "creator"
        )
        
        # Request password reset
        response = await client.post(
            "/auth/forgot-password",
            json={"email": email}
        )
        
        assert response.status_code == 200
        
        # Verify token exists and is valid
        token_record = await Database.fetchrow(
            """
            SELECT * FROM password_reset_tokens 
            WHERE user_id = $1 AND used = false
            ORDER BY created_at DESC
            LIMIT 1
            """,
            user["id"]
        )
        assert token_record is not None
        
        # Verify token can be validated
        token_data = await validate_password_reset_token(token_record["token"])
        assert token_data is not None
        assert token_data["user_id"] == str(user["id"])


class TestResetPassword:
    """Tests for POST /auth/reset-password endpoint"""
    
    @pytest.mark.asyncio
    async def test_reset_password_success(self, client: AsyncClient):
        """Test successfully resetting password with valid token"""
        # Create a user
        email = "test_reset@example.com"
        old_password = "old_password123"
        new_password = "new_password123"
        old_password_hash = hash_password(old_password)
        
        user = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'pending')
            RETURNING *
            """,
            email,
            old_password_hash,
            "Test User",
            "creator"
        )
        
        # Create a reset token
        token = await create_password_reset_token(str(user["id"]), expires_in_hours=1)
        
        # Reset password
        response = await client.post(
            "/auth/reset-password",
            json={
                "token": token,
                "new_password": new_password
            }
        )
        
        assert response.status_code == 200
        data = response.json()
        assert "successfully" in data["message"].lower()
        
        # Verify password was changed
        updated_user = await Database.fetchrow(
            "SELECT password_hash FROM users WHERE id = $1",
            user["id"]
        )
        assert updated_user is not None
        
        # Verify old password doesn't work
        old_password_valid = bcrypt.checkpw(
            old_password.encode('utf-8'),
            updated_user["password_hash"].encode('utf-8')
        )
        assert old_password_valid is False
        
        # Verify new password works
        new_password_valid = bcrypt.checkpw(
            new_password.encode('utf-8'),
            updated_user["password_hash"].encode('utf-8')
        )
        assert new_password_valid is True
        
        # Verify token is marked as used
        token_record = await Database.fetchrow(
            "SELECT used FROM password_reset_tokens WHERE token = $1",
            token
        )
        assert token_record is not None
        assert token_record["used"] is True
    
    @pytest.mark.asyncio
    async def test_reset_password_invalid_token(self, client: AsyncClient):
        """Test resetting password with invalid token"""
        response = await client.post(
            "/auth/reset-password",
            json={
                "token": "invalid_token_12345",
                "new_password": "new_password123"
            }
        )
        
        assert response.status_code == 400
        assert "invalid" in response.json()["detail"].lower() or "expired" in response.json()["detail"].lower()
    
    @pytest.mark.asyncio
    async def test_reset_password_expired_token(self, client: AsyncClient):
        """Test resetting password with expired token"""
        # Create a user
        email = "test_expired_reset@example.com"
        password_hash = hash_password("password123")
        
        user = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'pending')
            RETURNING *
            """,
            email,
            password_hash,
            "Test User",
            "creator"
        )
        
        # Manually create an expired token
        from datetime import datetime, timedelta, timezone
        expired_token = "expired_token_123"
        expired_at = datetime.now(timezone.utc) - timedelta(hours=2)  # Expired 2 hours ago
        
        await Database.execute(
            """
            INSERT INTO password_reset_tokens (user_id, token, expires_at, used)
            VALUES ($1, $2, $3, false)
            """,
            user["id"],
            expired_token,
            expired_at
        )
        
        # Try to reset password with expired token
        response = await client.post(
            "/auth/reset-password",
            json={
                "token": expired_token,
                "new_password": "new_password123"
            }
        )
        
        assert response.status_code == 400
        assert "invalid" in response.json()["detail"].lower() or "expired" in response.json()["detail"].lower()
    
    @pytest.mark.asyncio
    async def test_reset_password_already_used_token(self, client: AsyncClient):
        """Test resetting password with already used token"""
        # Create a user
        email = "test_used_token@example.com"
        password_hash = hash_password("password123")
        
        user = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'pending')
            RETURNING *
            """,
            email,
            password_hash,
            "Test User",
            "creator"
        )
        
        # Create and use a token
        token = await create_password_reset_token(str(user["id"]), expires_in_hours=1)
        
        # Use the token once
        response1 = await client.post(
            "/auth/reset-password",
            json={
                "token": token,
                "new_password": "first_reset_password"
            }
        )
        assert response1.status_code == 200
        
        # Try to use the same token again
        response2 = await client.post(
            "/auth/reset-password",
            json={
                "token": token,
                "new_password": "second_reset_password"
            }
        )
        
        assert response2.status_code == 400
        assert "invalid" in response2.json()["detail"].lower() or "expired" in response2.json()["detail"].lower()
    
    @pytest.mark.asyncio
    async def test_reset_password_too_short(self, client: AsyncClient):
        """Test resetting password with password shorter than 8 characters"""
        # Create a user and token
        email = "test_short_pass@example.com"
        password_hash = hash_password("password123")
        
        user = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'pending')
            RETURNING *
            """,
            email,
            password_hash,
            "Test User",
            "creator"
        )
        
        token = await create_password_reset_token(str(user["id"]), expires_in_hours=1)
        
        # Try to reset with short password
        response = await client.post(
            "/auth/reset-password",
            json={
                "token": token,
                "new_password": "short"
            }
        )
        
        assert response.status_code == 422  # Validation error
    
    @pytest.mark.asyncio
    async def test_reset_password_missing_fields(self, client: AsyncClient):
        """Test resetting password with missing fields"""
        # Missing token
        response1 = await client.post(
            "/auth/reset-password",
            json={"new_password": "new_password123"}
        )
        assert response1.status_code == 422
        
        # Missing new_password
        response2 = await client.post(
            "/auth/reset-password",
            json={"token": "some_token"}
        )
        assert response2.status_code == 422
    
    @pytest.mark.asyncio
    async def test_reset_password_invalidates_all_tokens(self, client: AsyncClient):
        """Test that resetting password invalidates all tokens for the user"""
        # Create a user
        email = "test_invalidate_all@example.com"
        password_hash = hash_password("password123")
        
        user = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'pending')
            RETURNING *
            """,
            email,
            password_hash,
            "Test User",
            "creator"
        )
        
        # Create multiple tokens
        token1 = await create_password_reset_token(str(user["id"]), expires_in_hours=1)
        token2 = await create_password_reset_token(str(user["id"]), expires_in_hours=1)
        token3 = await create_password_reset_token(str(user["id"]), expires_in_hours=1)
        
        # Verify all tokens are unused
        tokens_before = await Database.fetch(
            "SELECT token, used FROM password_reset_tokens WHERE user_id = $1",
            user["id"]
        )
        assert all(not t["used"] for t in tokens_before)
        
        # Use one token to reset password
        response = await client.post(
            "/auth/reset-password",
            json={
                "token": token1,
                "new_password": "new_password123"
            }
        )
        assert response.status_code == 200
        
        # Verify all tokens are now marked as used
        tokens_after = await Database.fetch(
            "SELECT token, used FROM password_reset_tokens WHERE user_id = $1",
            user["id"]
        )
        assert all(t["used"] for t in tokens_after)
        
        # Verify other tokens can't be used
        response2 = await client.post(
            "/auth/reset-password",
            json={
                "token": token2,
                "new_password": "another_password"
            }
        )
        assert response2.status_code == 400
    
    @pytest.mark.asyncio
    async def test_reset_password_can_login_with_new_password(self, client: AsyncClient):
        """Test that after resetting password, user can login with new password"""
        # Create a user
        email = "test_login_after_reset@example.com"
        old_password = "old_password123"
        new_password = "new_password123"
        old_password_hash = hash_password(old_password)
        
        user = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'pending')
            RETURNING *
            """,
            email,
            old_password_hash,
            "Test User",
            "creator"
        )
        
        # Create reset token
        token = await create_password_reset_token(str(user["id"]), expires_in_hours=1)
        
        # Reset password
        reset_response = await client.post(
            "/auth/reset-password",
            json={
                "token": token,
                "new_password": new_password
            }
        )
        assert reset_response.status_code == 200
        
        # Try to login with old password (should fail)
        old_login_response = await client.post(
            "/auth/login",
            json={
                "email": email,
                "password": old_password
            }
        )
        assert old_login_response.status_code == 401
        
        # Try to login with new password (should succeed)
        new_login_response = await client.post(
            "/auth/login",
            json={
                "email": email,
                "password": new_password
            }
        )
        assert new_login_response.status_code == 200
        assert new_login_response.json()["email"] == email

