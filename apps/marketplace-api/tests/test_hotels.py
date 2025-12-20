"""
Tests for hotels endpoints
"""
import uuid
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


class TestUpdateHotelProfile:
    """Tests for PUT /hotels/me endpoint"""
    
    @pytest.mark.asyncio
    async def test_update_profile_single_field(self, client: AsyncClient):
        """Test updating a single field (location)"""
        # Create a hotel user
        email = "test_update_single_hotel@example.com"
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
            INSERT INTO hotel_profiles (user_id, name, location, about)
            VALUES ($1, $2, $3, $4)
            RETURNING *
            """,
            user["id"],
            "Test Hotel",
            "Old Location",
            "Old description"
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "hotel"}
        )
        
        # Update location
        response = await client.put(
            "/hotels/me",
            headers={"Authorization": f"Bearer {token}"},
            json={"location": "New York, USA"}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["location"] == "New York, USA"
        assert data["about"] == "Old description"  # Unchanged
        assert data["name"] == "Test Hotel"  # Unchanged
    
    @pytest.mark.asyncio
    async def test_update_profile_multiple_fields(self, client: AsyncClient):
        """Test updating multiple fields at once"""
        # Create a hotel user
        email = "test_update_multi_hotel@example.com"
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
            "hotel"
        )
        
        hotel = await Database.fetchrow(
            """
            INSERT INTO hotel_profiles (user_id, name, location, about, phone)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *
            """,
            user["id"],
            "Old Name",
            "Old Location",
            "Old description",
            "+1111111111"
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "hotel"}
        )
        
        # Update multiple fields
        response = await client.put(
            "/hotels/me",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "name": "New Name",
                "location": "Los Angeles, USA",
                "about": "New description about the hotel",
                "phone": "+2222222222",
                "website": "https://newhotel.example.com",
                "picture": "https://newhotel.example.com/picture.jpg"
            }
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["name"] == "New Name"
        assert data["location"] == "Los Angeles, USA"
        assert data["about"] == "New description about the hotel"
        assert data["phone"] == "+2222222222"
        assert data["website"].startswith("https://newhotel.example.com")
        assert data["picture"].startswith("https://newhotel.example.com/picture.jpg")
    
    @pytest.mark.asyncio
    async def test_update_profile_email(self, client: AsyncClient):
        """Test updating email address"""
        # Create a hotel user
        email = "test_update_email_old@example.com"
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
            "New York, USA"
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "hotel"}
        )
        
        # Update email
        response = await client.put(
            "/hotels/me",
            headers={"Authorization": f"Bearer {token}"},
            json={"email": "test_update_email_new@example.com"}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["email"] == "test_update_email_new@example.com"
    
    @pytest.mark.asyncio
    async def test_update_profile_with_listings(self, client: AsyncClient):
        """Test updating profile when hotel has listings"""
        # Create a hotel user
        email = "test_update_with_listings@example.com"
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
        
        # Add a listing
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
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "hotel"}
        )
        
        # Update profile
        response = await client.put(
            "/hotels/me",
            headers={"Authorization": f"Bearer {token}"},
            json={"about": "Updated description"}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["about"] == "Updated description"
        assert len(data["listings"]) == 1
        assert data["listings"][0]["id"] == str(listing["id"])
    
    @pytest.mark.asyncio
    async def test_update_profile_location_validation(self, client: AsyncClient):
        """Test that location cannot be set to default value"""
        # Create a hotel user
        email = "test_location_validation@example.com"
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
            "New York, USA"
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "hotel"}
        )
        
        # Try to update with default location
        response = await client.put(
            "/hotels/me",
            headers={"Authorization": f"Bearer {token}"},
            json={"location": "Not specified"}
        )
        
        assert response.status_code == 422  # Validation error
        detail = response.json()["detail"]
        # Pydantic validation errors can be a list or string
        if isinstance(detail, list):
            detail_str = " ".join(str(d) for d in detail)
        else:
            detail_str = str(detail)
        assert "default value" in detail_str.lower() or "must be updated" in detail_str.lower()
    
    @pytest.mark.asyncio
    async def test_update_profile_about_too_short(self, client: AsyncClient):
        """Test validation error for about field that's too short"""
        # Create a hotel user
        email = "test_about_short@example.com"
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
            "New York, USA"
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "hotel"}
        )
        
        # Try to update with too short about
        response = await client.put(
            "/hotels/me",
            headers={"Authorization": f"Bearer {token}"},
            json={"about": "Short"}  # Less than 10 characters
        )
        
        assert response.status_code == 422  # Validation error
    
    @pytest.mark.asyncio
    async def test_update_profile_invalid_email(self, client: AsyncClient):
        """Test validation error for invalid email format"""
        # Create a hotel user
        email = "test_invalid_email@example.com"
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
            "New York, USA"
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "hotel"}
        )
        
        # Try to update with invalid email
        response = await client.put(
            "/hotels/me",
            headers={"Authorization": f"Bearer {token}"},
            json={"email": "not-a-valid-email"}
        )
        
        assert response.status_code == 422  # Validation error
    
    @pytest.mark.asyncio
    async def test_update_profile_invalid_website(self, client: AsyncClient):
        """Test validation error for invalid website URL"""
        # Create a hotel user
        email = "test_invalid_website@example.com"
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
            "New York, USA"
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "hotel"}
        )
        
        # Try to update with invalid URL
        response = await client.put(
            "/hotels/me",
            headers={"Authorization": f"Bearer {token}"},
            json={"website": "not-a-valid-url"}
        )
        
        assert response.status_code == 422  # Validation error
    
    @pytest.mark.asyncio
    async def test_update_profile_name_too_short(self, client: AsyncClient):
        """Test validation error for name that's too short"""
        # Create a hotel user
        email = "test_name_short@example.com"
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
            "New York, USA"
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "hotel"}
        )
        
        # Try to update with too short name
        response = await client.put(
            "/hotels/me",
            headers={"Authorization": f"Bearer {token}"},
            json={"name": "A"}  # Less than 2 characters
        )
        
        assert response.status_code == 422  # Validation error
    
    @pytest.mark.asyncio
    async def test_update_profile_no_auth(self, client: AsyncClient):
        """Test updating profile without authentication"""
        response = await client.put(
            "/hotels/me",
            json={"location": "New York, USA"}
        )
        
        assert response.status_code == 403  # Forbidden
    
    @pytest.mark.asyncio
    async def test_update_profile_creator_user(self, client: AsyncClient):
        """Test that creator users cannot update hotel profiles"""
        # Create a creator user
        email = "test_creator_update_hotel@example.com"
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
        
        # Try to update hotel profile
        response = await client.put(
            "/hotels/me",
            headers={"Authorization": f"Bearer {token}"},
            json={"location": "New York, USA"}
        )
        
        assert response.status_code == 403
        assert "only available for hotels" in response.json()["detail"].lower()
    
    @pytest.mark.asyncio
    async def test_update_profile_nonexistent_hotel(self, client: AsyncClient):
        """Test updating profile when hotel record doesn't exist"""
        # Create a hotel user but no hotel profile
        email = "test_no_hotel_profile_update@example.com"
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
        
        # Try to update profile
        response = await client.put(
            "/hotels/me",
            headers={"Authorization": f"Bearer {token}"},
            json={"location": "New York, USA"}
        )
        
        assert response.status_code == 404
        assert "not found" in response.json()["detail"].lower()
    
    @pytest.mark.asyncio
    async def test_update_profile_empty_request(self, client: AsyncClient):
        """Test updating profile with empty request (should succeed, no changes)"""
        # Create a hotel user
        email = "test_empty_update_hotel@example.com"
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
            INSERT INTO hotel_profiles (user_id, name, location, about)
            VALUES ($1, $2, $3, $4)
            RETURNING *
            """,
            user["id"],
            "Test Hotel",
            "New York, USA",
            "A beautiful hotel"
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "hotel"}
        )
        
        # Update with empty request
        response = await client.put(
            "/hotels/me",
            headers={"Authorization": f"Bearer {token}"},
            json={}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["location"] == "New York, USA"  # Unchanged
        assert data["name"] == "Test Hotel"  # Unchanged
        assert data["about"] == "A beautiful hotel"  # Unchanged
    
    @pytest.mark.asyncio
    async def test_update_profile_all_fields(self, client: AsyncClient):
        """Test updating all fields at once"""
        # Create a hotel user
        email = "test_update_all_fields@example.com"
        password_hash = hash_password("password123")
        
        user = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'pending')
            RETURNING *
            """,
            email,
            password_hash,
            "Old Hotel",
            "hotel"
        )
        
        hotel = await Database.fetchrow(
            """
            INSERT INTO hotel_profiles (user_id, name, location, about, website, phone, picture)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *
            """,
            user["id"],
            "Old Hotel",
            "Old Location",
            "Old about",
            "https://old.example.com",
            "+1111111111",
            "https://old.example.com/pic.jpg"
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "hotel"}
        )
        
        # Use a unique email that won't conflict
        new_email = f"test_update_all_fields_{uuid.uuid4().hex[:8]}@example.com"
        
        # Update all fields
        response = await client.put(
            "/hotels/me",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "name": "New Hotel",
                "location": "New Location",
                "about": "New about description with more than 10 characters",
                "website": "https://new.example.com",
                "phone": "+9999999999",
                "picture": "https://new.example.com/pic.jpg",
                "email": new_email
            }
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["name"] == "New Hotel"
        assert data["location"] == "New Location"
        assert data["about"] == "New about description with more than 10 characters"
        assert data["website"].startswith("https://new.example.com")
        assert data["phone"] == "+9999999999"
        assert data["picture"].startswith("https://new.example.com/pic.jpg")
        assert data["email"] == new_email


