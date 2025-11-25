"""
Tests for user endpoints
"""
import pytest
from fastapi import status


class TestUsers:
    """Test user endpoints"""
    
    def test_update_email_success(self, client, test_user):
        """Test updating email successfully"""
        response = client.put(
            "/users/me",
            headers={"X-User-Id": test_user},
            json={
                "email": "updated@test.com"
            }
        )
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert data["email"] == "updated@test.com"
        assert data["id"] == test_user
    
    def test_update_email_duplicate(self, client):
        """Test updating email to an already used email"""
        # Create two users
        user1_response = client.post(
            "/auth/register",
            json={
                "email": "user1@test.com",
                "password": "testpassword123",
                "type": "creator",
                "name": "User 1"
            }
        )
        user1_id = user1_response.json()["id"]
        
        client.post(
            "/auth/register",
            json={
                "email": "user2@test.com",
                "password": "testpassword123",
                "type": "creator",
                "name": "User 2"
            }
        )
        
        # Try to update user1's email to user2's email
        response = client.put(
            "/users/me",
            headers={"X-User-Id": user1_id},
            json={
                "email": "user2@test.com"
            }
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert "already registered" in response.json()["detail"].lower()
    
    def test_update_email_invalid_format(self, client, test_user):
        """Test updating email with invalid format"""
        response = client.put(
            "/users/me",
            headers={"X-User-Id": test_user},
            json={
                "email": "invalid-email"
            }
        )
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY
    
    def test_update_email_missing(self, client, test_user):
        """Test updating email with missing email field"""
        response = client.put(
            "/users/me",
            headers={"X-User-Id": test_user},
            json={}
        )
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY
    
    def test_unauthorized_access(self, client):
        """Test accessing user endpoints without authentication"""
        response = client.put(
            "/users/me",
            json={"email": "test@test.com"}
        )
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY  # Missing header
    
    @pytest.mark.asyncio
    async def test_update_email_same_email(self, client, test_user):
        """Test updating email to the same email (should work)"""
        # Get current email first
        from app.database import Database
        
        user = await Database.fetchrow(
            "SELECT email FROM users WHERE id = $1",
            test_user
        )
        current_email = user['email'] if user else None
        
        # Try to update to same email
        response = client.put(
            "/users/me",
            headers={"X-User-Id": test_user},
            json={
                "email": current_email
            }
        )
        # Should succeed even if it's the same email
        assert response.status_code == status.HTTP_200_OK

