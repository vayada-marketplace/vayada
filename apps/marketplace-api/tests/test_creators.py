"""
Tests for creator endpoints
"""
import pytest
from fastapi import status
import json


class TestCreators:
    """Test creator profile endpoints"""
    
    def test_get_creator_profile_not_found(self, client):
        """Test getting creator profile when profile doesn't exist"""
        # Create a user without creator profile
        response = client.post(
            "/auth/register",
            json={
                "email": "noprofile@test.com",
                "password": "testpassword123",
                "type": "creator",
                "name": "No Profile"
            }
        )
        user_id = response.json()["id"]
        
        # Try to get profile
        response = client.get(
            "/creators/me",
            headers={"X-User-Id": user_id}
        )
        assert response.status_code == status.HTTP_404_NOT_FOUND
    
    def test_get_creator_profile_success(self, client, test_creator_profile):
        """Test getting creator profile successfully"""
        creator_id, user_id = test_creator_profile
        
        response = client.get(
            "/creators/me",
            headers={"X-User-Id": user_id}
        )
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert data["id"] == creator_id
        assert data["user_id"] == user_id
        assert data["location"] == "Test Location"
        assert data["short_description"] == "Test description"
        assert data["profile_complete"] == False
        assert isinstance(data["platforms"], list)
    
    def test_update_creator_profile(self, client, test_creator_profile):
        """Test updating creator profile"""
        creator_id, user_id = test_creator_profile
        
        response = client.put(
            "/creators/me",
            headers={"X-User-Id": user_id},
            json={
                "location": "Updated Location",
                "short_description": "Updated description",
                "portfolio_link": "https://portfolio.com",
                "phone": "+1-555-123-4567"
            }
        )
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert data["location"] == "Updated Location"
        assert data["short_description"] == "Updated description"
        assert data["portfolio_link"] == "https://portfolio.com"
        assert data["phone"] == "+1-555-123-4567"
    
    def test_update_creator_profile_partial(self, client, test_creator_profile):
        """Test updating creator profile with partial data"""
        creator_id, user_id = test_creator_profile
        
        response = client.put(
            "/creators/me",
            headers={"X-User-Id": user_id},
            json={
                "location": "New Location Only"
            }
        )
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert data["location"] == "New Location Only"
        # Other fields should remain unchanged
        assert data["short_description"] == "Test description"
    
    def test_update_creator_profile_no_fields(self, client, test_creator_profile):
        """Test updating creator profile with no fields"""
        creator_id, user_id = test_creator_profile
        
        response = client.put(
            "/creators/me",
            headers={"X-User-Id": user_id},
            json={}
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
    
    def test_create_platform(self, client, test_creator_profile):
        """Test creating a platform"""
        creator_id, user_id = test_creator_profile
        
        response = client.post(
            "/creators/me/platforms",
            headers={"X-User-Id": user_id},
            json={
                "name": "Instagram",
                "handle": "@testcreator",
                "followers": 50000,
                "engagement_rate": 4.5,
                "top_countries": [
                    {"country": "USA", "percentage": 40},
                    {"country": "UK", "percentage": 30}
                ],
                "top_age_groups": [
                    {"ageRange": "25-34", "percentage": 50}
                ],
                "gender_split": {"male": 45, "female": 55}
            }
        )
        assert response.status_code == status.HTTP_201_CREATED
        data = response.json()
        assert data["name"] == "Instagram"
        assert data["handle"] == "@testcreator"
        assert data["followers"] == 50000
        assert data["engagement_rate"] == 4.5
        assert len(data["top_countries"]) == 2
        assert data["gender_split"]["male"] == 45.0
        assert "id" in data
    
    def test_create_platform_invalid_name(self, client, test_creator_profile):
        """Test creating platform with invalid name"""
        creator_id, user_id = test_creator_profile
        
        response = client.post(
            "/creators/me/platforms",
            headers={"X-User-Id": user_id},
            json={
                "name": "InvalidPlatform",
                "handle": "@test",
                "followers": 1000,
                "engagement_rate": 3.0
            }
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
    
    def test_create_duplicate_platform(self, client, test_creator_profile):
        """Test creating duplicate platform"""
        creator_id, user_id = test_creator_profile
        
        # Create first platform
        client.post(
            "/creators/me/platforms",
            headers={"X-User-Id": user_id},
            json={
                "name": "Instagram",
                "handle": "@test1",
                "followers": 1000,
                "engagement_rate": 3.0
            }
        )
        
        # Try to create duplicate
        response = client.post(
            "/creators/me/platforms",
            headers={"X-User-Id": user_id},
            json={
                "name": "Instagram",
                "handle": "@test2",
                "followers": 2000,
                "engagement_rate": 4.0
            }
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert "already exists" in response.json()["detail"].lower()
    
    def test_update_platform(self, client, test_creator_profile):
        """Test updating a platform"""
        creator_id, user_id = test_creator_profile
        
        # Create platform first
        create_response = client.post(
            "/creators/me/platforms",
            headers={"X-User-Id": user_id},
            json={
                "name": "TikTok",
                "handle": "@original",
                "followers": 10000,
                "engagement_rate": 3.5
            }
        )
        platform_id = create_response.json()["id"]
        
        # Update platform
        response = client.put(
            f"/creators/me/platforms/{platform_id}",
            headers={"X-User-Id": user_id},
            json={
                "handle": "@updated",
                "followers": 20000,
                "engagement_rate": 4.0
            }
        )
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert data["handle"] == "@updated"
        assert data["followers"] == 20000
        assert data["engagement_rate"] == 4.0
        assert data["name"] == "TikTok"  # Name shouldn't change
    
    def test_update_platform_not_found(self, client, test_creator_profile):
        """Test updating non-existent platform"""
        creator_id, user_id = test_creator_profile
        fake_id = "00000000-0000-0000-0000-000000000000"
        
        response = client.put(
            f"/creators/me/platforms/{fake_id}",
            headers={"X-User-Id": user_id},
            json={
                "handle": "@updated"
            }
        )
        assert response.status_code == status.HTTP_404_NOT_FOUND
    
    def test_delete_platform(self, client, test_creator_profile):
        """Test deleting a platform"""
        creator_id, user_id = test_creator_profile
        
        # Create platform first
        create_response = client.post(
            "/creators/me/platforms",
            headers={"X-User-Id": user_id},
            json={
                "name": "YouTube",
                "handle": "@todelete",
                "followers": 5000,
                "engagement_rate": 2.5
            }
        )
        platform_id = create_response.json()["id"]
        
        # Delete platform
        response = client.delete(
            f"/creators/me/platforms/{platform_id}",
            headers={"X-User-Id": user_id}
        )
        assert response.status_code == status.HTTP_200_OK
        assert "deleted successfully" in response.json()["message"].lower()
        
        # Verify it's deleted
        get_response = client.get(
            "/creators/me",
            headers={"X-User-Id": user_id}
        )
        platforms = get_response.json()["platforms"]
        assert len(platforms) == 0
    
    def test_delete_platform_not_found(self, client, test_creator_profile):
        """Test deleting non-existent platform"""
        creator_id, user_id = test_creator_profile
        fake_id = "00000000-0000-0000-0000-000000000000"
        
        response = client.delete(
            f"/creators/me/platforms/{fake_id}",
            headers={"X-User-Id": user_id}
        )
        assert response.status_code == status.HTTP_404_NOT_FOUND
    
    def test_unauthorized_access(self, client):
        """Test accessing creator endpoints without authentication"""
        response = client.get("/creators/me")
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY  # Missing header
    
    def test_profile_complete_after_platform(self, client, test_creator_profile):
        """Test that profile_complete becomes true after adding platform"""
        creator_id, user_id = test_creator_profile
        
        # Initially should be false
        response = client.get(
            "/creators/me",
            headers={"X-User-Id": user_id}
        )
        assert response.json()["profile_complete"] == False
        
        # Add platform
        client.post(
            "/creators/me/platforms",
            headers={"X-User-Id": user_id},
            json={
                "name": "Facebook",
                "handle": "@test",
                "followers": 1000,
                "engagement_rate": 3.0
            }
        )
        
        # Should now be true
        response = client.get(
            "/creators/me",
            headers={"X-User-Id": user_id}
        )
        assert response.json()["profile_complete"] == True

