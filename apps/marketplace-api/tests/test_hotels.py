"""
Tests for hotels endpoints
"""
import pytest
from httpx import AsyncClient
from app.database import Database
from app.auth import hash_password
from app.jwt_utils import create_access_token


class TestGetHotelProfileStatus:
    """Tests for GET /hotels/me/profile-status endpoint"""
    
    @pytest.mark.asyncio
    async def test_get_profile_status_success_complete(self, client: AsyncClient):
        """Test getting profile status for a complete profile"""
        # Create a hotel user with complete profile
        email = "test_hotel_complete@example.com"
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
        
        hotel = await Database.fetchrow(
            """
            INSERT INTO hotel_profiles (user_id, name, location, about, website)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *
            """,
            user["id"],
            "Test Hotel",
            "New York, USA",
            "A beautiful hotel in the heart of the city",
            "https://hotel.example.com"
        )
        
        # Add a listing
        await Database.execute(
            """
            INSERT INTO hotel_listings (hotel_profile_id, name, location, description)
            VALUES ($1, $2, $3, $4)
            """,
            hotel["id"],
            "Deluxe Suite",
            "New York, USA",
            "A beautiful suite with amazing views"
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "hotel"}
        )
        
        # Get profile status
        response = await client.get(
            "/hotels/me/profile-status",
            headers={"Authorization": f"Bearer {token}"}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["profile_complete"] is True
        assert len(data["missing_fields"]) == 0
        assert data["missing_listings"] is False
        assert data["has_defaults"]["location"] is False
        assert len(data["completion_steps"]) == 0
    
    @pytest.mark.asyncio
    async def test_get_profile_status_incomplete_missing_fields(self, client: AsyncClient):
        """Test getting profile status for incomplete profile with missing fields"""
        # Create a hotel user with incomplete profile
        email = "test_hotel_incomplete@example.com"
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
        
        hotel = await Database.fetchrow(
            """
            INSERT INTO hotel_profiles (user_id, name, location, about, website)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *
            """,
            user["id"],
            "",  # Missing name
            "Not specified",  # Default location (can't be NULL)
            None,  # Missing about
            None   # Missing website
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "hotel"}
        )
        
        # Get profile status
        response = await client.get(
            "/hotels/me/profile-status",
            headers={"Authorization": f"Bearer {token}"}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["profile_complete"] is False
        assert "name" in data["missing_fields"]
        # Location is "Not specified" (default), so it's not in missing_fields but has_defaults is True
        assert "about" in data["missing_fields"]
        assert "website" in data["missing_fields"]
        assert data["missing_listings"] is True
        assert len(data["completion_steps"]) > 0
    
    @pytest.mark.asyncio
    async def test_get_profile_status_default_location(self, client: AsyncClient):
        """Test getting profile status when location is using default value"""
        # Create a hotel user with default location
        email = "test_hotel_default_location@example.com"
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
        
        hotel = await Database.fetchrow(
            """
            INSERT INTO hotel_profiles (user_id, name, location, about, website)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *
            """,
            user["id"],
            "Test Hotel",
            "Not specified",  # Default location
            "A beautiful hotel",
            "https://hotel.example.com"
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "hotel"}
        )
        
        # Get profile status
        response = await client.get(
            "/hotels/me/profile-status",
            headers={"Authorization": f"Bearer {token}"}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["profile_complete"] is False  # Not complete due to default location
        assert data["has_defaults"]["location"] is True
        assert "Set a custom location" in " ".join(data["completion_steps"])
    
    @pytest.mark.asyncio
    async def test_get_profile_status_missing_listings(self, client: AsyncClient):
        """Test getting profile status when listings are missing"""
        # Create a hotel user with all fields but no listings
        email = "test_hotel_no_listings@example.com"
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
        
        hotel = await Database.fetchrow(
            """
            INSERT INTO hotel_profiles (user_id, name, location, about, website)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *
            """,
            user["id"],
            "Test Hotel",
            "New York, USA",
            "A beautiful hotel",
            "https://hotel.example.com"
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "hotel"}
        )
        
        # Get profile status
        response = await client.get(
            "/hotels/me/profile-status",
            headers={"Authorization": f"Bearer {token}"}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["profile_complete"] is False
        assert data["missing_listings"] is True
        assert "Add at least one property listing" in data["completion_steps"]
    
    @pytest.mark.asyncio
    async def test_get_profile_status_no_auth(self, client: AsyncClient):
        """Test getting profile status without authentication"""
        response = await client.get("/hotels/me/profile-status")
        
        assert response.status_code == 403  # Forbidden
    
    @pytest.mark.asyncio
    async def test_get_profile_status_invalid_token(self, client: AsyncClient):
        """Test getting profile status with invalid token"""
        response = await client.get(
            "/hotels/me/profile-status",
            headers={"Authorization": "Bearer invalid_token"}
        )
        
        assert response.status_code == 401  # Unauthorized (invalid token)
    
    @pytest.mark.asyncio
    async def test_get_profile_status_creator_user(self, client: AsyncClient):
        """Test that creator users cannot access hotel endpoints"""
        # Create a creator user
        email = "test_creator_hotel@example.com"
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
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "creator"}
        )
        
        # Try to get hotel profile status
        response = await client.get(
            "/hotels/me/profile-status",
            headers={"Authorization": f"Bearer {token}"}
        )
        
        assert response.status_code == 403
        assert "only available for hotels" in response.json()["detail"].lower()
    
    @pytest.mark.asyncio
    async def test_get_profile_status_nonexistent_user(self, client: AsyncClient):
        """Test getting profile status for non-existent user"""
        # Create token for non-existent user
        fake_user_id = "00000000-0000-0000-0000-000000000000"
        token = create_access_token(
            data={"sub": fake_user_id, "email": "fake@example.com", "type": "hotel"}
        )
        
        response = await client.get(
            "/hotels/me/profile-status",
            headers={"Authorization": f"Bearer {token}"}
        )
        
        # The dependency checks user existence first and returns 401 if not found
        assert response.status_code == 401
        assert "not found" in response.json()["detail"].lower() or "invalid" in response.json()["detail"].lower()


