"""
Tests for hotel profile endpoints
"""
import pytest
from fastapi import status
from app.database import Database


class TestHotelProfileStatus:
    """Test hotel profile status endpoint"""
    
    def test_get_profile_status_unauthenticated(self, client):
        """Test that unauthenticated requests return 401"""
        response = client.get("/hotels/me/profile-status")
        assert response.status_code == status.HTTP_401_UNAUTHORIZED
    
    def test_get_profile_status_wrong_user_type(self, client, test_creator_user):
        """Test that creator users cannot access hotel endpoint"""
        from conftest import get_auth_headers_for_user
        headers = get_auth_headers_for_user(test_creator_user)
        response = client.get("/hotels/me/profile-status", headers=headers)
        assert response.status_code == status.HTTP_403_FORBIDDEN
        assert "hotels" in response.json()["detail"].lower()
    
    def test_get_profile_status_incomplete_profile_with_defaults(self, client, test_hotel_user):
        """Test profile status for hotel profile with default values"""
        from conftest import get_auth_headers_for_user
        headers = get_auth_headers_for_user(test_hotel_user)
        response = client.get("/hotels/me/profile-status", headers=headers)
        
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        
        assert data["profile_complete"] is False
        assert data["has_defaults"]["location"] is True
        assert data["missing_listings"] is True  # No listings created yet
        assert "location" in data["missing_fields"] or len(data["missing_fields"]) > 0
        assert len(data["completion_steps"]) > 0
        assert isinstance(data["missing_fields"], list)
        assert isinstance(data["completion_steps"], list)
        assert "Set a custom location" in data["completion_steps"]
        assert "Add at least one property listing" in data["completion_steps"]
    
    
    @pytest.mark.asyncio
    async def test_get_profile_status_complete_profile(self, client, db_setup):
        """Test profile status for complete hotel profile"""
        import bcrypt
        import uuid
        
        # Create complete hotel profile
        test_email = f"complete_hotel_{uuid.uuid4().hex[:8]}@test.com"
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
            "Complete Hotel",
            "hotel"
        )
        
        # Create complete hotel profile
        hotel = await Database.fetchrow(
            """
            INSERT INTO hotel_profiles (user_id, name, location, email, website, about)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id
            """,
            user['id'],
            "Grand Hotel",
            "Paris, France",  # Not default
            test_email,
            "https://grandhotel.com",
            "A luxurious hotel in the heart of Paris"
        )
        
        # Add a listing to make profile complete
        await Database.execute(
            """
            INSERT INTO hotel_listings (hotel_profile_id, name, location, description)
            VALUES ($1, $2, $3, $4)
            """,
            hotel['id'],
            "Grand Hotel Main Building",
            "Paris, France",
            "Luxurious hotel in the heart of Paris"
        )
        
        try:
            from conftest import get_auth_headers_for_user
            headers = get_auth_headers_for_user(str(user['id']))
            response = client.get("/hotels/me/profile-status", headers=headers)
            
            assert response.status_code == status.HTTP_200_OK
            data = response.json()
            
            assert data["profile_complete"] is True  # Complete with listing
            assert len(data["missing_fields"]) == 0
            assert data["has_defaults"]["location"] is False
            assert data["missing_listings"] is False
            assert len(data["completion_steps"]) == 0
        finally:
            # Cleanup
            await Database.execute("DELETE FROM users WHERE id = $1", user['id'])
    
    @pytest.mark.asyncio
    async def test_get_profile_status_default_location(self, client, db_setup):
        """Test profile status when location has default value"""
        import bcrypt
        import uuid
        
        test_email = f"defaultloc_hotel_{uuid.uuid4().hex[:8]}@test.com"
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
            "Test Hotel",
            "hotel"
        )
        
        # Create hotel profile with default location
        await Database.execute(
            """
            INSERT INTO hotel_profiles (user_id, name, location, email, about)
            VALUES ($1, $2, $3, $4, $5)
            """,
            user['id'],
            "Test Hotel",
            "Not specified",  # Default
            test_email,
            "A nice hotel"
        )
        
        try:
            from conftest import get_auth_headers_for_user
            headers = get_auth_headers_for_user(str(user['id']))
            response = client.get("/hotels/me/profile-status", headers=headers)
            
            assert response.status_code == status.HTTP_200_OK
            data = response.json()
            
            assert data["profile_complete"] is False
            assert data["has_defaults"]["location"] is True
            assert "Set a custom location" in data["completion_steps"]
        finally:
            # Cleanup
            await Database.execute("DELETE FROM users WHERE id = $1", user['id'])
    
    @pytest.mark.asyncio
    async def test_get_profile_status_missing_fields(self, client, db_setup):
        """Test profile status when required fields are missing"""
        import bcrypt
        import uuid
        
        test_email = f"missing_hotel_{uuid.uuid4().hex[:8]}@test.com"
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
            "Test Hotel",
            "hotel"
        )
        
        # Create hotel profile with missing about and website
        await Database.execute(
            """
            INSERT INTO hotel_profiles (user_id, name, location, email, about, website)
            VALUES ($1, $2, $3, $4, NULL, NULL)
            """,
            user['id'],
            "Test Hotel",
            "Paris, France",
            test_email
        )
        
        try:
            from conftest import get_auth_headers_for_user
            headers = get_auth_headers_for_user(str(user['id']))
            response = client.get("/hotels/me/profile-status", headers=headers)
            
            assert response.status_code == status.HTTP_200_OK
            data = response.json()
            
            assert data["profile_complete"] is False
            assert "about" in data["missing_fields"]
            assert "website" in data["missing_fields"]
            assert "Add a description about your hotel" in data["completion_steps"]
            assert "Add your website URL" in data["completion_steps"]
        finally:
            # Cleanup
            await Database.execute("DELETE FROM users WHERE id = $1", user['id'])
    
    @pytest.mark.asyncio
    async def test_get_profile_status_empty_strings(self, client, db_setup):
        """Test profile status when fields contain only whitespace"""
        import bcrypt
        import uuid
        
        test_email = f"empty_hotel_{uuid.uuid4().hex[:8]}@test.com"
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
            "Test Hotel",
            "hotel"
        )
        
        # Create hotel profile with empty strings
        await Database.execute(
            """
            INSERT INTO hotel_profiles (user_id, name, location, email, about, website)
            VALUES ($1, $2, $3, $4, $5, $6)
            """,
            user['id'],
            "Test Hotel",
            "Paris, France",
            test_email,
            "   ",  # Only whitespace
            ""  # Empty string
        )
        
        try:
            from conftest import get_auth_headers_for_user
            headers = get_auth_headers_for_user(str(user['id']))
            response = client.get("/hotels/me/profile-status", headers=headers)
            
            assert response.status_code == status.HTTP_200_OK
            data = response.json()
            
            assert data["profile_complete"] is False
            assert "about" in data["missing_fields"]
            assert "website" in data["missing_fields"]
        finally:
            # Cleanup
            await Database.execute("DELETE FROM users WHERE id = $1", user['id'])