class TestCreateHotelListing:
    """Tests for POST /hotels/me/listings endpoint"""
    
    @pytest.mark.asyncio
    async def test_create_listing_success(self, client: AsyncClient):
        """Test creating a listing with all fields"""
        # Create a hotel user
        email = "test_create_listing@example.com"
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
            "New York, USA"
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "hotel"}
        )
        
        # Create listing
        response = await client.post(
            "/hotels/me/listings",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "name": "Deluxe Suite",
                "location": "New York, USA",
                "description": "A beautiful suite with amazing views",
                "accommodation_type": "Hotel",
                "images": ["https://example.com/image1.jpg", "https://example.com/image2.jpg"],
                "collaboration_offerings": [
                    {
                        "collaboration_type": "Free Stay",
                        "availability_months": ["January", "February", "March"],
                        "platforms": ["Instagram", "TikTok"],
                        "free_stay_min_nights": 2,
                        "free_stay_max_nights": 5
                    }
                ],
                "creator_requirements": {
                    "platforms": ["Instagram", "TikTok"],
                    "min_followers": 10000,
                    "target_countries": ["US", "UK"],
                    "target_age_min": 18,
                    "target_age_max": 35
                }
            }
        )
        
        assert response.status_code == 201
        data = response.json()
        assert data["name"] == "Deluxe Suite"
        assert data["location"] == "New York, USA"
        assert data["description"] == "A beautiful suite with amazing views"
        assert data["accommodation_type"] == "Hotel"
        assert len(data["images"]) == 2
        assert len(data["collaboration_offerings"]) == 1
        assert data["collaboration_offerings"][0]["collaboration_type"] == "Free Stay"
        assert data["creator_requirements"] is not None
        assert data["creator_requirements"]["min_followers"] == 10000
    
    @pytest.mark.asyncio
    async def test_create_listing_all_collaboration_types(self, client: AsyncClient):
        """Test creating listing with all collaboration types"""
        # Create a hotel user
        email = "test_all_collab_types@example.com"
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
            "New York, USA"
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "hotel"}
        )
        
        # Create listing with all collaboration types
        response = await client.post(
            "/hotels/me/listings",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "name": "Premium Suite",
                "location": "New York, USA",
                "description": "A premium suite with all amenities",
                "collaboration_offerings": [
                    {
                        "collaboration_type": "Free Stay",
                        "availability_months": ["January", "February"],
                        "platforms": ["Instagram"],
                        "free_stay_min_nights": 2,
                        "free_stay_max_nights": 5
                    },
                    {
                        "collaboration_type": "Paid",
                        "availability_months": ["March", "April"],
                        "platforms": ["TikTok"],
                        "paid_max_amount": 1000
                    },
                    {
                        "collaboration_type": "Discount",
                        "availability_months": ["May", "June"],
                        "platforms": ["YouTube"],
                        "discount_percentage": 20
                    }
                ],
                "creator_requirements": {
                    "platforms": ["Instagram", "TikTok", "YouTube"],
                    "min_followers": 5000,
                    "target_countries": ["US"],
                    "target_age_min": 25,
                    "target_age_max": 45
                }
            }
        )
        
        assert response.status_code == 201
        data = response.json()
        assert len(data["collaboration_offerings"]) == 3
        offering_types = [o["collaboration_type"] for o in data["collaboration_offerings"]]
        assert "Free Stay" in offering_types
        assert "Paid" in offering_types
        assert "Discount" in offering_types
    
    @pytest.mark.asyncio
    async def test_create_listing_minimal_data(self, client: AsyncClient):
        """Test creating listing with minimal required fields"""
        # Create a hotel user
        email = "test_minimal_listing@example.com"
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
            "New York, USA"
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "hotel"}
        )
        
        # Create listing with minimal data
        response = await client.post(
            "/hotels/me/listings",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "name": "Basic Room",
                "location": "New York, USA",
                "description": "A basic room with essential amenities",
                "collaboration_offerings": [
                    {
                        "collaboration_type": "Free Stay",
                        "availability_months": ["January"],
                        "platforms": ["Instagram"],
                        "free_stay_min_nights": 1,
                        "free_stay_max_nights": 3
                    }
                ],
                "creator_requirements": {
                    "platforms": ["Instagram"],
                    "target_countries": ["US"]
                }
            }
        )
        
        assert response.status_code == 201
        data = response.json()
        assert data["name"] == "Basic Room"
        assert data["accommodation_type"] is None
        assert len(data["images"]) == 0
    
    @pytest.mark.asyncio
    async def test_create_listing_validation_errors(self, client: AsyncClient):
        """Test validation errors for listing creation"""
        # Create a hotel user
        email = "test_listing_validation@example.com"
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
            "New York, USA"
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "hotel"}
        )
        
        # Test: description too short
        response = await client.post(
            "/hotels/me/listings",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "name": "Test Room",
                "location": "New York, USA",
                "description": "Short",  # Less than 10 characters
                "collaboration_offerings": [
                    {
                        "collaboration_type": "Free Stay",
                        "availability_months": ["January"],
                        "platforms": ["Instagram"],
                        "free_stay_min_nights": 1,
                        "free_stay_max_nights": 3
                    }
                ],
                "creator_requirements": {
                    "platforms": ["Instagram"],
                    "target_countries": ["US"]
                }
            }
        )
        
        assert response.status_code == 422  # Validation error
    
    @pytest.mark.asyncio
    async def test_create_listing_free_stay_validation(self, client: AsyncClient):
        """Test validation for Free Stay collaboration type"""
        # Create a hotel user
        email = "test_free_stay_validation@example.com"
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
            "New York, USA"
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "hotel"}
        )
        
        # Test: Free Stay without required fields
        response = await client.post(
            "/hotels/me/listings",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "name": "Test Room",
                "location": "New York, USA",
                "description": "A beautiful room",
                "collaboration_offerings": [
                    {
                        "collaboration_type": "Free Stay",
                        "availability_months": ["January"],
                        "platforms": ["Instagram"]
                        # Missing free_stay_min_nights and free_stay_max_nights
                    }
                ],
                "creator_requirements": {
                    "platforms": ["Instagram"],
                    "target_countries": ["US"]
                }
            }
        )
        
        assert response.status_code in [400, 422]  # Bad request or validation error
    
    @pytest.mark.asyncio
    async def test_create_listing_no_auth(self, client: AsyncClient):
        """Test creating listing without authentication"""
        response = await client.post(
            "/hotels/me/listings",
            json={
                "name": "Test Room",
                "location": "New York, USA",
                "description": "A beautiful room",
                "collaboration_offerings": [],
                "creator_requirements": {
                    "platforms": ["Instagram"],
                    "target_countries": ["US"]
                }
            }
        )
        
        assert response.status_code == 403  # Forbidden
    
    @pytest.mark.asyncio
    async def test_create_listing_creator_user(self, client: AsyncClient):
        """Test that creator users cannot create hotel listings"""
        # Create a creator user
        email = "test_creator_listing@example.com"
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
        
        # Try to create listing
        response = await client.post(
            "/hotels/me/listings",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "name": "Test Room",
                "location": "New York, USA",
                "description": "A beautiful room",
                "collaboration_offerings": [
                    {
                        "collaboration_type": "Free Stay",
                        "availability_months": ["January"],
                        "platforms": ["Instagram"],
                        "free_stay_min_nights": 1,
                        "free_stay_max_nights": 3
                    }
                ],
                "creator_requirements": {
                    "platforms": ["Instagram"],
                    "target_countries": ["US"]
                }
            }
        )
        
        assert response.status_code == 403
        assert "only available for hotels" in response.json()["detail"].lower() or "not found" in response.json()["detail"].lower()


