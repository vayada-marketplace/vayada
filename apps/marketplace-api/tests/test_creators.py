"""
Tests for creators endpoints
"""
import pytest
from httpx import AsyncClient
from app.database import Database
from app.auth import hash_password
from app.jwt_utils import create_access_token


class TestGetCreatorProfileStatus:
    """Tests for GET /creators/me/profile-status endpoint"""
    
    @pytest.mark.asyncio
    async def test_get_profile_status_success_complete(self, client: AsyncClient):
        """Test getting profile status for a complete profile"""
        # Create a creator user with complete profile
        email = "test_creator_complete@example.com"
        password_hash = hash_password("password123")
        
        user = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'pending')
            RETURNING *
            """,
            email,
            password_hash,
            "Test Creator",
            "creator"
        )
        
        creator = await Database.fetchrow(
            """
            INSERT INTO creators (user_id, location, short_description)
            VALUES ($1, $2, $3)
            RETURNING *
            """,
            user["id"],
            "New York, USA",
            "A talented content creator with expertise in travel and lifestyle"
        )
        
        # Add a platform
        await Database.execute(
            """
            INSERT INTO creator_platforms (creator_id, name, handle, followers, engagement_rate)
            VALUES ($1, $2, $3, $4, $5)
            """,
            creator["id"],
            "Instagram",
            "@testcreator",
            10000,
            3.5
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "creator"}
        )
        
        # Get profile status
        response = await client.get(
            "/creators/me/profile-status",
            headers={"Authorization": f"Bearer {token}"}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["profile_complete"] is True
        assert len(data["missing_fields"]) == 0
        assert data["missing_platforms"] is False
        assert len(data["completion_steps"]) == 0
    
    @pytest.mark.asyncio
    async def test_get_profile_status_incomplete_missing_fields(self, client: AsyncClient):
        """Test getting profile status for incomplete profile with missing fields"""
        # Create a creator user with incomplete profile
        email = "test_creator_incomplete@example.com"
        password_hash = hash_password("password123")
        
        user = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'pending')
            RETURNING *
            """,
            email,
            password_hash,
            "",  # Missing name
            "creator"
        )
        
        creator = await Database.fetchrow(
            """
            INSERT INTO creators (user_id, location, short_description)
            VALUES ($1, $2, $3)
            RETURNING *
            """,
            user["id"],
            None,  # Missing location
            None   # Missing description
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "creator"}
        )
        
        # Get profile status
        response = await client.get(
            "/creators/me/profile-status",
            headers={"Authorization": f"Bearer {token}"}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["profile_complete"] is False
        assert "name" in data["missing_fields"]
        assert "location" in data["missing_fields"]
        assert "short_description" in data["missing_fields"]
        assert data["missing_platforms"] is True
        assert len(data["completion_steps"]) > 0
    
    @pytest.mark.asyncio
    async def test_get_profile_status_missing_platforms(self, client: AsyncClient):
        """Test getting profile status when platforms are missing"""
        # Create a creator user with all fields but no platforms
        email = "test_creator_no_platforms@example.com"
        password_hash = hash_password("password123")
        
        user = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'pending')
            RETURNING *
            """,
            email,
            password_hash,
            "Test Creator",
            "creator"
        )
        
        creator = await Database.fetchrow(
            """
            INSERT INTO creators (user_id, location, short_description)
            VALUES ($1, $2, $3)
            RETURNING *
            """,
            user["id"],
            "New York, USA",
            "A talented content creator"
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "creator"}
        )
        
        # Get profile status
        response = await client.get(
            "/creators/me/profile-status",
            headers={"Authorization": f"Bearer {token}"}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["profile_complete"] is False
        assert data["missing_platforms"] is True
        assert "Add at least one social media platform" in data["completion_steps"]
    
    @pytest.mark.asyncio
    async def test_get_profile_status_invalid_platforms(self, client: AsyncClient):
        """Test getting profile status when platforms exist but are invalid (no followers)"""
        # Create a creator user with invalid platform
        email = "test_creator_invalid_platform@example.com"
        password_hash = hash_password("password123")
        
        user = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'pending')
            RETURNING *
            """,
            email,
            password_hash,
            "Test Creator",
            "creator"
        )
        
        creator = await Database.fetchrow(
            """
            INSERT INTO creators (user_id, location, short_description)
            VALUES ($1, $2, $3)
            RETURNING *
            """,
            user["id"],
            "New York, USA",
            "A talented content creator"
        )
        
        # Add invalid platform (no followers)
        await Database.execute(
            """
            INSERT INTO creator_platforms (creator_id, name, handle, followers, engagement_rate)
            VALUES ($1, $2, $3, $4, $5)
            """,
            creator["id"],
            "Instagram",
            "@testcreator",
            0,  # Invalid - no followers
            3.5
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "creator"}
        )
        
        # Get profile status
        response = await client.get(
            "/creators/me/profile-status",
            headers={"Authorization": f"Bearer {token}"}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["profile_complete"] is False
        assert data["missing_platforms"] is True
    
    @pytest.mark.asyncio
    async def test_get_profile_status_no_auth(self, client: AsyncClient):
        """Test getting profile status without authentication"""
        response = await client.get("/creators/me/profile-status")
        
        assert response.status_code == 403  # Forbidden
    
    @pytest.mark.asyncio
    async def test_get_profile_status_invalid_token(self, client: AsyncClient):
        """Test getting profile status with invalid token"""
        response = await client.get(
            "/creators/me/profile-status",
            headers={"Authorization": "Bearer invalid_token"}
        )
        
        assert response.status_code == 401  # Unauthorized (invalid token)
    
    @pytest.mark.asyncio
    async def test_get_profile_status_hotel_user(self, client: AsyncClient):
        """Test that hotel users cannot access creator endpoints"""
        # Create a hotel user
        email = "test_hotel@example.com"
        password_hash = hash_password("password123")
        
        user = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'pending')
            RETURNING *
            """,
            email,
            password_hash,
            "Test Hotel",
            "hotel"
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "hotel"}
        )
        
        # Try to get creator profile status
        response = await client.get(
            "/creators/me/profile-status",
            headers={"Authorization": f"Bearer {token}"}
        )
        
        assert response.status_code == 403
        assert "only available for creators" in response.json()["detail"].lower()
    
    @pytest.mark.asyncio
    async def test_get_profile_status_nonexistent_user(self, client: AsyncClient):
        """Test getting profile status for non-existent user"""
        # Create token for non-existent user
        fake_user_id = "00000000-0000-0000-0000-000000000000"
        token = create_access_token(
            data={"sub": fake_user_id, "email": "fake@example.com", "type": "creator"}
        )
        
        response = await client.get(
            "/creators/me/profile-status",
            headers={"Authorization": f"Bearer {token}"}
        )
        
        # The dependency checks user existence first and returns 401 if not found
        assert response.status_code == 401
        assert "not found" in response.json()["detail"].lower() or "invalid" in response.json()["detail"].lower()


class TestGetCreatorProfile:
    """Tests for GET /creators/me endpoint"""
    
    @pytest.mark.asyncio
    async def test_get_profile_success(self, client: AsyncClient):
        """Test getting complete creator profile"""
        # Create a creator user with complete profile
        email = "test_creator_profile@example.com"
        password_hash = hash_password("password123")
        
        user = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'pending')
            RETURNING *
            """,
            email,
            password_hash,
            "Test Creator",
            "creator"
        )
        
        creator = await Database.fetchrow(
            """
            INSERT INTO creators (user_id, location, short_description, portfolio_link, phone)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *
            """,
            user["id"],
            "New York, USA",
            "A talented content creator",
            "https://portfolio.example.com",
            "+1234567890"
        )
        
        # Add platforms
        await Database.execute(
            """
            INSERT INTO creator_platforms (creator_id, name, handle, followers, engagement_rate, top_countries, top_age_groups, gender_split)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            """,
            creator["id"],
            "Instagram",
            "@testcreator",
            10000,
            3.5,
            '[{"country": "US"}]',
            '[{"ageRange": "18-24"}]',
            '{"male": 30, "female": 70}'
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "creator"}
        )
        
        # Get profile
        response = await client.get(
            "/creators/me",
            headers={"Authorization": f"Bearer {token}"}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["id"] == str(creator["id"])
        assert data["name"] == "Test Creator"
        assert data["email"] == email
        assert data["location"] == "New York, USA"
        assert data["short_description"] == "A talented content creator"
        assert data["portfolio_link"] == "https://portfolio.example.com"
        assert data["phone"] == "+1234567890"
        assert len(data["platforms"]) == 1
        assert data["platforms"][0]["name"] == "Instagram"
        assert data["platforms"][0]["handle"] == "@testcreator"
        assert data["platforms"][0]["followers"] == 10000
        assert data["rating"]["total_reviews"] == 0
        assert data["rating"]["average_rating"] == 0.0
    
    @pytest.mark.asyncio
    async def test_get_profile_with_ratings(self, client: AsyncClient):
        """Test getting profile with ratings and reviews"""
        # Create a creator user
        email = "test_creator_ratings@example.com"
        password_hash = hash_password("password123")
        
        user = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'pending')
            RETURNING *
            """,
            email,
            password_hash,
            "Test Creator",
            "creator"
        )
        
        creator = await Database.fetchrow(
            """
            INSERT INTO creators (user_id, location, short_description)
            VALUES ($1, $2, $3)
            RETURNING *
            """,
            user["id"],
            "New York, USA",
            "A talented content creator"
        )
        
        # Create a hotel for rating
        hotel_user = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'pending')
            RETURNING *
            """,
            "test_hotel_rating@example.com",
            hash_password("password123"),
            "Test Hotel",
            "hotel"
        )
        
        hotel = await Database.fetchrow(
            """
            INSERT INTO hotel_profiles (user_id, name, location)
            VALUES ($1, $2, $3)
            RETURNING *
            """,
            hotel_user["id"],
            "Test Hotel",
            "New York"
        )
        
        # Add ratings
        await Database.execute(
            """
            INSERT INTO creator_ratings (creator_id, hotel_id, rating, comment, created_at)
            VALUES ($1, $2, $3, $4, now())
            """,
            creator["id"],
            hotel["id"],
            5,
            "Excellent creator!"
        )
        
        await Database.execute(
            """
            INSERT INTO creator_ratings (creator_id, hotel_id, rating, comment, created_at)
            VALUES ($1, $2, $3, $4, now())
            """,
            creator["id"],
            hotel["id"],
            4,
            "Very good work"
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "creator"}
        )
        
        # Get profile
        response = await client.get(
            "/creators/me",
            headers={"Authorization": f"Bearer {token}"}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["rating"]["total_reviews"] == 2
        assert data["rating"]["average_rating"] == 4.5
        assert len(data["rating"]["reviews"]) == 2
        assert data["rating"]["reviews"][0]["rating"] in [5, 4]
        assert data["rating"]["reviews"][0]["hotel_name"] == "Test Hotel"
    
    @pytest.mark.asyncio
    async def test_get_profile_empty_profile(self, client: AsyncClient):
        """Test getting profile with minimal data"""
        # Create a creator user with minimal profile
        email = "test_creator_minimal@example.com"
        password_hash = hash_password("password123")
        
        user = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'pending')
            RETURNING *
            """,
            email,
            password_hash,
            "Test Creator",
            "creator"
        )
        
        creator = await Database.fetchrow(
            """
            INSERT INTO creators (user_id, location, short_description)
            VALUES ($1, $2, $3)
            RETURNING *
            """,
            user["id"],
            None,
            None
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "creator"}
        )
        
        # Get profile
        response = await client.get(
            "/creators/me",
            headers={"Authorization": f"Bearer {token}"}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["id"] == str(creator["id"])
        assert data["name"] == "Test Creator"
        assert data["email"] == email
        assert data["location"] == ""  # Empty string for None
        assert data["short_description"] is None
        assert len(data["platforms"]) == 0
        assert data["rating"]["total_reviews"] == 0
    
    @pytest.mark.asyncio
    async def test_get_profile_multiple_platforms(self, client: AsyncClient):
        """Test getting profile with multiple platforms"""
        # Create a creator user
        email = "test_creator_multi@example.com"
        password_hash = hash_password("password123")
        
        user = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'pending')
            RETURNING *
            """,
            email,
            password_hash,
            "Test Creator",
            "creator"
        )
        
        creator = await Database.fetchrow(
            """
            INSERT INTO creators (user_id, location, short_description)
            VALUES ($1, $2, $3)
            RETURNING *
            """,
            user["id"],
            "New York, USA",
            "A talented content creator"
        )
        
        # Add multiple platforms
        await Database.execute(
            """
            INSERT INTO creator_platforms (creator_id, name, handle, followers, engagement_rate)
            VALUES ($1, $2, $3, $4, $5)
            """,
            creator["id"],
            "Instagram",
            "@testcreator",
            10000,
            3.5
        )
        
        await Database.execute(
            """
            INSERT INTO creator_platforms (creator_id, name, handle, followers, engagement_rate)
            VALUES ($1, $2, $3, $4, $5)
            """,
            creator["id"],
            "TikTok",
            "@testcreator",
            5000,
            4.0
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "creator"}
        )
        
        # Get profile
        response = await client.get(
            "/creators/me",
            headers={"Authorization": f"Bearer {token}"}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert len(data["platforms"]) == 2
        # Platforms should be ordered by name
        platform_names = [p["name"] for p in data["platforms"]]
        assert "Instagram" in platform_names
        assert "TikTok" in platform_names
    
    @pytest.mark.asyncio
    async def test_get_profile_no_auth(self, client: AsyncClient):
        """Test getting profile without authentication"""
        response = await client.get("/creators/me")
        
        assert response.status_code == 403  # Forbidden
    
    @pytest.mark.asyncio
    async def test_get_profile_hotel_user(self, client: AsyncClient):
        """Test that hotel users cannot access creator endpoints"""
        # Create a hotel user
        email = "test_hotel_profile@example.com"
        password_hash = hash_password("password123")
        
        user = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'pending')
            RETURNING *
            """,
            email,
            password_hash,
            "Test Hotel",
            "hotel"
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "hotel"}
        )
        
        # Try to get creator profile
        response = await client.get(
            "/creators/me",
            headers={"Authorization": f"Bearer {token}"}
        )
        
        assert response.status_code == 403
        assert "only available for creators" in response.json()["detail"].lower()
    
    @pytest.mark.asyncio
    async def test_get_profile_nonexistent_creator(self, client: AsyncClient):
        """Test getting profile when creator record doesn't exist"""
        # Create a creator user but no creator profile
        email = "test_no_profile@example.com"
        password_hash = hash_password("password123")
        
        user = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'pending')
            RETURNING *
            """,
            email,
            password_hash,
            "Test Creator",
            "creator"
        )
        
        # Don't create creator profile
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "creator"}
        )
        
        # Get profile
        response = await client.get(
            "/creators/me",
            headers={"Authorization": f"Bearer {token}"}
        )
        
        assert response.status_code == 404
        assert "not found" in response.json()["detail"].lower()


class TestUpdateCreatorProfile:
    """Tests for PUT /creators/me endpoint"""
    
    @pytest.mark.asyncio
    async def test_update_profile_single_field(self, client: AsyncClient):
        """Test updating a single field (location)"""
        # Create a creator user
        email = "test_update_single@example.com"
        password_hash = hash_password("password123")
        
        user = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'pending')
            RETURNING *
            """,
            email,
            password_hash,
            "Test Creator",
            "creator"
        )
        
        creator = await Database.fetchrow(
            """
            INSERT INTO creators (user_id, location, short_description)
            VALUES ($1, $2, $3)
            RETURNING *
            """,
            user["id"],
            "Old Location",
            "Old description"
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "creator"}
        )
        
        # Update location
        response = await client.put(
            "/creators/me",
            headers={"Authorization": f"Bearer {token}"},
            json={"location": "New York, USA"}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["location"] == "New York, USA"
        assert data["short_description"] == "Old description"  # Unchanged
        assert data["name"] == "Test Creator"  # Unchanged
    
    @pytest.mark.asyncio
    async def test_update_profile_multiple_fields(self, client: AsyncClient):
        """Test updating multiple fields at once"""
        # Create a creator user
        email = "test_update_multi@example.com"
        password_hash = hash_password("password123")
        
        user = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'pending')
            RETURNING *
            """,
            email,
            password_hash,
            "Old Name",
            "creator"
        )
        
        creator = await Database.fetchrow(
            """
            INSERT INTO creators (user_id, location, short_description, phone)
            VALUES ($1, $2, $3, $4)
            RETURNING *
            """,
            user["id"],
            "Old Location",
            "Old description",
            "+1111111111"
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "creator"}
        )
        
        # Update multiple fields
        response = await client.put(
            "/creators/me",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "name": "New Name",
                "location": "Los Angeles, USA",
                "shortDescription": "New description about the creator",
                "phone": "+2222222222",
                "portfolioLink": "https://portfolio.example.com"
            }
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["name"] == "New Name"
        assert data["location"] == "Los Angeles, USA"
        assert data["short_description"] == "New description about the creator"
        assert data["phone"] == "+2222222222"
        # Pydantic HttpUrl normalizes URLs (may add trailing slash)
        assert data["portfolio_link"].startswith("https://portfolio.example.com")
    
    @pytest.mark.asyncio
    async def test_update_profile_add_platforms(self, client: AsyncClient):
        """Test adding platforms to profile"""
        # Create a creator user
        email = "test_update_platforms@example.com"
        password_hash = hash_password("password123")
        
        user = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'pending')
            RETURNING *
            """,
            email,
            password_hash,
            "Test Creator",
            "creator"
        )
        
        creator = await Database.fetchrow(
            """
            INSERT INTO creators (user_id, location, short_description)
            VALUES ($1, $2, $3)
            RETURNING *
            """,
            user["id"],
            "New York, USA",
            "A creator"
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "creator"}
        )
        
        # Add platforms
        response = await client.put(
            "/creators/me",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "platforms": [
                    {
                        "name": "Instagram",
                        "handle": "@testcreator",
                        "followers": 10000,
                        "engagement_rate": 3.5
                    },
                    {
                        "name": "TikTok",
                        "handle": "@testcreator",
                        "followers": 5000,
                        "engagement_rate": 4.0
                    }
                ]
            }
        )
        
        assert response.status_code == 200
        data = response.json()
        assert len(data["platforms"]) == 2
        assert data["audience_size"] == 15000  # Sum of followers
        platform_names = [p["name"] for p in data["platforms"]]
        assert "Instagram" in platform_names
        assert "TikTok" in platform_names
    
    @pytest.mark.asyncio
    async def test_update_profile_replace_platforms(self, client: AsyncClient):
        """Test that updating platforms replaces existing ones"""
        # Create a creator user with existing platforms
        email = "test_replace_platforms@example.com"
        password_hash = hash_password("password123")
        
        user = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'pending')
            RETURNING *
            """,
            email,
            password_hash,
            "Test Creator",
            "creator"
        )
        
        creator = await Database.fetchrow(
            """
            INSERT INTO creators (user_id, location, short_description)
            VALUES ($1, $2, $3)
            RETURNING *
            """,
            user["id"],
            "New York, USA",
            "A creator"
        )
        
        # Add initial platform
        await Database.execute(
            """
            INSERT INTO creator_platforms (creator_id, name, handle, followers, engagement_rate)
            VALUES ($1, $2, $3, $4, $5)
            """,
            creator["id"],
            "Facebook",
            "@oldhandle",
            2000,
            2.0
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "creator"}
        )
        
        # Replace with new platforms
        response = await client.put(
            "/creators/me",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "platforms": [
                    {
                        "name": "Instagram",
                        "handle": "@newhandle",
                        "followers": 10000,
                        "engagement_rate": 3.5
                    }
                ]
            }
        )
        
        assert response.status_code == 200
        data = response.json()
        assert len(data["platforms"]) == 1  # Old platform replaced
        assert data["platforms"][0]["name"] == "Instagram"
        assert data["platforms"][0]["handle"] == "@newhandle"
        assert data["audience_size"] == 10000
    
    @pytest.mark.asyncio
    async def test_update_profile_keep_existing_platforms(self, client: AsyncClient):
        """Test that not providing platforms keeps existing ones"""
        # Create a creator user with existing platforms
        email = "test_keep_platforms@example.com"
        password_hash = hash_password("password123")
        
        user = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'pending')
            RETURNING *
            """,
            email,
            password_hash,
            "Test Creator",
            "creator"
        )
        
        creator = await Database.fetchrow(
            """
            INSERT INTO creators (user_id, location, short_description)
            VALUES ($1, $2, $3)
            RETURNING *
            """,
            user["id"],
            "New York, USA",
            "A creator"
        )
        
        # Add initial platform
        await Database.execute(
            """
            INSERT INTO creator_platforms (creator_id, name, handle, followers, engagement_rate)
            VALUES ($1, $2, $3, $4, $5)
            """,
            creator["id"],
            "Instagram",
            "@testcreator",
            10000,
            3.5
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "creator"}
        )
        
        # Update only location, don't provide platforms
        response = await client.put(
            "/creators/me",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "location": "Los Angeles, USA"
            }
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["location"] == "Los Angeles, USA"
        assert len(data["platforms"]) == 1  # Platform still exists
        assert data["platforms"][0]["name"] == "Instagram"
    
    @pytest.mark.asyncio
    async def test_update_profile_with_analytics(self, client: AsyncClient):
        """Test updating profile with platform analytics data"""
        # Create a creator user
        email = "test_update_analytics@example.com"
        password_hash = hash_password("password123")
        
        user = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'pending')
            RETURNING *
            """,
            email,
            password_hash,
            "Test Creator",
            "creator"
        )
        
        creator = await Database.fetchrow(
            """
            INSERT INTO creators (user_id, location, short_description)
            VALUES ($1, $2, $3)
            RETURNING *
            """,
            user["id"],
            "New York, USA",
            "A creator"
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "creator"}
        )
        
        # Add platform with analytics
        response = await client.put(
            "/creators/me",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "platforms": [
                    {
                        "name": "Instagram",
                        "handle": "@testcreator",
                        "followers": 10000,
                        "engagement_rate": 3.5,
                        "top_countries": [
                            {"country": "US"},
                            {"country": "UK"}
                        ],
                        "top_age_groups": [
                            {"ageRange": "18-24"},
                            {"ageRange": "25-34"}
                        ],
                        "gender_split": {
                            "male": 30,
                            "female": 70
                        }
                    }
                ]
            }
        )
        
        assert response.status_code == 200
        data = response.json()
        assert len(data["platforms"]) == 1
        platform = data["platforms"][0]
        assert platform["top_countries"] is not None
        assert len(platform["top_countries"]) == 2
        assert platform["top_age_groups"] is not None
        assert platform["gender_split"] is not None
        assert platform["gender_split"]["male"] == 30
        assert platform["gender_split"]["female"] == 70
    
    @pytest.mark.asyncio
    async def test_update_profile_audience_size_calculation(self, client: AsyncClient):
        """Test that audience_size is calculated from platform followers"""
        # Create a creator user
        email = "test_audience_size@example.com"
        password_hash = hash_password("password123")
        
        user = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'pending')
            RETURNING *
            """,
            email,
            password_hash,
            "Test Creator",
            "creator"
        )
        
        creator = await Database.fetchrow(
            """
            INSERT INTO creators (user_id, location, short_description)
            VALUES ($1, $2, $3)
            RETURNING *
            """,
            user["id"],
            "New York, USA",
            "A creator"
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "creator"}
        )
        
        # Add multiple platforms
        response = await client.put(
            "/creators/me",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "platforms": [
                    {
                        "name": "Instagram",
                        "handle": "@testcreator",
                        "followers": 10000,
                        "engagement_rate": 3.5
                    },
                    {
                        "name": "TikTok",
                        "handle": "@testcreator",
                        "followers": 5000,
                        "engagement_rate": 4.0
                    },
                    {
                        "name": "YouTube",
                        "handle": "@testcreator",
                        "followers": 2500,
                        "engagement_rate": 2.5
                    }
                ]
            }
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["audience_size"] == 17500  # 10000 + 5000 + 2500
    
    @pytest.mark.asyncio
    async def test_update_profile_short_description_too_short(self, client: AsyncClient):
        """Test validation error for short description that's too short"""
        # Create a creator user
        email = "test_short_desc@example.com"
        password_hash = hash_password("password123")
        
        user = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'pending')
            RETURNING *
            """,
            email,
            password_hash,
            "Test Creator",
            "creator"
        )
        
        creator = await Database.fetchrow(
            """
            INSERT INTO creators (user_id, location, short_description)
            VALUES ($1, $2, $3)
            RETURNING *
            """,
            user["id"],
            "New York, USA",
            "A creator"
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "creator"}
        )
        
        # Try to update with too short description
        response = await client.put(
            "/creators/me",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "shortDescription": "Short"  # Less than 10 characters
            }
        )
        
        assert response.status_code == 422  # Validation error
    
    @pytest.mark.asyncio
    async def test_update_profile_invalid_portfolio_link(self, client: AsyncClient):
        """Test validation error for invalid portfolio link"""
        # Create a creator user
        email = "test_invalid_link@example.com"
        password_hash = hash_password("password123")
        
        user = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'pending')
            RETURNING *
            """,
            email,
            password_hash,
            "Test Creator",
            "creator"
        )
        
        creator = await Database.fetchrow(
            """
            INSERT INTO creators (user_id, location, short_description)
            VALUES ($1, $2, $3)
            RETURNING *
            """,
            user["id"],
            "New York, USA",
            "A creator"
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "creator"}
        )
        
        # Try to update with invalid URL
        response = await client.put(
            "/creators/me",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "portfolioLink": "not-a-valid-url"
            }
        )
        
        assert response.status_code == 422  # Validation error
    
    @pytest.mark.asyncio
    async def test_update_profile_invalid_platform_data(self, client: AsyncClient):
        """Test validation error for invalid platform data"""
        # Create a creator user
        email = "test_invalid_platform@example.com"
        password_hash = hash_password("password123")
        
        user = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'pending')
            RETURNING *
            """,
            email,
            password_hash,
            "Test Creator",
            "creator"
        )
        
        creator = await Database.fetchrow(
            """
            INSERT INTO creators (user_id, location, short_description)
            VALUES ($1, $2, $3)
            RETURNING *
            """,
            user["id"],
            "New York, USA",
            "A creator"
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "creator"}
        )
        
        # Try to update with invalid platform (zero followers)
        response = await client.put(
            "/creators/me",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "platforms": [
                    {
                        "name": "Instagram",
                        "handle": "@testcreator",
                        "followers": 0,  # Invalid - must be > 0
                        "engagement_rate": 3.5
                    }
                ]
            }
        )
        
        assert response.status_code == 422  # Validation error
    
    @pytest.mark.asyncio
    async def test_update_profile_invalid_platform_name(self, client: AsyncClient):
        """Test validation error for invalid platform name"""
        # Create a creator user
        email = "test_invalid_platform_name@example.com"
        password_hash = hash_password("password123")
        
        user = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'pending')
            RETURNING *
            """,
            email,
            password_hash,
            "Test Creator",
            "creator"
        )
        
        creator = await Database.fetchrow(
            """
            INSERT INTO creators (user_id, location, short_description)
            VALUES ($1, $2, $3)
            RETURNING *
            """,
            user["id"],
            "New York, USA",
            "A creator"
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "creator"}
        )
        
        # Try to update with invalid platform name
        response = await client.put(
            "/creators/me",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "platforms": [
                    {
                        "name": "InvalidPlatform",  # Not in allowed list
                        "handle": "@testcreator",
                        "followers": 10000,
                        "engagement_rate": 3.5
                    }
                ]
            }
        )
        
        assert response.status_code == 422  # Validation error
    
    @pytest.mark.asyncio
    async def test_update_profile_no_auth(self, client: AsyncClient):
        """Test updating profile without authentication"""
        response = await client.put(
            "/creators/me",
            json={"location": "New York, USA"}
        )
        
        assert response.status_code == 403  # Forbidden
    
    @pytest.mark.asyncio
    async def test_update_profile_hotel_user(self, client: AsyncClient):
        """Test that hotel users cannot update creator profiles"""
        # Create a hotel user
        email = "test_hotel_update@example.com"
        password_hash = hash_password("password123")
        
        user = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'pending')
            RETURNING *
            """,
            email,
            password_hash,
            "Test Hotel",
            "hotel"
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "hotel"}
        )
        
        # Try to update creator profile
        response = await client.put(
            "/creators/me",
            headers={"Authorization": f"Bearer {token}"},
            json={"location": "New York, USA"}
        )
        
        assert response.status_code == 403
        assert "only available for creators" in response.json()["detail"].lower()
    
    @pytest.mark.asyncio
    async def test_update_profile_nonexistent_creator(self, client: AsyncClient):
        """Test updating profile when creator record doesn't exist"""
        # Create a creator user but no creator profile
        email = "test_no_creator_profile@example.com"
        password_hash = hash_password("password123")
        
        user = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'pending')
            RETURNING *
            """,
            email,
            password_hash,
            "Test Creator",
            "creator"
        )
        
        # Don't create creator profile
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "creator"}
        )
        
        # Try to update profile
        response = await client.put(
            "/creators/me",
            headers={"Authorization": f"Bearer {token}"},
            json={"location": "New York, USA"}
        )
        
        assert response.status_code == 404
        assert "not found" in response.json()["detail"].lower()
    
    @pytest.mark.asyncio
    async def test_update_profile_empty_request(self, client: AsyncClient):
        """Test updating profile with empty request (should succeed, no changes)"""
        # Create a creator user
        email = "test_empty_update@example.com"
        password_hash = hash_password("password123")
        
        user = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'pending')
            RETURNING *
            """,
            email,
            password_hash,
            "Test Creator",
            "creator"
        )
        
        creator = await Database.fetchrow(
            """
            INSERT INTO creators (user_id, location, short_description)
            VALUES ($1, $2, $3)
            RETURNING *
            """,
            user["id"],
            "New York, USA",
            "A creator"
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "creator"}
        )
        
        # Update with empty request
        response = await client.put(
            "/creators/me",
            headers={"Authorization": f"Bearer {token}"},
            json={}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["location"] == "New York, USA"  # Unchanged
        assert data["name"] == "Test Creator"  # Unchanged

