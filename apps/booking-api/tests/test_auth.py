"""
Tests for /auth endpoints — register, login, token validation, password management.
"""
import jwt as pyjwt

from app.config import settings
from app.database import AuthDatabase
from tests.conftest import (
    create_expired_jwt_token,
    create_test_user,
    generate_test_email,
    get_auth_headers,
)


class TestRegister:
    async def test_register_success(self, client, cleanup_database):
        email = generate_test_email()
        resp = await client.post(
            "/auth/register",
            json={
                "email": email,
                "password": "StrongPass123!",
                "name": "John Hotel",
                "terms_accepted": True,
                "privacy_accepted": True,
            },
        )
        assert resp.status_code == 201
        body = resp.json()
        assert body["email"] == email
        assert body["name"] == "John Hotel"
        assert body["type"] == "hotel"
        assert body["status"] == "pending"
        assert "access_token" in body

    async def test_register_returns_valid_jwt(self, client, cleanup_database):
        email = generate_test_email()
        resp = await client.post(
            "/auth/register",
            json={
                "email": email,
                "password": "StrongPass123!",
                "terms_accepted": True,
                "privacy_accepted": True,
            },
        )
        body = resp.json()
        token = body["access_token"]
        decoded = pyjwt.decode(
            token, settings.JWT_SECRET_KEY, algorithms=[settings.JWT_ALGORITHM]
        )
        assert decoded["sub"] == body["id"]
        assert decoded["email"] == email

    async def test_register_missing_terms(self, client, cleanup_database):
        resp = await client.post(
            "/auth/register",
            json={
                "email": generate_test_email(),
                "password": "StrongPass123!",
                "terms_accepted": False,
                "privacy_accepted": True,
            },
        )
        assert resp.status_code == 400
        assert "Terms of Service" in resp.json()["detail"]

    async def test_register_missing_privacy(self, client, cleanup_database):
        resp = await client.post(
            "/auth/register",
            json={
                "email": generate_test_email(),
                "password": "StrongPass123!",
                "terms_accepted": True,
                "privacy_accepted": False,
            },
        )
        assert resp.status_code == 400
        assert "Privacy Policy" in resp.json()["detail"]

    async def test_register_duplicate_email(self, client, cleanup_database):
        email = generate_test_email()
        resp1 = await client.post(
            "/auth/register",
            json={
                "email": email,
                "password": "StrongPass123!",
                "terms_accepted": True,
                "privacy_accepted": True,
            },
        )
        assert resp1.status_code == 201

        resp2 = await client.post(
            "/auth/register",
            json={
                "email": email,
                "password": "AnotherPass123!",
                "terms_accepted": True,
                "privacy_accepted": True,
            },
        )
        assert resp2.status_code == 400
        assert "Email already registered" in resp2.json()["detail"]

    async def test_register_short_password(self, client):
        resp = await client.post(
            "/auth/register",
            json={
                "email": generate_test_email(),
                "password": "Short1!",
                "terms_accepted": True,
                "privacy_accepted": True,
            },
        )
        assert resp.status_code == 422

    async def test_register_gdpr_consent(self, client, cleanup_database):
        email = generate_test_email()
        resp = await client.post(
            "/auth/register",
            json={
                "email": email,
                "password": "StrongPass123!",
                "terms_accepted": True,
                "privacy_accepted": True,
                "marketing_consent": True,
            },
        )
        assert resp.status_code == 201
        user_id = resp.json()["id"]

        # Verify consent_history has 3 rows (terms, privacy, marketing)
        rows = await AuthDatabase.fetch(
            "SELECT consent_type FROM consent_history WHERE user_id = $1 ORDER BY consent_type",
            user_id,
        )
        consent_types = [row["consent_type"] for row in rows]
        assert "marketing" in consent_types
        assert "privacy" in consent_types
        assert "terms" in consent_types
        assert len(consent_types) == 3

    async def test_register_name_defaults_to_email_prefix(self, client, cleanup_database):
        email = generate_test_email()
        resp = await client.post(
            "/auth/register",
            json={
                "email": email,
                "password": "StrongPass123!",
                "terms_accepted": True,
                "privacy_accepted": True,
            },
        )
        assert resp.status_code == 201
        body = resp.json()
        expected_prefix = email.split("@")[0].capitalize()
        assert body["name"] == expected_prefix