class TestUpdateHotelListing:
    """Tests for PUT /hotels/me/listings/{listing_id} endpoint"""
    
    @pytest.mark.asyncio
    async def test_update_listing_single_field(self, client: AsyncClient):
        """Test updating a single field"""
        # Create a hotel user with listing
        email = "test_update_listing@example.com"
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
            "New York, USA"
        )
        
        listing = await Database.fetchrow(
            """
            INSERT INTO hotel_listings (hotel_profile_id, name, location, description)
            VALUES ($1, $2, $3, $4)
            RETURNING *
            """,
            hotel["id"],
            "Old Name",
            "Old Location",
            "Old description"
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "hotel"}
        )
        
        # Update name
        response = await client.put(
            f"/hotels/me/listings/{listing['id']}",
            headers={"Authorization": f"Bearer {token}"},
            json={"name": "New Name"}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["name"] == "New Name"
        assert data["location"] == "Old Location"  # Unchanged
        assert data["description"] == "Old description"  # Unchanged
    
    @pytest.mark.asyncio
    async def test_update_listing_multiple_fields(self, client: AsyncClient):
        """Test updating multiple fields"""
        # Create a hotel user with listing
        email = "test_update_multi_listing@example.com"
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
            "New York, USA"
        )
        
        listing = await Database.fetchrow(
            """
            INSERT INTO hotel_listings (hotel_profile_id, name, location, description, accommodation_type, images)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
            """,
            hotel["id"],
            "Old Name",
            "Old Location",
            "Old description",
            "Hotel",
            ["https://old.com/image.jpg"]
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "hotel"}
        )
        
        # Update multiple fields
        response = await client.put(
            f"/hotels/me/listings/{listing['id']}",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "name": "New Name",
                "location": "New Location",
                "description": "New description with more than 10 characters",
                "accommodation_type": "Luxury Hotel",
                "images": ["https://new.com/image1.jpg", "https://new.com/image2.jpg"]
            }
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["name"] == "New Name"
        assert data["location"] == "New Location"
        assert data["description"] == "New description with more than 10 characters"
        assert data["accommodation_type"] == "Luxury Hotel"
        assert len(data["images"]) == 2
    
    @pytest.mark.asyncio
    async def test_update_listing_replace_offerings(self, client: AsyncClient):
        """Test that updating offerings replaces existing ones"""
        # Create a hotel user with listing
        email = "test_replace_offerings@example.com"
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
            "New York, USA"
        )
        
        listing = await Database.fetchrow(
            """
            INSERT INTO hotel_listings (hotel_profile_id, name, location, description)
            VALUES ($1, $2, $3, $4)
            RETURNING *
            """,
            hotel["id"],
            "Test Room",
            "New York, USA",
            "A beautiful room"
        )
        
        # Add existing offering
        await Database.execute(
            """
            INSERT INTO listing_collaboration_offerings
            (listing_id, collaboration_type, availability_months, platforms, free_stay_min_nights, free_stay_max_nights)
            VALUES ($1, $2, $3, $4, $5, $6)
            """,
            listing["id"],
            "Free Stay",
            ["January"],
            ["Instagram"],
            1,
            3
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "hotel"}
        )
        
        # Replace with new offerings
        response = await client.put(
            f"/hotels/me/listings/{listing['id']}",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "collaboration_offerings": [
                    {
                        "collaboration_type": "Paid",
                        "availability_months": ["March", "April"],
                        "platforms": ["TikTok"],
                        "paid_max_amount": 500
                    }
                ]
            }
        )
        
        assert response.status_code == 200
        data = response.json()
        assert len(data["collaboration_offerings"]) == 1
        assert data["collaboration_offerings"][0]["collaboration_type"] == "Paid"
    
    @pytest.mark.asyncio
    async def test_update_listing_keep_existing_offerings(self, client: AsyncClient):
        """Test that not providing offerings keeps existing ones"""
        # Create a hotel user with listing
        email = "test_keep_offerings@example.com"
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
            "New York, USA"
        )
        
        listing = await Database.fetchrow(
            """
            INSERT INTO hotel_listings (hotel_profile_id, name, location, description)
            VALUES ($1, $2, $3, $4)
            RETURNING *
            """,
            hotel["id"],
            "Test Room",
            "New York, USA",
            "A beautiful room"
        )
        
        # Add existing offering
        await Database.execute(
            """
            INSERT INTO listing_collaboration_offerings
            (listing_id, collaboration_type, availability_months, platforms, free_stay_min_nights, free_stay_max_nights)
            VALUES ($1, $2, $3, $4, $5, $6)
            """,
            listing["id"],
            "Free Stay",
            ["January"],
            ["Instagram"],
            1,
            3
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "hotel"}
        )
        
        # Update only name, don't provide offerings
        response = await client.put(
            f"/hotels/me/listings/{listing['id']}",
            headers={"Authorization": f"Bearer {token}"},
            json={"name": "Updated Name"}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["name"] == "Updated Name"
        assert len(data["collaboration_offerings"]) == 1  # Still exists
        assert data["collaboration_offerings"][0]["collaboration_type"] == "Free Stay"
    
    @pytest.mark.asyncio
    async def test_update_listing_replace_requirements(self, client: AsyncClient):
        """Test that updating requirements replaces existing ones"""
        # Create a hotel user with listing
        email = "test_replace_requirements@example.com"
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
            "New York, USA"
        )
        
        listing = await Database.fetchrow(
            """
            INSERT INTO hotel_listings (hotel_profile_id, name, location, description)
            VALUES ($1, $2, $3, $4)
            RETURNING *
            """,
            hotel["id"],
            "Test Room",
            "New York, USA",
            "A beautiful room"
        )
        
        # Add existing requirements
        await Database.execute(
            """
            INSERT INTO listing_creator_requirements
            (listing_id, platforms, min_followers, target_countries)
            VALUES ($1, $2, $3, $4)
            """,
            listing["id"],
            ["Instagram"],
            5000,
            ["US"]
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "hotel"}
        )
        
        # Replace with new requirements
        response = await client.put(
            f"/hotels/me/listings/{listing['id']}",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "creator_requirements": {
                    "platforms": ["TikTok", "YouTube"],
                    "min_followers": 20000,
                    "target_countries": ["UK", "CA"],
                    "target_age_min": 25,
                    "target_age_max": 40
                }
            }
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["creator_requirements"] is not None
        assert len(data["creator_requirements"]["platforms"]) == 2
        assert data["creator_requirements"]["min_followers"] == 20000
        assert "UK" in data["creator_requirements"]["target_countries"]
    
    @pytest.mark.asyncio
    async def test_update_listing_no_auth(self, client: AsyncClient):
        """Test updating listing without authentication"""
        response = await client.put(
            "/hotels/me/listings/00000000-0000-0000-0000-000000000000",
            json={"name": "New Name"}
        )
        
        assert response.status_code == 403  # Forbidden
    
    @pytest.mark.asyncio
    async def test_update_listing_nonexistent(self, client: AsyncClient):
        """Test updating non-existent listing"""
        # Create a hotel user
        email = "test_update_nonexistent@example.com"
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
            "New York, USA"
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "hotel"}
        )
        
        # Try to update non-existent listing
        fake_listing_id = "00000000-0000-0000-0000-000000000000"
        response = await client.put(
            f"/hotels/me/listings/{fake_listing_id}",
            headers={"Authorization": f"Bearer {token}"},
            json={"name": "New Name"}
        )
        
        assert response.status_code == 404
        assert "not found" in response.json()["detail"].lower()
    
    @pytest.mark.asyncio
    async def test_update_listing_wrong_hotel(self, client: AsyncClient):
        """Test updating listing that belongs to different hotel"""
        # Create two hotel users
        email1 = "test_hotel1_listing@example.com"
        email2 = "test_hotel2_listing@example.com"
        password_hash = hash_password("password123")
        
        user1 = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'pending')
            RETURNING *
            """,
            email1,
            password_hash,
            "Hotel 1",
            "hotel"
        )
        
        user2 = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'pending')
            RETURNING *
            """,
            email2,
            password_hash,
            "Hotel 2",
            "hotel"
        )
        
        hotel1 = await Database.fetchrow(
            """
            INSERT INTO hotel_profiles (user_id, name, location)
            VALUES ($1, $2, $3)
            RETURNING *
            """,
            user1["id"],
            "Hotel 1",
            "New York, USA"
        )
        
        hotel2 = await Database.fetchrow(
            """
            INSERT INTO hotel_profiles (user_id, name, location)
            VALUES ($1, $2, $3)
            RETURNING *
            """,
            user2["id"],
            "Hotel 2",
            "Los Angeles, USA"
        )
        
        # Create listing for hotel1
        listing = await Database.fetchrow(
            """
            INSERT INTO hotel_listings (hotel_profile_id, name, location, description)
            VALUES ($1, $2, $3, $4)
            RETURNING *
            """,
            hotel1["id"],
            "Hotel 1 Room",
            "New York, USA",
            "A room in hotel 1"
        )
        
        # Create token for hotel2
        token = create_access_token(
            data={"sub": str(user2["id"]), "email": email2, "type": "hotel"}
        )
        
        # Try to update hotel1's listing with hotel2's token
        response = await client.put(
            f"/hotels/me/listings/{listing['id']}",
            headers={"Authorization": f"Bearer {token}"},
            json={"name": "Hacked Name"}
        )
        
        assert response.status_code == 404  # Not found (doesn't belong to hotel2)


