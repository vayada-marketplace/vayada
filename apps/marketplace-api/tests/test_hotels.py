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
            INSERT INTO hotel_profiles (user_id, name, location, website, about)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id
            """,
            user['id'],
            "Grand Hotel",
            "Paris, France",  # Not default
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
            INSERT INTO hotel_profiles (user_id, name, location, about)
            VALUES ($1, $2, $3, $4)
            """,
            user['id'],
            "Test Hotel",
            "Not specified",  # Default
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
            INSERT INTO hotel_profiles (user_id, name, location, about, website)
            VALUES ($1, $2, $3, NULL, NULL)
            """,
            user['id'],
            "Test Hotel",
            "Paris, France"
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
            INSERT INTO hotel_profiles (user_id, name, location, about, website)
            VALUES ($1, $2, $3, $4, $5)
            """,
            user['id'],
            "Test Hotel",
            "Paris, France",
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


class TestUpdateHotelProfile:
    """Test hotel profile update endpoint"""
    
    def test_update_profile_unauthenticated(self, client):
        """Test that unauthenticated requests return 401"""
        response = client.put("/hotels/me", json={})
        assert response.status_code == status.HTTP_401_UNAUTHORIZED
    
    def test_update_profile_wrong_user_type(self, client, test_creator_user):
        """Test that creator users cannot update hotel profile"""
        from conftest import get_auth_headers_for_user
        headers = get_auth_headers_for_user(test_creator_user)
        response = client.put(
            "/hotels/me",
            json={
                "name": "Test Hotel",
                "location": "Test Location",
                "email": "test@test.com"
            },
            headers=headers
        )
        assert response.status_code == status.HTTP_403_FORBIDDEN
    
    @pytest.mark.asyncio
    async def test_update_profile_success(self, client, test_hotel_user):
        """Test successful hotel profile update"""
        from conftest import get_auth_headers_for_user
        headers = get_auth_headers_for_user(test_hotel_user)
        
        request_data = {
            "name": "Grand Luxury Resort",
            "location": "Bali, Indonesia",
            "email": "contact@grandluxury.com",
            "about": "A stunning beachfront resort offering world-class amenities",
            "website": "https://grandluxury.com",
            "phone": "+62-361-123-4567"
        }
        
        response = client.put("/hotels/me", json=request_data, headers=headers)
        
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        
        assert data["name"] == "Grand Luxury Resort"
        assert data["location"] == "Bali, Indonesia"
        assert data["email"] == "contact@grandluxury.com"
        assert data["about"] == "A stunning beachfront resort offering world-class amenities"
        assert data["website"] == "https://grandluxury.com"
        assert data["phone"] == "+62-361-123-4567"
        assert "id" in data
        assert "user_id" in data
        assert "status" in data
        assert "created_at" in data
        assert "updated_at" in data
    
    def test_update_profile_default_location(self, client, test_hotel_user):
        """Test that default location is rejected"""
        from conftest import get_auth_headers_for_user
        headers = get_auth_headers_for_user(test_hotel_user)
        
        response = client.put(
            "/hotels/me",
            json={
                "name": "Test Hotel",
                "location": "Not specified",  # Default value - should be rejected
                "email": "test@test.com"
            },
            headers=headers
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert "default" in response.json()["detail"].lower()
    
    def test_update_profile_missing_required_fields(self, client, test_hotel_user):
        """Test update with missing required fields"""
        from conftest import get_auth_headers_for_user
        headers = get_auth_headers_for_user(test_hotel_user)
        
        # Missing name
        response = client.put(
            "/hotels/me",
            json={
                "location": "Test Location",
                "email": "test@test.com"
            },
            headers=headers
        )
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY
    
    def test_update_profile_invalid_email(self, client, test_hotel_user):
        """Test update with invalid email format"""
        from conftest import get_auth_headers_for_user
        headers = get_auth_headers_for_user(test_hotel_user)
        
        response = client.put(
            "/hotels/me",
            json={
                "name": "Test Hotel",
                "location": "Test Location",
                "email": "invalid-email"  # Invalid email format
            },
            headers=headers
        )
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY
    
    def test_update_profile_about_too_short(self, client, test_hotel_user):
        """Test update with about field too short"""
        from conftest import get_auth_headers_for_user
        headers = get_auth_headers_for_user(test_hotel_user)
        
        response = client.put(
            "/hotels/me",
            json={
                "name": "Test Hotel",
                "location": "Test Location",
                "email": "test@test.com",
                "about": "Short"  # Less than 10 chars
            },
            headers=headers
        )
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY


class TestCreateHotelListing:
    """Test hotel listing creation endpoint"""
    
    def test_create_listing_unauthenticated(self, client):
        """Test that unauthenticated requests return 401"""
        response = client.post("/hotels/me/listings", json={})
        assert response.status_code == status.HTTP_401_UNAUTHORIZED
    
    def test_create_listing_wrong_user_type(self, client, test_creator_user):
        """Test that creator users cannot create hotel listings"""
        from conftest import get_auth_headers_for_user
        headers = get_auth_headers_for_user(test_creator_user)
        response = client.post(
            "/hotels/me/listings",
            json={
                "name": "Test Listing",
                "location": "Test",
                "description": "Test description",
                "collaborationOfferings": [],
                "creatorRequirements": {"platforms": ["Instagram"], "targetCountries": ["USA"]}
            },
            headers=headers
        )
        assert response.status_code == status.HTTP_403_FORBIDDEN
    
    @pytest.mark.asyncio
    async def test_create_listing_success(self, client, test_hotel_user):
        """Test successful listing creation"""
        from conftest import get_auth_headers_for_user
        headers = get_auth_headers_for_user(test_hotel_user)
        
        request_data = {
            "name": "Luxury Beach Villa",
            "location": "Bali, Indonesia",
            "description": "A stunning beachfront villa with private pool and ocean views",
            "accommodationType": "Villa",
            "images": [],
            "collaborationOfferings": [
                {
                    "collaborationType": "Free Stay",
                    "availabilityMonths": ["January", "February", "March"],
                    "platforms": ["Instagram", "TikTok"],
                    "freeStayMinNights": 2,
                    "freeStayMaxNights": 5
                }
            ],
            "creatorRequirements": {
                "platforms": ["Instagram", "TikTok"],
                "minFollowers": 50000,
                "targetCountries": ["USA", "Germany"],
                "targetAgeMin": 25,
                "targetAgeMax": 45
            }
        }
        
        response = client.post("/hotels/me/listings", json=request_data, headers=headers)
        
        assert response.status_code == status.HTTP_201_CREATED
        data = response.json()
        
        assert data["name"] == "Luxury Beach Villa"
        assert data["location"] == "Bali, Indonesia"
        assert data["description"] == "A stunning beachfront villa with private pool and ocean views"
        assert data["accommodationType"] == "Villa"
        assert len(data["collaborationOfferings"]) == 1
        assert data["collaborationOfferings"][0]["collaborationType"] == "Free Stay"
        assert data["collaborationOfferings"][0]["freeStayMinNights"] == 2
        assert data["collaborationOfferings"][0]["freeStayMaxNights"] == 5
        assert data["creatorRequirements"]["platforms"] == ["Instagram", "TikTok"]
        assert data["creatorRequirements"]["minFollowers"] == 50000
        assert "id" in data
        assert "hotelProfileId" in data
        assert "status" in data
        assert "createdAt" in data
        assert "updatedAt" in data
    
    @pytest.mark.asyncio
    async def test_create_listing_with_multiple_offerings(self, client, test_hotel_user):
        """Test listing creation with multiple collaboration offerings"""
        from conftest import get_auth_headers_for_user
        headers = get_auth_headers_for_user(test_hotel_user)
        
        request_data = {
            "name": "Grand Hotel",
            "location": "Paris, France",
            "description": "A luxurious hotel in the heart of Paris with exceptional service",
            "collaborationOfferings": [
                {
                    "collaborationType": "Free Stay",
                    "availabilityMonths": ["January", "February"],
                    "platforms": ["Instagram"],
                    "freeStayMinNights": 2,
                    "freeStayMaxNights": 4
                },
                {
                    "collaborationType": "Paid",
                    "availabilityMonths": ["March", "April"],
                    "platforms": ["TikTok", "YouTube"],
                    "paidMaxAmount": 5000
                },
                {
                    "collaborationType": "Discount",
                    "availabilityMonths": ["May", "June"],
                    "platforms": ["Instagram", "Facebook"],
                    "discountPercentage": 20
                }
            ],
            "creatorRequirements": {
                "platforms": ["Instagram"],
                "targetCountries": ["USA"]
            }
        }
        
        response = client.post("/hotels/me/listings", json=request_data, headers=headers)
        
        assert response.status_code == status.HTTP_201_CREATED
        data = response.json()
        
        assert len(data["collaborationOfferings"]) == 3
        # Verify each offering type has correct fields
        free_stay = next(o for o in data["collaborationOfferings"] if o["collaborationType"] == "Free Stay")
        assert free_stay["freeStayMinNights"] == 2
        assert free_stay["freeStayMaxNights"] == 4
        assert free_stay["paidMaxAmount"] is None
        assert free_stay["discountPercentage"] is None
        
        paid = next(o for o in data["collaborationOfferings"] if o["collaborationType"] == "Paid")
        assert paid["paidMaxAmount"] == 5000
        assert paid["freeStayMinNights"] is None
        assert paid["discountPercentage"] is None
        
        discount = next(o for o in data["collaborationOfferings"] if o["collaborationType"] == "Discount")
        assert discount["discountPercentage"] == 20
        assert discount["freeStayMinNights"] is None
        assert discount["paidMaxAmount"] is None
    
    def test_create_listing_missing_required_fields(self, client, test_hotel_user):
        """Test listing creation with missing required fields"""
        from conftest import get_auth_headers_for_user
        headers = get_auth_headers_for_user(test_hotel_user)
        
        # Missing name
        response = client.post(
            "/hotels/me/listings",
            json={
                "location": "Test",
                "description": "Test description",
                "collaborationOfferings": [],
                "creatorRequirements": {"platforms": ["Instagram"], "targetCountries": ["USA"]}
            },
            headers=headers
        )
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY
    
    def test_create_listing_no_offerings(self, client, test_hotel_user):
        """Test listing creation with no collaboration offerings"""
        from conftest import get_auth_headers_for_user
        headers = get_auth_headers_for_user(test_hotel_user)
        
        response = client.post(
            "/hotels/me/listings",
            json={
                "name": "Test Listing",
                "location": "Test",
                "description": "Test description",
                "collaborationOfferings": [],  # Empty - should fail
                "creatorRequirements": {"platforms": ["Instagram"], "targetCountries": ["USA"]}
            },
            headers=headers
        )
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY
    
    def test_create_listing_free_stay_missing_fields(self, client, test_hotel_user):
        """Test Free Stay offering with missing required fields"""
        from conftest import get_auth_headers_for_user
        headers = get_auth_headers_for_user(test_hotel_user)
        
        response = client.post(
            "/hotels/me/listings",
            json={
                "name": "Test Listing",
                "location": "Test",
                "description": "Test description",
                "collaborationOfferings": [
                    {
                        "collaborationType": "Free Stay",
                        "availabilityMonths": ["January"],
                        "platforms": ["Instagram"],
                        # Missing freeStayMinNights and freeStayMaxNights
                    }
                ],
                "creatorRequirements": {"platforms": ["Instagram"], "targetCountries": ["USA"]}
            },
            headers=headers
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
    
    def test_create_listing_free_stay_invalid_nights(self, client, test_hotel_user):
        """Test Free Stay offering with max_nights < min_nights"""
        from conftest import get_auth_headers_for_user
        headers = get_auth_headers_for_user(test_hotel_user)
        
        response = client.post(
            "/hotels/me/listings",
            json={
                "name": "Test Listing",
                "location": "Test",
                "description": "Test description",
                "collaborationOfferings": [
                    {
                        "collaborationType": "Free Stay",
                        "availabilityMonths": ["January"],
                        "platforms": ["Instagram"],
                        "freeStayMinNights": 5,
                        "freeStayMaxNights": 2  # Invalid - max < min
                    }
                ],
                "creatorRequirements": {"platforms": ["Instagram"], "targetCountries": ["USA"]}
            },
            headers=headers
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
    
    def test_create_listing_paid_missing_amount(self, client, test_hotel_user):
        """Test Paid offering with missing paid_max_amount"""
        from conftest import get_auth_headers_for_user
        headers = get_auth_headers_for_user(test_hotel_user)
        
        response = client.post(
            "/hotels/me/listings",
            json={
                "name": "Test Listing",
                "location": "Test",
                "description": "Test description",
                "collaborationOfferings": [
                    {
                        "collaborationType": "Paid",
                        "availabilityMonths": ["January"],
                        "platforms": ["Instagram"],
                        # Missing paidMaxAmount
                    }
                ],
                "creatorRequirements": {"platforms": ["Instagram"], "targetCountries": ["USA"]}
            },
            headers=headers
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
    
    def test_create_listing_discount_missing_percentage(self, client, test_hotel_user):
        """Test Discount offering with missing discount_percentage"""
        from conftest import get_auth_headers_for_user
        headers = get_auth_headers_for_user(test_hotel_user)
        
        response = client.post(
            "/hotels/me/listings",
            json={
                "name": "Test Listing",
                "location": "Test",
                "description": "Test description",
                "collaborationOfferings": [
                    {
                        "collaborationType": "Discount",
                        "availabilityMonths": ["January"],
                        "platforms": ["Instagram"],
                        # Missing discountPercentage
                    }
                ],
                "creatorRequirements": {"platforms": ["Instagram"], "targetCountries": ["USA"]}
            },
            headers=headers
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
    
    def test_create_listing_creator_requirements_no_platforms(self, client, test_hotel_user):
        """Test listing creation with empty platforms in creator requirements"""
        from conftest import get_auth_headers_for_user
        headers = get_auth_headers_for_user(test_hotel_user)
        
        response = client.post(
            "/hotels/me/listings",
            json={
                "name": "Test Listing",
                "location": "Test",
                "description": "Test description",
                "collaborationOfferings": [
                    {
                        "collaborationType": "Free Stay",
                        "availabilityMonths": ["January"],
                        "platforms": ["Instagram"],
                        "freeStayMinNights": 2,
                        "freeStayMaxNights": 5
                    }
                ],
                "creatorRequirements": {
                    "platforms": [],  # Empty - should fail
                    "targetCountries": ["USA"]
                }
            },
            headers=headers
        )
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY
    
    def test_create_listing_creator_requirements_no_countries(self, client, test_hotel_user):
        """Test listing creation with empty target_countries"""
        from conftest import get_auth_headers_for_user
        headers = get_auth_headers_for_user(test_hotel_user)
        
        response = client.post(
            "/hotels/me/listings",
            json={
                "name": "Test Listing",
                "location": "Test",
                "description": "Test description",
                "collaborationOfferings": [
                    {
                        "collaborationType": "Free Stay",
                        "availabilityMonths": ["January"],
                        "platforms": ["Instagram"],
                        "freeStayMinNights": 2,
                        "freeStayMaxNights": 5
                    }
                ],
                "creatorRequirements": {
                    "platforms": ["Instagram"],
                    "targetCountries": []  # Empty - should fail
                }
            },
            headers=headers
        )
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY
    
    def test_create_listing_invalid_age_range(self, client, test_hotel_user):
        """Test listing creation with invalid age range"""
        from conftest import get_auth_headers_for_user
        headers = get_auth_headers_for_user(test_hotel_user)
        
        response = client.post(
            "/hotels/me/listings",
            json={
                "name": "Test Listing",
                "location": "Test",
                "description": "Test description",
                "collaborationOfferings": [
                    {
                        "collaborationType": "Free Stay",
                        "availabilityMonths": ["January"],
                        "platforms": ["Instagram"],
                        "freeStayMinNights": 2,
                        "freeStayMaxNights": 5
                    }
                ],
                "creatorRequirements": {
                    "platforms": ["Instagram"],
                    "targetCountries": ["USA"],
                    "targetAgeMin": 45,
                    "targetAgeMax": 25  # Invalid - max < min
                }
            },
            headers=headers
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
    
    def test_create_listing_description_too_short(self, client, test_hotel_user):
        """Test listing creation with description less than 10 characters"""
        from conftest import get_auth_headers_for_user
        headers = get_auth_headers_for_user(test_hotel_user)
        
        response = client.post(
            "/hotels/me/listings",
            json={
                "name": "Test Listing",
                "location": "Test",
                "description": "Short",  # Less than 10 chars
                "collaborationOfferings": [
                    {
                        "collaborationType": "Free Stay",
                        "availabilityMonths": ["January"],
                        "platforms": ["Instagram"],
                        "freeStayMinNights": 2,
                        "freeStayMaxNights": 5
                    }
                ],
                "creatorRequirements": {"platforms": ["Instagram"], "targetCountries": ["USA"]}
            },
            headers=headers
        )
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY


class TestGetHotelProfile:
    """Test GET /hotels/me endpoint"""
    
    def test_get_profile_unauthenticated(self, client):
        """Test that unauthenticated requests return 401"""
        response = client.get("/hotels/me")
        assert response.status_code == status.HTTP_401_UNAUTHORIZED
    
    def test_get_profile_wrong_user_type(self, client, test_creator_user):
        """Test that creator users cannot access hotel endpoint"""
        from conftest import get_auth_headers_for_user
        headers = get_auth_headers_for_user(test_creator_user)
        response = client.get("/hotels/me", headers=headers)
        assert response.status_code == status.HTTP_403_FORBIDDEN
    
    @pytest.mark.asyncio
    async def test_get_profile_success(self, client, test_hotel_user):
        """Test successful hotel profile retrieval"""
        from conftest import get_auth_headers_for_user
        headers = get_auth_headers_for_user(test_hotel_user)
        
        response = client.get("/hotels/me", headers=headers)
        
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        
        assert "id" in data
        assert "user_id" in data
        assert "name" in data
        assert "location" in data
        assert "email" in data
        assert "status" in data
        assert "created_at" in data
        assert "updated_at" in data
        assert "listings" in data
        assert isinstance(data["listings"], list)
    
    @pytest.mark.asyncio
    async def test_get_profile_with_listings(self, client, test_hotel_user):
        """Test hotel profile retrieval with listings"""
        from conftest import get_auth_headers_for_user
        headers = get_auth_headers_for_user(test_hotel_user)
        
        # Create a listing first
        listing_data = {
            "name": "Test Villa",
            "location": "Bali, Indonesia",
            "description": "A beautiful villa with ocean views",
            "collaborationOfferings": [
                {
                    "collaborationType": "Free Stay",
                    "availabilityMonths": ["January", "February"],
                    "platforms": ["Instagram"],
                    "freeStayMinNights": 2,
                    "freeStayMaxNights": 5
                }
            ],
            "creatorRequirements": {
                "platforms": ["Instagram"],
                "targetCountries": ["USA"]
            }
        }
        
        create_response = client.post("/hotels/me/listings", json=listing_data, headers=headers)
        assert create_response.status_code == status.HTTP_201_CREATED
        
        # Get profile
        response = client.get("/hotels/me", headers=headers)
        
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        
        assert len(data["listings"]) > 0
        listing = data["listings"][0]
        assert listing["name"] == "Test Villa"
        assert "collaboration_offerings" in listing
        assert "creator_requirements" in listing
        assert len(listing["collaboration_offerings"]) == 1
        assert listing["collaboration_offerings"][0]["collaborationType"] == "Free Stay"


class TestUpdateHotelProfilePartial:
    """Test PUT /hotels/me endpoint with partial updates"""
    
    def test_update_profile_partial_name_only(self, client, test_hotel_user):
        """Test updating only the name field"""
        from conftest import get_auth_headers_for_user
        headers = get_auth_headers_for_user(test_hotel_user)
        
        # Get current profile
        get_response = client.get("/hotels/me", headers=headers)
        assert get_response.status_code == status.HTTP_200_OK
        original_data = get_response.json()
        
        # Update only name
        response = client.put(
            "/hotels/me",
            json={"name": "Updated Hotel Name"},
            headers=headers
        )
        
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        
        assert data["name"] == "Updated Hotel Name"
        assert data["location"] == original_data["location"]  # Unchanged
        assert data["email"] == original_data["email"]  # Unchanged
    
    def test_update_profile_partial_location_only(self, client, test_hotel_user):
        """Test updating only the location field"""
        from conftest import get_auth_headers_for_user
        headers = get_auth_headers_for_user(test_hotel_user)
        
        response = client.put(
            "/hotels/me",
            json={"location": "New York, USA"},
            headers=headers
        )
        
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        
        assert data["location"] == "New York, USA"
    
    def test_update_profile_partial_email_only(self, client, test_hotel_user):
        """Test updating only the email field"""
        from conftest import get_auth_headers_for_user
        headers = get_auth_headers_for_user(test_hotel_user)
        
        response = client.put(
            "/hotels/me",
            json={"email": "newemail@hotel.com"},
            headers=headers
        )
        
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        
        assert data["email"] == "newemail@hotel.com"
    
    def test_update_profile_partial_multiple_fields(self, client, test_hotel_user):
        """Test updating multiple fields at once"""
        from conftest import get_auth_headers_for_user
        headers = get_auth_headers_for_user(test_hotel_user)
        
        response = client.put(
            "/hotels/me",
            json={
                "name": "Grand Hotel",
                "about": "A luxurious hotel with world-class amenities",
                "website": "https://grandhotel.com"
            },
            headers=headers
        )
        
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        
        assert data["name"] == "Grand Hotel"
        assert data["about"] == "A luxurious hotel with world-class amenities"
        assert data["website"] == "https://grandhotel.com"
    
    def test_update_profile_empty_request(self, client, test_hotel_user):
        """Test update with empty request (should succeed but not change anything)"""
        from conftest import get_auth_headers_for_user
        headers = get_auth_headers_for_user(test_hotel_user)
        
        # Get original profile
        get_response = client.get("/hotels/me", headers=headers)
        original_data = get_response.json()
        
        # Update with empty request
        response = client.put("/hotels/me", json={}, headers=headers)
        
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        
        # Should return same data
        assert data["name"] == original_data["name"]
        assert data["location"] == original_data["location"]


class TestUpdateHotelListing:
    """Test PUT /hotels/me/listings/{listing_id} endpoint"""
    
    @pytest.mark.asyncio
    async def test_update_listing_unauthenticated(self, client):
        """Test that unauthenticated requests return 401"""
        response = client.put("/hotels/me/listings/123", json={})
        assert response.status_code == status.HTTP_401_UNAUTHORIZED
    
    @pytest.mark.asyncio
    async def test_update_listing_wrong_user_type(self, client, test_creator_user):
        """Test that creator users cannot update listings"""
        from conftest import get_auth_headers_for_user
        headers = get_auth_headers_for_user(test_creator_user)
        response = client.put("/hotels/me/listings/123", json={}, headers=headers)
        assert response.status_code == status.HTTP_403_FORBIDDEN
    
    @pytest.mark.asyncio
    async def test_update_listing_not_found(self, client, test_hotel_user):
        """Test updating non-existent listing"""
        from conftest import get_auth_headers_for_user
        headers = get_auth_headers_for_user(test_hotel_user)
        
        response = client.put(
            "/hotels/me/listings/00000000-0000-0000-0000-000000000000",
            json={"name": "Updated Name"},
            headers=headers
        )
        
        assert response.status_code == status.HTTP_404_NOT_FOUND
    
    @pytest.mark.asyncio
    async def test_update_listing_partial_name(self, client, test_hotel_user):
        """Test updating only listing name"""
        from conftest import get_auth_headers_for_user
        headers = get_auth_headers_for_user(test_hotel_user)
        
        # Create a listing first
        listing_data = {
            "name": "Original Villa",
            "location": "Bali, Indonesia",
            "description": "A beautiful villa with ocean views and private pool",
            "collaborationOfferings": [
                {
                    "collaborationType": "Free Stay",
                    "availabilityMonths": ["January"],
                    "platforms": ["Instagram"],
                    "freeStayMinNights": 2,
                    "freeStayMaxNights": 5
                }
            ],
            "creatorRequirements": {
                "platforms": ["Instagram"],
                "targetCountries": ["USA"]
            }
        }
        
        create_response = client.post("/hotels/me/listings", json=listing_data, headers=headers)
        assert create_response.status_code == status.HTTP_201_CREATED
        listing_id = create_response.json()["id"]
        
        # Update only name
        response = client.put(
            f"/hotels/me/listings/{listing_id}",
            json={"name": "Updated Villa Name"},
            headers=headers
        )
        
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        
        assert data["name"] == "Updated Villa Name"
        assert data["location"] == "Bali, Indonesia"  # Unchanged
        assert data["description"] == "A beautiful villa with ocean views and private pool"  # Unchanged
    
    @pytest.mark.asyncio
    async def test_update_listing_partial_description(self, client, test_hotel_user):
        """Test updating only listing description"""
        from conftest import get_auth_headers_for_user
        headers = get_auth_headers_for_user(test_hotel_user)
        
        # Create a listing
        listing_data = {
            "name": "Test Villa",
            "location": "Bali, Indonesia",
            "description": "Original description",
            "collaborationOfferings": [
                {
                    "collaborationType": "Free Stay",
                    "availabilityMonths": ["January"],
                    "platforms": ["Instagram"],
                    "freeStayMinNights": 2,
                    "freeStayMaxNights": 5
                }
            ],
            "creatorRequirements": {
                "platforms": ["Instagram"],
                "targetCountries": ["USA"]
            }
        }
        
        create_response = client.post("/hotels/me/listings", json=listing_data, headers=headers)
        listing_id = create_response.json()["id"]
        
        # Update description
        response = client.put(
            f"/hotels/me/listings/{listing_id}",
            json={"description": "Updated description with more details"},
            headers=headers
        )
        
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        
        assert data["description"] == "Updated description with more details"
        assert data["name"] == "Test Villa"  # Unchanged
    
    @pytest.mark.asyncio
    async def test_update_listing_offerings(self, client, test_hotel_user):
        """Test updating collaboration offerings"""
        from conftest import get_auth_headers_for_user
        headers = get_auth_headers_for_user(test_hotel_user)
        
        # Create a listing
        listing_data = {
            "name": "Test Villa",
            "location": "Bali, Indonesia",
            "description": "A beautiful villa with ocean views",
            "collaborationOfferings": [
                {
                    "collaborationType": "Free Stay",
                    "availabilityMonths": ["January"],
                    "platforms": ["Instagram"],
                    "freeStayMinNights": 2,
                    "freeStayMaxNights": 5
                }
            ],
            "creatorRequirements": {
                "platforms": ["Instagram"],
                "targetCountries": ["USA"]
            }
        }
        
        create_response = client.post("/hotels/me/listings", json=listing_data, headers=headers)
        listing_id = create_response.json()["id"]
        
        # Update offerings
        response = client.put(
            f"/hotels/me/listings/{listing_id}",
            json={
                "collaborationOfferings": [
                    {
                        "collaborationType": "Paid",
                        "availabilityMonths": ["February", "March"],
                        "platforms": ["TikTok", "YouTube"],
                        "paidMaxAmount": 5000
                    },
                    {
                        "collaborationType": "Discount",
                        "availabilityMonths": ["April"],
                        "platforms": ["Instagram"],
                        "discountPercentage": 20
                    }
                ]
            },
            headers=headers
        )
        
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        
        assert len(data["collaborationOfferings"]) == 2
        assert data["collaborationOfferings"][0]["collaborationType"] in ["Paid", "Discount"]
        assert data["collaborationOfferings"][1]["collaborationType"] in ["Paid", "Discount"]
    
    @pytest.mark.asyncio
    async def test_update_listing_requirements(self, client, test_hotel_user):
        """Test updating creator requirements"""
        from conftest import get_auth_headers_for_user
        headers = get_auth_headers_for_user(test_hotel_user)
        
        # Create a listing
        listing_data = {
            "name": "Test Villa",
            "location": "Bali, Indonesia",
            "description": "A beautiful villa with ocean views",
            "collaborationOfferings": [
                {
                    "collaborationType": "Free Stay",
                    "availabilityMonths": ["January"],
                    "platforms": ["Instagram"],
                    "freeStayMinNights": 2,
                    "freeStayMaxNights": 5
                }
            ],
            "creatorRequirements": {
                "platforms": ["Instagram"],
                "targetCountries": ["USA"]
            }
        }
        
        create_response = client.post("/hotels/me/listings", json=listing_data, headers=headers)
        listing_id = create_response.json()["id"]
        
        # Update requirements
        response = client.put(
            f"/hotels/me/listings/{listing_id}",
            json={
                "creatorRequirements": {
                    "platforms": ["TikTok", "YouTube"],
                    "minFollowers": 100000,
                    "targetCountries": ["USA", "Canada", "UK"],
                    "targetAgeMin": 25,
                    "targetAgeMax": 40
                }
            },
            headers=headers
        )
        
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        
        assert data["creatorRequirements"]["platforms"] == ["TikTok", "YouTube"]
        assert data["creatorRequirements"]["minFollowers"] == 100000
        assert len(data["creatorRequirements"]["targetCountries"]) == 3
    
    @pytest.mark.asyncio
    async def test_update_listing_multiple_fields(self, client, test_hotel_user):
        """Test updating multiple fields at once"""
        from conftest import get_auth_headers_for_user
        headers = get_auth_headers_for_user(test_hotel_user)
        
        # Create a listing
        listing_data = {
            "name": "Original Villa",
            "location": "Bali, Indonesia",
            "description": "Original description",
            "accommodationType": "Villa",
            "collaborationOfferings": [
                {
                    "collaborationType": "Free Stay",
                    "availabilityMonths": ["January"],
                    "platforms": ["Instagram"],
                    "freeStayMinNights": 2,
                    "freeStayMaxNights": 5
                }
            ],
            "creatorRequirements": {
                "platforms": ["Instagram"],
                "targetCountries": ["USA"]
            }
        }
        
        create_response = client.post("/hotels/me/listings", json=listing_data, headers=headers)
        listing_id = create_response.json()["id"]
        
        # Update multiple fields
        response = client.put(
            f"/hotels/me/listings/{listing_id}",
            json={
                "name": "Updated Villa",
                "location": "Maldives",
                "description": "Updated description",
                "accommodationType": "Resort",
                "images": ["https://example.com/image1.jpg", "https://example.com/image2.jpg"]
            },
            headers=headers
        )
        
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        
        assert data["name"] == "Updated Villa"
        assert data["location"] == "Maldives"
        assert data["description"] == "Updated description"
        assert data["accommodationType"] == "Resort"
        assert len(data["images"]) == 2


class TestDeleteHotelListing:
    """Test DELETE /hotels/me/listings/{listing_id} endpoint"""
    
    @pytest.mark.asyncio
    async def test_delete_listing_unauthenticated(self, client):
        """Test that unauthenticated requests return 401"""
        response = client.delete("/hotels/me/listings/123")
        assert response.status_code == status.HTTP_401_UNAUTHORIZED
    
    @pytest.mark.asyncio
    async def test_delete_listing_wrong_user_type(self, client, test_creator_user):
        """Test that creator users cannot delete listings"""
        from conftest import get_auth_headers_for_user
        headers = get_auth_headers_for_user(test_creator_user)
        response = client.delete("/hotels/me/listings/123", headers=headers)
        assert response.status_code == status.HTTP_403_FORBIDDEN
    
    @pytest.mark.asyncio
    async def test_delete_listing_not_found(self, client, test_hotel_user):
        """Test deleting non-existent listing"""
        from conftest import get_auth_headers_for_user
        headers = get_auth_headers_for_user(test_hotel_user)
        
        response = client.delete(
            "/hotels/me/listings/00000000-0000-0000-0000-000000000000",
            headers=headers
        )
        
        assert response.status_code == status.HTTP_404_NOT_FOUND
    
    @pytest.mark.asyncio
    async def test_delete_listing_success(self, client, test_hotel_user):
        """Test successful listing deletion"""
        from conftest import get_auth_headers_for_user
        headers = get_auth_headers_for_user(test_hotel_user)
        
        # Create a listing first
        listing_data = {
            "name": "Villa to Delete",
            "location": "Bali, Indonesia",
            "description": "A beautiful villa that will be deleted",
            "collaborationOfferings": [
                {
                    "collaborationType": "Free Stay",
                    "availabilityMonths": ["January"],
                    "platforms": ["Instagram"],
                    "freeStayMinNights": 2,
                    "freeStayMaxNights": 5
                }
            ],
            "creatorRequirements": {
                "platforms": ["Instagram"],
                "targetCountries": ["USA"]
            }
        }
        
        create_response = client.post("/hotels/me/listings", json=listing_data, headers=headers)
        assert create_response.status_code == status.HTTP_201_CREATED
        listing_id = create_response.json()["id"]
        
        # Delete the listing
        delete_response = client.delete(f"/hotels/me/listings/{listing_id}", headers=headers)
        
        assert delete_response.status_code == status.HTTP_204_NO_CONTENT
        
        # Verify listing is deleted by trying to get profile
        get_response = client.get("/hotels/me", headers=headers)
        assert get_response.status_code == status.HTTP_200_OK
        profile_data = get_response.json()
        
        # Listing should not be in the list
        listing_ids = [listing["id"] for listing in profile_data["listings"]]
        assert listing_id not in listing_ids
    
    @pytest.mark.asyncio
    async def test_delete_listing_other_hotel(self, client, db_setup):
        """Test that hotel cannot delete another hotel's listing"""
        import bcrypt
        import uuid
        from conftest import get_auth_headers_for_user
        
        # Create two hotels
        hotel1_email = f"hotel1_{uuid.uuid4().hex[:8]}@test.com"
        hotel2_email = f"hotel2_{uuid.uuid4().hex[:8]}@test.com"
        password_hash = bcrypt.hashpw("testpassword123".encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
        
        hotel1 = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'verified')
            RETURNING id
            """,
            hotel1_email,
            password_hash,
            "Hotel 1",
            "hotel"
        )
        
        hotel2 = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'verified')
            RETURNING id
            """,
            hotel2_email,
            password_hash,
            "Hotel 2",
            "hotel"
        )
        
        # Create hotel profiles
        hotel1_profile = await Database.fetchrow(
            "INSERT INTO hotel_profiles (user_id, name, location) VALUES ($1, $2, $3) RETURNING id",
            hotel1['id'],
            "Hotel 1",
            "Location 1"
        )
        
        hotel2_profile = await Database.fetchrow(
            "INSERT INTO hotel_profiles (user_id, name, location) VALUES ($1, $2, $3) RETURNING id",
            hotel2['id'],
            "Hotel 2",
            "Location 2"
        )
        
        # Create listing for hotel1
        listing = await Database.fetchrow(
            """
            INSERT INTO hotel_listings (hotel_profile_id, name, location, description)
            VALUES ($1, $2, $3, $4)
            RETURNING id
            """,
            hotel1_profile['id'],
            "Hotel 1 Listing",
            "Location",
            "Description"
        )
        
        try:
            # Try to delete hotel1's listing as hotel2
            headers = get_auth_headers_for_user(str(hotel2['id']))
            response = client.delete(f"/hotels/me/listings/{listing['id']}", headers=headers)
            
            assert response.status_code == status.HTTP_404_NOT_FOUND
        finally:
            # Cleanup
            await Database.execute("DELETE FROM users WHERE id = $1", hotel1['id'])
            await Database.execute("DELETE FROM users WHERE id = $1", hotel2['id'])