class TestGetHotelProfile:
    """Tests for GET /hotels/me endpoint"""
    
    @pytest.mark.asyncio
    async def test_get_profile_success(self, client: AsyncClient):
        """Test getting complete hotel profile"""
        # Create a hotel user with complete profile
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
        
        hotel = await Database.fetchrow(
            """
            INSERT INTO hotel_profiles (user_id, name, location, about, website, phone, picture)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *
            """,
            user["id"],
            "Test Hotel",
            "New York, USA",
            "A beautiful hotel in the heart of the city",
            "https://hotel.example.com",
            "+1234567890",
            "https://hotel.example.com/picture.jpg"
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "hotel"}
        )
        
        # Get profile
        response = await client.get(
            "/hotels/me",
            headers={"Authorization": f"Bearer {token}"}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["id"] == str(hotel["id"])
        assert data["user_id"] == str(user["id"])
        assert data["name"] == "Test Hotel"
        assert data["email"] == email
        assert data["location"] == "New York, USA"
        assert data["about"] == "A beautiful hotel in the heart of the city"
        assert data["website"] == "https://hotel.example.com"
        assert data["phone"] == "+1234567890"
        assert data["picture"] == "https://hotel.example.com/picture.jpg"
        assert len(data["listings"]) == 0  # No listings yet
    
    @pytest.mark.asyncio
    async def test_get_profile_with_listings(self, client: AsyncClient):
        """Test getting profile with listings"""
        # Create a hotel user
        email = "test_hotel_listings@example.com"
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
        
        hotel = await Database.fetchrow(
            """
            INSERT INTO hotel_profiles (user_id, name, location, about, website)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *
            """,
            user["id"],
            "Test Hotel",
            "New York, USA",
            "A beautiful hotel",
            "https://hotel.example.com"
        )
        
        # Add listings
        listing1 = await Database.fetchrow(
            """
            INSERT INTO hotel_listings (hotel_profile_id, name, location, description, accommodation_type, images)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
            """,
            hotel["id"],
            "Deluxe Suite",
            "New York, USA",
            "A beautiful suite with amazing views",
            "Hotel",
            ["https://example.com/image1.jpg", "https://example.com/image2.jpg"]
        )
        
        listing2 = await Database.fetchrow(
            """
            INSERT INTO hotel_listings (hotel_profile_id, name, location, description, accommodation_type)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *
            """,
            hotel["id"],
            "Standard Room",
            "New York, USA",
            "A comfortable standard room",
            "City Hotel"
        )
        
        # Add collaboration offering for listing1
        await Database.execute(
            """
            INSERT INTO listing_collaboration_offerings 
            (listing_id, collaboration_type, availability_months, platforms, free_stay_min_nights, free_stay_max_nights)
            VALUES ($1, $2, $3, $4, $5, $6)
            """,
            listing1["id"],
            "Free Stay",
            ["January", "February", "March"],
            ["Instagram", "TikTok"],
            2,
            5
        )
        
        # Add creator requirements for listing1
        await Database.execute(
            """
            INSERT INTO listing_creator_requirements 
            (listing_id, platforms, min_followers, target_countries, target_age_min, target_age_max)
            VALUES ($1, $2, $3, $4, $5, $6)
            """,
            listing1["id"],
            ["Instagram", "TikTok"],
            10000,
            ["US", "UK"],
            18,
            35
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "hotel"}
        )
        
        # Get profile
        response = await client.get(
            "/hotels/me",
            headers={"Authorization": f"Bearer {token}"}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert len(data["listings"]) == 2
        
        # Check first listing (should have offerings and requirements)
        listing1_data = next(l for l in data["listings"] if l["id"] == str(listing1["id"]))
        assert listing1_data["name"] == "Deluxe Suite"
        assert len(listing1_data["images"]) == 2
        assert len(listing1_data["collaboration_offerings"]) == 1
        assert listing1_data["collaboration_offerings"][0]["collaboration_type"] == "Free Stay"
        assert listing1_data["creator_requirements"] is not None
        assert listing1_data["creator_requirements"]["min_followers"] == 10000
        
        # Check second listing (no offerings/requirements)
        listing2_data = next(l for l in data["listings"] if l["id"] == str(listing2["id"]))
        assert listing2_data["name"] == "Standard Room"
        assert len(listing2_data["collaboration_offerings"]) == 0
        assert listing2_data["creator_requirements"] is None
    
    @pytest.mark.asyncio
    async def test_get_profile_empty_profile(self, client: AsyncClient):
        """Test getting profile with minimal data"""
        # Create a hotel user with minimal profile
        email = "test_hotel_minimal@example.com"
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
        
        hotel = await Database.fetchrow(
            """
            INSERT INTO hotel_profiles (user_id, name, location)
            VALUES ($1, $2, $3)
            RETURNING *
            """,
            user["id"],
            "Test Hotel",
            "Not specified"
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "hotel"}
        )
        
        # Get profile
        response = await client.get(
            "/hotels/me",
            headers={"Authorization": f"Bearer {token}"}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["id"] == str(hotel["id"])
        assert data["name"] == "Test Hotel"
        assert data["email"] == email
        assert data["location"] == "Not specified"
        assert data["about"] is None
        assert data["website"] is None
        assert data["phone"] is None
        assert data["picture"] is None
        assert len(data["listings"]) == 0
    
    @pytest.mark.asyncio
    async def test_get_profile_multiple_listings(self, client: AsyncClient):
        """Test getting profile with multiple listings"""
        # Create a hotel user
        email = "test_hotel_multi_listings@example.com"
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
        
        hotel = await Database.fetchrow(
            """
            INSERT INTO hotel_profiles (user_id, name, location, about, website)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *
            """,
            user["id"],
            "Test Hotel",
            "New York, USA",
            "A beautiful hotel",
            "https://hotel.example.com"
        )
        
        # Add multiple listings
        await Database.execute(
            """
            INSERT INTO hotel_listings (hotel_profile_id, name, location, description)
            VALUES ($1, $2, $3, $4)
            """,
            hotel["id"],
            "Suite 1",
            "New York, USA",
            "First suite"
        )
        
        await Database.execute(
            """
            INSERT INTO hotel_listings (hotel_profile_id, name, location, description)
            VALUES ($1, $2, $3, $4)
            """,
            hotel["id"],
            "Suite 2",
            "New York, USA",
            "Second suite"
        )
        
        await Database.execute(
            """
            INSERT INTO hotel_listings (hotel_profile_id, name, location, description)
            VALUES ($1, $2, $3, $4)
            """,
            hotel["id"],
            "Suite 3",
            "New York, USA",
            "Third suite"
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "hotel"}
        )
        
        # Get profile
        response = await client.get(
            "/hotels/me",
            headers={"Authorization": f"Bearer {token}"}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert len(data["listings"]) == 3
        # Listings should be ordered by created_at DESC (newest first)
        listing_names = [l["name"] for l in data["listings"]]
        assert "Suite 1" in listing_names
        assert "Suite 2" in listing_names
        assert "Suite 3" in listing_names
    
    @pytest.mark.asyncio
    async def test_get_profile_listing_with_all_offering_types(self, client: AsyncClient):
        """Test getting profile with listing that has all collaboration offering types"""
        # Create a hotel user
        email = "test_hotel_offerings@example.com"
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
        
        hotel = await Database.fetchrow(
            """
            INSERT INTO hotel_profiles (user_id, name, location, about, website)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *
            """,
            user["id"],
            "Test Hotel",
            "New York, USA",
            "A beautiful hotel",
            "https://hotel.example.com"
        )
        
        # Add listing
        listing = await Database.fetchrow(
            """
            INSERT INTO hotel_listings (hotel_profile_id, name, location, description)
            VALUES ($1, $2, $3, $4)
            RETURNING *
            """,
            hotel["id"],
            "Deluxe Suite",
            "New York, USA",
            "A beautiful suite"
        )
        
        # Add multiple collaboration offerings
        await Database.execute(
            """
            INSERT INTO listing_collaboration_offerings 
            (listing_id, collaboration_type, availability_months, platforms, free_stay_min_nights, free_stay_max_nights)
            VALUES ($1, $2, $3, $4, $5, $6)
            """,
            listing["id"],
            "Free Stay",
            ["January", "February"],
            ["Instagram"],
            2,
            5
        )
        
        await Database.execute(
            """
            INSERT INTO listing_collaboration_offerings 
            (listing_id, collaboration_type, availability_months, platforms, paid_max_amount)
            VALUES ($1, $2, $3, $4, $5)
            """,
            listing["id"],
            "Paid",
            ["March", "April"],
            ["TikTok"],
            1000
        )
        
        await Database.execute(
            """
            INSERT INTO listing_collaboration_offerings 
            (listing_id, collaboration_type, availability_months, platforms, discount_percentage)
            VALUES ($1, $2, $3, $4, $5)
            """,
            listing["id"],
            "Discount",
            ["May", "June"],
            ["YouTube"],
            20
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "hotel"}
        )
        
        # Get profile
        response = await client.get(
            "/hotels/me",
            headers={"Authorization": f"Bearer {token}"}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert len(data["listings"]) == 1
        listing_data = data["listings"][0]
        assert len(listing_data["collaboration_offerings"]) == 3
        
        # Check offering types
        offering_types = [o["collaboration_type"] for o in listing_data["collaboration_offerings"]]
        assert "Free Stay" in offering_types
        assert "Paid" in offering_types
        assert "Discount" in offering_types
        
        # Verify specific fields for each type
        free_stay = next(o for o in listing_data["collaboration_offerings"] if o["collaboration_type"] == "Free Stay")
        assert free_stay["free_stay_min_nights"] == 2
        assert free_stay["free_stay_max_nights"] == 5
        
        paid = next(o for o in listing_data["collaboration_offerings"] if o["collaboration_type"] == "Paid")
        assert float(paid["paid_max_amount"]) == 1000.0
        
        discount = next(o for o in listing_data["collaboration_offerings"] if o["collaboration_type"] == "Discount")
        assert discount["discount_percentage"] == 20
    
    @pytest.mark.asyncio
    async def test_get_profile_no_auth(self, client: AsyncClient):
        """Test getting profile without authentication"""
        response = await client.get("/hotels/me")
        
        assert response.status_code == 403  # Forbidden
    
    @pytest.mark.asyncio
    async def test_get_profile_creator_user(self, client: AsyncClient):
        """Test that creator users cannot access hotel endpoints"""
        # Create a creator user
        email = "test_creator_hotel_profile@example.com"
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
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "creator"}
        )
        
        # Try to get hotel profile
        response = await client.get(
            "/hotels/me",
            headers={"Authorization": f"Bearer {token}"}
        )
        
        assert response.status_code == 403
        assert "only available for hotels" in response.json()["detail"].lower()
    
    @pytest.mark.asyncio
    async def test_get_profile_nonexistent_hotel(self, client: AsyncClient):
        """Test getting profile when hotel record doesn't exist"""
        # Create a hotel user but no hotel profile
        email = "test_no_hotel_profile@example.com"
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
        
        # Don't create hotel profile
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "hotel"}
        )
        
        # Get profile
        response = await client.get(
            "/hotels/me",
            headers={"Authorization": f"Bearer {token}"}
        )
        
        assert response.status_code == 404
        assert "not found" in response.json()["detail"].lower()