class TestDeleteHotelListing:
    """Tests for DELETE /hotels/me/listings/{listing_id} endpoint"""
    
    @pytest.mark.asyncio
    async def test_delete_listing_success(self, client: AsyncClient):
        """Test deleting a listing successfully"""
        # Create a hotel user with listing
        email = "test_delete_listing@example.com"
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
            "New York, USA"
        )
        
        listing = await Database.fetchrow(
            """
            INSERT INTO hotel_listings (hotel_profile_id, name, location, description)
            VALUES ($1, $2, $3, $4)
            RETURNING *
            """,
            hotel["id"],
            "Test Room",
            "New York, USA",
            "A beautiful room"
        )
        
        # Add offerings and requirements
        await Database.execute(
            """
            INSERT INTO listing_collaboration_offerings
            (listing_id, collaboration_type, availability_months, platforms, free_stay_min_nights, free_stay_max_nights)
            VALUES ($1, $2, $3, $4, $5, $6)
            """,
            listing["id"],
            "Free Stay",
            ["January"],
            ["Instagram"],
            1,
            3
        )
        
        await Database.execute(
            """
            INSERT INTO listing_creator_requirements
            (listing_id, platforms, target_countries)
            VALUES ($1, $2, $3)
            """,
            listing["id"],
            ["Instagram"],
            ["US"]
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "hotel"}
        )
        
        # Delete listing
        response = await client.delete(
            f"/hotels/me/listings/{listing['id']}",
            headers={"Authorization": f"Bearer {token}"}
        )
        
        assert response.status_code == 204
        
        # Verify listing is deleted
        deleted_listing = await Database.fetchrow(
            "SELECT id FROM hotel_listings WHERE id = $1",
            listing["id"]
        )
        assert deleted_listing is None
        
        # Verify offerings are deleted
        deleted_offerings = await Database.fetch(
            "SELECT id FROM listing_collaboration_offerings WHERE listing_id = $1",
            listing["id"]
        )
        assert len(deleted_offerings) == 0
        
        # Verify requirements are deleted
        deleted_requirements = await Database.fetchrow(
            "SELECT id FROM listing_creator_requirements WHERE listing_id = $1",
            listing["id"]
        )
        assert deleted_requirements is None
    
    @pytest.mark.asyncio
    async def test_delete_listing_no_auth(self, client: AsyncClient):
        """Test deleting listing without authentication"""
        response = await client.delete(
            "/hotels/me/listings/00000000-0000-0000-0000-000000000000"
        )
        
        assert response.status_code == 403  # Forbidden
    
    @pytest.mark.asyncio
    async def test_delete_listing_nonexistent(self, client: AsyncClient):
        """Test deleting non-existent listing"""
        # Create a hotel user
        email = "test_delete_nonexistent@example.com"
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
            "New York, USA"
        )
        
        # Create token
        token = create_access_token(
            data={"sub": str(user["id"]), "email": email, "type": "hotel"}
        )
        
        # Try to delete non-existent listing
        fake_listing_id = "00000000-0000-0000-0000-000000000000"
        response = await client.delete(
            f"/hotels/me/listings/{fake_listing_id}",
            headers={"Authorization": f"Bearer {token}"}
        )
        
        assert response.status_code == 404
        assert "not found" in response.json()["detail"].lower()
    
    @pytest.mark.asyncio
    async def test_delete_listing_wrong_hotel(self, client: AsyncClient):
        """Test deleting listing that belongs to different hotel"""
        # Create two hotel users
        email1 = "test_delete_hotel1@example.com"
        email2 = "test_delete_hotel2@example.com"
        password_hash = hash_password("password123")
        
        user1 = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'pending')
            RETURNING *
            """,
            email1,
            password_hash,
            "Hotel 1",
            "hotel"
        )
        
        user2 = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'pending')
            RETURNING *
            """,
            email2,
            password_hash,
            "Hotel 2",
            "hotel"
        )
        
        hotel1 = await Database.fetchrow(
            """
            INSERT INTO hotel_profiles (user_id, name, location)
            VALUES ($1, $2, $3)
            RETURNING *
            """,
            user1["id"],
            "Hotel 1",
            "New York, USA"
        )
        
        hotel2 = await Database.fetchrow(
            """
            INSERT INTO hotel_profiles (user_id, name, location)
            VALUES ($1, $2, $3)
            RETURNING *
            """,
            user2["id"],
            "Hotel 2",
            "Los Angeles, USA"
        )
        
        # Create listing for hotel1
        listing = await Database.fetchrow(
            """
            INSERT INTO hotel_listings (hotel_profile_id, name, location, description)
            VALUES ($1, $2, $3, $4)
            RETURNING *
            """,
            hotel1["id"],
            "Hotel 1 Room",
            "New York, USA",
            "A room in hotel 1"
        )
        
        # Create token for hotel2
        token = create_access_token(
            data={"sub": str(user2["id"]), "email": email2, "type": "hotel"}
        )
        
        # Try to delete hotel1's listing with hotel2's token
        response = await client.delete(
            f"/hotels/me/listings/{listing['id']}",
            headers={"Authorization": f"Bearer {token}"}
        )
        
        assert response.status_code == 404  # Not found (doesn't belong to hotel2)

