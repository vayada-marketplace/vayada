"""
Tests for creator profile endpoints
"""
import pytest
from fastapi import status
from app.database import Database


class TestCreatorProfileStatus:
    """Test creator profile status endpoint"""
    
    def test_get_profile_status_unauthenticated(self, client):
        """Test that unauthenticated requests return 401"""
        response = client.get("/creators/me/profile-status")
        assert response.status_code == status.HTTP_401_UNAUTHORIZED
    
    def test_get_profile_status_wrong_user_type(self, client, test_hotel_user):
        """Test that hotel users cannot access creator endpoint"""
        from conftest import get_auth_headers_for_user
        headers = get_auth_headers_for_user(test_hotel_user)
        response = client.get("/creators/me/profile-status", headers=headers)
        assert response.status_code == status.HTTP_403_FORBIDDEN
        assert "creators" in response.json()["detail"].lower()
    
    def test_get_profile_status_incomplete_profile(self, client, test_creator_user):
        """Test profile status for incomplete creator profile"""
        from conftest import get_auth_headers_for_user
        headers = get_auth_headers_for_user(test_creator_user)
        response = client.get("/creators/me/profile-status", headers=headers)
        
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        
        assert data["profile_complete"] is False
        assert "name" in data["missing_fields"] or "location" in data["missing_fields"] or "short_description" in data["missing_fields"]
        assert data["missing_platforms"] is True
        assert len(data["completion_steps"]) > 0
        assert isinstance(data["missing_fields"], list)
        assert isinstance(data["completion_steps"], list)
    
    @pytest.mark.asyncio
    async def test_get_profile_status_complete_profile(self, client, db_setup):
        """Test profile status for complete creator profile"""
        import bcrypt
        import uuid
        
        # Create complete creator profile
        test_email = f"complete_creator_{uuid.uuid4().hex[:8]}@test.com"
        password_hash = bcrypt.hashpw("testpassword123".encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
        
        # Create user
        user = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'verified')
            RETURNING id
            """,
            test_email,
            password_hash,
            "Complete Creator",
            "creator"
        )
        
        # Create complete creator profile
        creator = await Database.fetchrow(
            """
            INSERT INTO creators (user_id, location, short_description, portfolio_link)
            VALUES ($1, $2, $3, $4)
            RETURNING id
            """,
            user['id'],
            "New York, USA",
            "I'm a travel content creator",
            "https://portfolio.example.com"
        )
        
        # Add a platform
        await Database.execute(
            """
            INSERT INTO creator_platforms (creator_id, name, handle, followers, engagement_rate)
            VALUES ($1, $2, $3, $4, $5)
            """,
            creator['id'],
            "Instagram",
            "@testcreator",
            10000,
            3.5
        )
        
        try:
            from conftest import get_auth_headers_for_user
            headers = get_auth_headers_for_user(str(user['id']))
            response = client.get("/creators/me/profile-status", headers=headers)
            
            assert response.status_code == status.HTTP_200_OK
            data = response.json()
            
            assert data["profile_complete"] is True
            assert len(data["missing_fields"]) == 0
            assert data["missing_platforms"] is False
            assert len(data["completion_steps"]) == 0
        finally:
            # Cleanup
            await Database.execute("DELETE FROM users WHERE id = $1", user['id'])
    
    @pytest.mark.asyncio
    async def test_get_profile_status_missing_name(self, client, db_setup):
        """Test profile status when name is missing"""
        import bcrypt
        import uuid
        
        test_email = f"noname_creator_{uuid.uuid4().hex[:8]}@test.com"
        password_hash = bcrypt.hashpw("testpassword123".encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
        
        # Create user with empty name
        user = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'verified')
            RETURNING id
            """,
            test_email,
            password_hash,
            "",  # Empty name
            "creator"
        )
        
        # Create creator profile with location and description
        creator = await Database.fetchrow(
            """
            INSERT INTO creators (user_id, location, short_description)
            VALUES ($1, $2, $3)
            RETURNING id
            """,
            user['id'],
            "Los Angeles, USA",
            "Travel creator"
        )
        
        try:
            from conftest import get_auth_headers_for_user
            headers = get_auth_headers_for_user(str(user['id']))
            response = client.get("/creators/me/profile-status", headers=headers)
            
            assert response.status_code == status.HTTP_200_OK
            data = response.json()
            
            assert data["profile_complete"] is False
            assert "name" in data["missing_fields"]
            assert "Add your name" in data["completion_steps"]
        finally:
            # Cleanup
            await Database.execute("DELETE FROM users WHERE id = $1", user['id'])
    
    @pytest.mark.asyncio
    async def test_get_profile_status_missing_location(self, client, db_setup):
        """Test profile status when location is missing"""
        import bcrypt
        import uuid
        
        test_email = f"noloc_creator_{uuid.uuid4().hex[:8]}@test.com"
        password_hash = bcrypt.hashpw("testpassword123".encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
        
        # Create user
        user = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'verified')
            RETURNING id
            """,
            test_email,
            password_hash,
            "Test Creator",
            "creator"
        )
        
        # Create creator profile without location
        await Database.execute(
            """
            INSERT INTO creators (user_id, location, short_description)
            VALUES ($1, NULL, $2)
            """,
            user['id'],
            "Travel creator"
        )
        
        try:
            from conftest import get_auth_headers_for_user
            headers = get_auth_headers_for_user(str(user['id']))
            response = client.get("/creators/me/profile-status", headers=headers)
            
            assert response.status_code == status.HTTP_200_OK
            data = response.json()
            
            assert data["profile_complete"] is False
            assert "location" in data["missing_fields"]
            assert "Set your location" in data["completion_steps"]
        finally:
            # Cleanup
            await Database.execute("DELETE FROM users WHERE id = $1", user['id'])
    
    @pytest.mark.asyncio
    async def test_get_profile_status_missing_platforms(self, client, db_setup):
        """Test profile status when platforms are missing"""
        import bcrypt
        import uuid
        
        test_email = f"noplat_creator_{uuid.uuid4().hex[:8]}@test.com"
        password_hash = bcrypt.hashpw("testpassword123".encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
        
        # Create user
        user = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'verified')
            RETURNING id
            """,
            test_email,
            password_hash,
            "Test Creator",
            "creator"
        )
        
        # Create complete creator profile but no platforms
        await Database.execute(
            """
            INSERT INTO creators (user_id, location, short_description)
            VALUES ($1, $2, $3)
            """,
            user['id'],
            "New York, USA",
            "Travel creator"
        )
        
        try:
            from conftest import get_auth_headers_for_user
            headers = get_auth_headers_for_user(str(user['id']))
            response = client.get("/creators/me/profile-status", headers=headers)
            
            assert response.status_code == status.HTTP_200_OK
            data = response.json()
            
            assert data["profile_complete"] is False
            assert data["missing_platforms"] is True
            assert "Add at least one social media platform" in data["completion_steps"]
        finally:
            # Cleanup
            await Database.execute("DELETE FROM users WHERE id = $1", user['id'])
    
    @pytest.mark.asyncio
    async def test_get_profile_status_invalid_platform(self, client, db_setup):
        """Test profile status with invalid platform (no followers)"""
        import bcrypt
        import uuid
        
        test_email = f"invalidplat_creator_{uuid.uuid4().hex[:8]}@test.com"
        password_hash = bcrypt.hashpw("testpassword123".encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
        
        # Create user
        user = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'verified')
            RETURNING id
            """,
            test_email,
            password_hash,
            "Test Creator",
            "creator"
        )
        
        # Create creator profile
        creator = await Database.fetchrow(
            """
            INSERT INTO creators (user_id, location, short_description)
            VALUES ($1, $2, $3)
            RETURNING id
            """,
            user['id'],
            "New York, USA",
            "Travel creator"
        )
        
        # Add platform with 0 followers (invalid)
        await Database.execute(
            """
            INSERT INTO creator_platforms (creator_id, name, handle, followers, engagement_rate)
            VALUES ($1, $2, $3, $4, $5)
            """,
            creator['id'],
            "Instagram",
            "@testcreator",
            0,  # Invalid - no followers
            0.0
        )
        
        try:
            from conftest import get_auth_headers_for_user
            headers = get_auth_headers_for_user(str(user['id']))
            response = client.get("/creators/me/profile-status", headers=headers)
            
            assert response.status_code == status.HTTP_200_OK
            data = response.json()
            
            # Should still be missing platforms because the platform is invalid
            assert data["missing_platforms"] is True
            assert data["profile_complete"] is False
        finally:
            # Cleanup
            await Database.execute("DELETE FROM users WHERE id = $1", user['id'])


class TestUpdateCreatorProfile:
    """Test creator profile update endpoint"""
    
    def test_update_profile_unauthenticated(self, client):
        """Test that unauthenticated requests return 401"""
        response = client.put("/creators/me", json={})
        assert response.status_code == status.HTTP_401_UNAUTHORIZED
    
    def test_update_profile_wrong_user_type(self, client, test_hotel_user):
        """Test that hotel users cannot update creator profile"""
        from conftest import get_auth_headers_for_user
        headers = get_auth_headers_for_user(test_hotel_user)
        response = client.put(
            "/creators/me",
            json={
                "name": "Test",
                "location": "Test",
                "shortDescription": "Test description",
                "platforms": []
            },
            headers=headers
        )
        assert response.status_code == status.HTTP_403_FORBIDDEN
    
    @pytest.mark.asyncio
    async def test_update_profile_success(self, client, test_creator_user):
        """Test successful profile update"""
        from conftest import get_auth_headers_for_user
        headers = get_auth_headers_for_user(test_creator_user)
        
        request_data = {
            "name": "Updated Creator Name",
            "location": "New York, USA",
            "shortDescription": "I'm a travel content creator with 10+ years of experience",
            "portfolioLink": "https://portfolio.example.com",
            "phone": "+1-555-123-4567",
            "platforms": [
                {
                    "name": "Instagram",
                    "handle": "@testcreator",
                    "followers": 50000,
                    "engagementRate": 3.5
                },
                {
                    "name": "TikTok",
                    "handle": "@testcreator",
                    "followers": 75000,
                    "engagementRate": 5.2
                }
            ]
        }
        
        response = client.put("/creators/me", json=request_data, headers=headers)
        
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        
        assert data["name"] == "Updated Creator Name"
        assert data["location"] == "New York, USA"
        assert data["shortDescription"] == "I'm a travel content creator with 10+ years of experience"
        assert data["portfolioLink"] == "https://portfolio.example.com"
        assert data["phone"] == "+1-555-123-4567"
        assert len(data["platforms"]) == 2
        assert data["audienceSize"] == 125000  # 50000 + 75000
        assert "id" in data
        assert "status" in data
        assert "createdAt" in data
        assert "updatedAt" in data
    
    @pytest.mark.asyncio
    async def test_update_profile_with_analytics(self, client, test_creator_user):
        """Test profile update with analytics data"""
        from conftest import get_auth_headers_for_user
        headers = get_auth_headers_for_user(test_creator_user)
        
        request_data = {
            "name": "Creator With Analytics",
            "location": "Los Angeles, USA",
            "shortDescription": "Travel creator with detailed analytics data",
            "platforms": [
                {
                    "name": "Instagram",
                    "handle": "@analyticscreator",
                    "followers": 100000,
                    "engagementRate": 4.5,
                    "topCountries": [
                        {"country": "United States", "percentage": 45.5},
                        {"country": "Germany", "percentage": 12.3}
                    ],
                    "topAgeGroups": [
                        {"ageRange": "25-34", "percentage": 42.1},
                        {"ageRange": "35-44", "percentage": 28.5}
                    ],
                    "genderSplit": {
                        "male": 35,
                        "female": 65
                    }
                }
            ]
        }
        
        response = client.put("/creators/me", json=request_data, headers=headers)
        
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        
        assert len(data["platforms"]) == 1
        platform = data["platforms"][0]
        assert platform["name"] == "Instagram"
        assert platform["topCountries"] is not None
        assert len(platform["topCountries"]) == 2
        assert platform["topAgeGroups"] is not None
        assert platform["genderSplit"] is not None
        assert platform["genderSplit"]["male"] == 35
        assert platform["genderSplit"]["female"] == 65
    
    def test_update_profile_missing_required_fields(self, client, test_creator_user):
        """Test update with missing required fields"""
        from conftest import get_auth_headers_for_user
        headers = get_auth_headers_for_user(test_creator_user)
        
        # Missing name
        response = client.put(
            "/creators/me",
            json={
                "location": "Test",
                "shortDescription": "Test description",
                "platforms": [{"name": "Instagram", "handle": "@test", "followers": 1000, "engagementRate": 2.0}]
            },
            headers=headers
        )
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY
    
    def test_update_profile_short_description_too_short(self, client, test_creator_user):
        """Test update with short_description less than 10 characters"""
        from conftest import get_auth_headers_for_user
        headers = get_auth_headers_for_user(test_creator_user)
        
        response = client.put(
            "/creators/me",
            json={
                "name": "Test",
                "location": "Test",
                "shortDescription": "Short",  # Less than 10 chars
                "platforms": [{"name": "Instagram", "handle": "@test", "followers": 1000, "engagementRate": 2.0}]
            },
            headers=headers
        )
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY
    
    def test_update_profile_no_platforms(self, client, test_creator_user):
        """Test update with no platforms"""
        from conftest import get_auth_headers_for_user
        headers = get_auth_headers_for_user(test_creator_user)
        
        response = client.put(
            "/creators/me",
            json={
                "name": "Test",
                "location": "Test",
                "shortDescription": "This is a valid description",
                "platforms": []  # Empty platforms
            },
            headers=headers
        )
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY
    
    def test_update_profile_invalid_platform_data(self, client, test_creator_user):
        """Test update with invalid platform data"""
        from conftest import get_auth_headers_for_user
        headers = get_auth_headers_for_user(test_creator_user)
        
        # Platform with 0 followers
        response = client.put(
            "/creators/me",
            json={
                "name": "Test",
                "location": "Test",
                "shortDescription": "This is a valid description",
                "platforms": [
                    {
                        "name": "Instagram",
                        "handle": "@test",
                        "followers": 0,  # Invalid - must be > 0
                        "engagementRate": 2.0
                    }
                ]
            },
            headers=headers
        )
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY
    
    @pytest.mark.asyncio
    async def test_update_profile_replaces_existing_platforms(self, client, test_creator_user):
        """Test that updating profile replaces existing platforms"""
        from conftest import get_auth_headers_for_user
        
        headers = get_auth_headers_for_user(test_creator_user)
        
        # Get creator ID
        creator = await Database.fetchrow(
            "SELECT id FROM creators WHERE user_id = $1",
            test_creator_user
        )
        
        # Add an existing platform
        await Database.execute(
            """
            INSERT INTO creator_platforms (creator_id, name, handle, followers, engagement_rate)
            VALUES ($1, 'YouTube', '@oldhandle', 10000, 2.0)
            """,
            creator['id']
        )
        
        # Update with new platforms
        request_data = {
            "name": "Updated Creator",
            "location": "Test Location",
            "shortDescription": "This is a valid description",
            "platforms": [
                {
                    "name": "Instagram",
                    "handle": "@newhandle",
                    "followers": 20000,
                    "engagementRate": 3.0
                }
            ]
        }
        
        response = client.put("/creators/me", json=request_data, headers=headers)
        
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        
        # Should only have the new platform, old one should be gone
        assert len(data["platforms"]) == 1
        assert data["platforms"][0]["name"] == "Instagram"
        assert data["platforms"][0]["handle"] == "@newhandle"
        
        # Verify old platform is deleted
        old_platforms = await Database.fetch(
            "SELECT * FROM creator_platforms WHERE creator_id = $1 AND name = 'YouTube'",
            creator['id']
        )
        assert len(old_platforms) == 0