class TestLogin:
    async def test_login_success(self, client, cleanup_database):
        user = await create_test_user(password="LoginPass123!")
        resp = await client.post(
            "/auth/login",
            json={"email": user["email"], "password": "LoginPass123!"},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["email"] == user["email"]
        assert body["id"] == str(user["id"])
        assert "access_token" in body

    async def test_login_wrong_password(self, client, cleanup_database):
        user = await create_test_user(password="CorrectPass123!")
        resp = await client.post(
            "/auth/login",
            json={"email": user["email"], "password": "WrongPassword123!"},
        )
        assert resp.status_code == 401
        assert "Invalid email or password" in resp.json()["detail"]

    async def test_login_wrong_email(self, client, cleanup_database):
        resp = await client.post(
            "/auth/login",
            json={"email": "nonexistent@example.com", "password": "SomePass123!"},
        )
        assert resp.status_code == 401
        assert "Invalid email or password" in resp.json()["detail"]

    async def test_login_suspended_user(self, client, cleanup_database):
        user = await create_test_user(
            password="SuspendedPass123!", user_status="suspended"
        )
        resp = await client.post(
            "/auth/login",
            json={"email": user["email"], "password": "SuspendedPass123!"},
        )
        assert resp.status_code == 403
        assert "suspended" in resp.json()["detail"].lower()


class TestValidateToken:
    async def test_validate_valid_token(self, client, cleanup_database):
        user = await create_test_user()
        resp = await client.post(
            "/auth/validate-token",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["valid"] is True
        assert body["user_id"] == str(user["id"])
        assert body["email"] == user["email"]

    async def test_validate_expired_token(self, client):
        token = create_expired_jwt_token()
        resp = await client.post(
            "/auth/validate-token",
            headers=get_auth_headers(token),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["valid"] is False
        assert body["expired"] is True

    async def test_validate_invalid_token(self, client):
        resp = await client.post(
            "/auth/validate-token",
            headers=get_auth_headers("garbage.invalid.token"),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["valid"] is False

    async def test_validate_no_token(self, client):
        resp = await client.post("/auth/validate-token")
        assert resp.status_code == 200
        body = resp.json()
        assert body["valid"] is False
        assert body["expired"] is False


class TestForgotPassword:
    async def test_forgot_password_success(self, client, cleanup_database):
        user = await create_test_user()
        resp = await client.post(
            "/auth/forgot-password",
            json={"email": user["email"]},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert "message" in body
        # In DEBUG mode, token is returned
        assert body["token"] is not None

    async def test_forgot_password_nonexistent_email(self, client):
        resp = await client.post(
            "/auth/forgot-password",
            json={"email": "nobody@example.com"},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert "message" in body
        assert body["token"] is None


class TestResetPassword:
    async def test_reset_password_success(self, client, cleanup_database):
        user = await create_test_user(password="OldPassword123!")
        # Get reset token via forgot-password
        forgot_resp = await client.post(
            "/auth/forgot-password",
            json={"email": user["email"]},
        )
        reset_token = forgot_resp.json()["token"]

        # Reset password
        resp = await client.post(
            "/auth/reset-password",
            json={"token": reset_token, "new_password": "NewPassword123!"},
        )
        assert resp.status_code == 200

        # Login with new password works
        login_resp = await client.post(
            "/auth/login",
            json={"email": user["email"], "password": "NewPassword123!"},
        )
        assert login_resp.status_code == 200

    async def test_reset_password_used_token(self, client, cleanup_database):
        user = await create_test_user(password="OldPassword123!")
        forgot_resp = await client.post(
            "/auth/forgot-password",
            json={"email": user["email"]},
        )
        reset_token = forgot_resp.json()["token"]

        # Use token once
        resp1 = await client.post(
            "/auth/reset-password",
            json={"token": reset_token, "new_password": "NewPassword123!"},
        )
        assert resp1.status_code == 200

        # Try to use same token again
        resp2 = await client.post(
            "/auth/reset-password",
            json={"token": reset_token, "new_password": "AnotherPass123!"},
        )
        assert resp2.status_code == 400
        assert "Invalid or expired" in resp2.json()["detail"]

    async def test_reset_password_invalid_token(self, client):
        resp = await client.post(
            "/auth/reset-password",
            json={"token": "completely-invalid-token", "new_password": "NewPass123!"},
        )
        assert resp.status_code == 400


class TestChangePassword:
    async def test_change_password_success(self, client, cleanup_database):
        user = await create_test_user(password="OldPassword123!")
        resp = await client.post(
            "/auth/change-password",
            json={
                "current_password": "OldPassword123!",
                "new_password": "NewPassword123!",
            },
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200

        # Login with new password works
        login_resp = await client.post(
            "/auth/login",
            json={"email": user["email"], "password": "NewPassword123!"},
        )
        assert login_resp.status_code == 200

    async def test_change_password_wrong_current(self, client, cleanup_database):
        user = await create_test_user(password="CorrectOld123!")
        resp = await client.post(
            "/auth/change-password",
            json={
                "current_password": "WrongOldPassword123!",
                "new_password": "NewPassword123!",
            },
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 400
        assert "Current password is incorrect" in resp.json()["detail"]

    async def test_change_password_no_auth(self, client):
        resp = await client.post(
            "/auth/change-password",
            json={
                "current_password": "OldPass123!",
                "new_password": "NewPass123!",
            },
        )
        assert resp.status_code == 403


class TestChangeEmail:
    async def test_change_email_success(self, client, cleanup_database):
        user = await create_test_user(password="MyPass123!")
        new_email = generate_test_email()
        resp = await client.post(
            "/auth/change-email",
            json={"new_email": new_email, "password": "MyPass123!"},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["email"] == new_email
        assert body["message"] == "Email updated successfully"

        # Can login with new email
        login_resp = await client.post(
            "/auth/login",
            json={"email": new_email, "password": "MyPass123!"},
        )
        assert login_resp.status_code == 200

    async def test_change_email_wrong_password(self, client, cleanup_database):
        user = await create_test_user(password="CorrectPass123!")
        resp = await client.post(
            "/auth/change-email",
            json={"new_email": generate_test_email(), "password": "WrongPass123!"},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 400
        assert "Password is incorrect" in resp.json()["detail"]

    async def test_change_email_same_email(self, client, cleanup_database):
        user = await create_test_user(password="MyPass123!")
        resp = await client.post(
            "/auth/change-email",
            json={"new_email": user["email"], "password": "MyPass123!"},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 400
        assert "same as the current email" in resp.json()["detail"]

    async def test_change_email_already_in_use(self, client, cleanup_database):
        user1 = await create_test_user(password="Pass123!")
        user2 = await create_test_user(password="Pass456!")
        resp = await client.post(
            "/auth/change-email",
            json={"new_email": user2["email"], "password": "Pass123!"},
            headers=get_auth_headers(user1["token"]),
        )
        assert resp.status_code == 409
        assert "already in use" in resp.json()["detail"]

    async def test_change_email_no_auth(self, client):
        resp = await client.post(
            "/auth/change-email",
            json={"new_email": "new@example.com", "password": "Pass123!"},
        )
        assert resp.status_code == 403
