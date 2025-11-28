"""
Tests for hotel endpoints
"""
import pytest
from fastapi import status
import json


class TestHotels:
    """Test hotel profile endpoints"""
    
    def test_get_hotel_profile_not_found(self, client, db_setup):
        """Test getting hotel profile when profile doesn't exist"""
        # Create a user without hotel profile
        response = client.post(
            "/auth/register",
            json={
                "email": "nohotelprofile@test.com",
                "password": "testpassword123",
                "type": "hotel",
                "name": "No Profile Hotel"
            }
        )
        # Note: Registration now creates hotel profile automatically
        # So we need to delete it first
        token = response.json()["access_token"]
        user_id = response.json()["id"]
        
        # Delete the auto-created profile
        from app.database import Database
        import asyncio
        asyncio.run(Database.execute(
            "DELETE FROM hotel_profiles WHERE user_id = $1",
            user_id
        ))
        
        # Try to get profile
        response = client.get(
            "/hotels/me",
            headers={"Authorization": f"Bearer {token}"}
        )
        assert response.status_code == status.HTTP_404_NOT_FOUND
        
        # Cleanup
        asyncio.run(Database.execute(
            "DELETE FROM users WHERE id = $1",
            user_id
        ))
    
    def test_get_hotel_profile_success(self, client, test_hotel_profile, hotel_auth_headers):
        """Test getting hotel profile successfully"""
        hotel_profile_id, user_id = test_hotel_profile
        
        response = client.get(
            "/hotels/me",
            headers=hotel_auth_headers
        )
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert data["id"] == hotel_profile_id
        assert data["user_id"] == user_id
        assert data["name"] == "Test Hotel"
        assert data["category"] == "Hotel"
        assert data["location"] == "Test Location"
        assert data["email"] == "test_hotel@test.com"
        assert isinstance(data["listings"], list)
        assert len(data["listings"]) == 0
    
    def test_update_hotel_profile(self, client, test_hotel_profile, hotel_auth_headers):
        """Test updating hotel profile"""
        hotel_profile_id, user_id = test_hotel_profile
        
        response = client.put(
            "/hotels/me",
            headers=hotel_auth_headers,
            json={
                "name": "Updated Hotel Name",
                "category": "Resort",
                "location": "Bali, Indonesia",
                "about": "A beautiful resort",
                "website": "https://example.com",
                "phone": "+1234567890"
            }
        )
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert data["name"] == "Updated Hotel Name"
        assert data["category"] == "Resort"
        assert data["location"] == "Bali, Indonesia"
        assert data["about"] == "A beautiful resort"
        assert data["website"] == "https://example.com"
        assert data["phone"] == "+1234567890"
    
    def test_update_hotel_profile_partial(self, client, test_hotel_profile, hotel_auth_headers):
        """Test updating hotel profile with partial data"""
        hotel_profile_id, user_id = test_hotel_profile
        
        response = client.put(
            "/hotels/me",
            headers=hotel_auth_headers,
            json={
                "name": "New Hotel Name Only"
            }
        )
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert data["name"] == "New Hotel Name Only"
        # Other fields should remain unchanged
        assert data["category"] == "Hotel"
        assert data["location"] == "Test Location"
    
    def test_update_hotel_profile_no_fields(self, client, test_hotel_profile, hotel_auth_headers):
        """Test updating hotel profile with no fields"""
        hotel_profile_id, user_id = test_hotel_profile
        
        response = client.put(
            "/hotels/me",
            headers=hotel_auth_headers,
            json={}
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
    
    def test_update_hotel_profile_invalid_category(self, client, test_hotel_profile, hotel_auth_headers):
        """Test updating hotel profile with invalid category"""
        hotel_profile_id, user_id = test_hotel_profile
        
        response = client.put(
            "/hotels/me",
            headers=hotel_auth_headers,
            json={
                "category": "Invalid Category"
            }
        )
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY
    
    def test_create_listing(self, client, test_hotel_profile, hotel_auth_headers):
        """Test creating a listing with collaboration offerings and requirements"""
        hotel_profile_id, user_id = test_hotel_profile
        
        response = client.post(
            "/hotels/me/listings",
            headers=hotel_auth_headers,
            json={
                "name": "Beach Villa",
                "location": "Bali, Indonesia",
                "description": "Luxury beachfront villa with ocean views",
                "accommodation_type": "Villa",
                "images": ["https://example.com/image1.jpg"],
                "collaboration_offerings": [
                    {
                        "collaboration_type": "Free Stay",
                        "availability_months": ["January", "February"],
                        "platforms": ["Instagram", "TikTok"],
                        "free_stay_min_nights": 2,
                        "free_stay_max_nights": 5
                    }
                ],
                "creator_requirements": {
                    "platforms": ["Instagram", "TikTok"],
                    "min_followers": 10000,
                    "target_countries": ["USA", "Germany"],
                    "target_age_min": 25,
                    "target_age_max": 45
                }
            }
        )
        assert response.status_code == status.HTTP_201_CREATED
        data = response.json()
        assert data["name"] == "Beach Villa"
        assert data["location"] == "Bali, Indonesia"
        assert data["description"] == "Luxury beachfront villa with ocean views"
        assert data["accommodation_type"] == "Villa"
        assert len(data["images"]) == 1
        assert len(data["collaboration_offerings"]) == 1
        assert data["collaboration_offerings"][0]["collaboration_type"] == "Free Stay"
        assert data["collaboration_offerings"][0]["free_stay_min_nights"] == 2
        assert data["collaboration_offerings"][0]["free_stay_max_nights"] == 5
        assert data["creator_requirements"] is not None
        assert len(data["creator_requirements"]["platforms"]) == 2
        assert data["creator_requirements"]["min_followers"] == 10000
    
    def test_create_listing_with_multiple_offerings(self, client, test_hotel_profile, hotel_auth_headers):
        """Test creating a listing with multiple collaboration offerings"""
        hotel_profile_id, user_id = test_hotel_profile
        
        response = client.post(
            "/hotels/me/listings",
            headers=hotel_auth_headers,
            json={
                "name": "Luxury Resort",
                "location": "Maldives",
                "description": "A beautiful luxury resort with multiple collaboration options",
                "collaboration_offerings": [
                    {
                        "collaboration_type": "Free Stay",
                        "availability_months": ["January", "February"],
                        "platforms": ["Instagram"],
                        "free_stay_min_nights": 3,
                        "free_stay_max_nights": 7
                    },
                    {
                        "collaboration_type": "Paid",
                        "availability_months": ["March", "April"],
                        "platforms": ["TikTok", "YouTube"],
                        "paid_max_amount": 1500.00
                    },
                    {
                        "collaboration_type": "Discount",
                        "availability_months": ["May", "June"],
                        "platforms": ["Instagram", "Facebook"],
                        "discount_percentage": 30
                    }
                ],
                "creator_requirements": {
                    "platforms": ["Instagram"],
                    "min_followers": 50000,
                    "target_countries": ["USA"],
                    "target_age_min": 30,
                    "target_age_max": 50
                }
            }
        )
        assert response.status_code == status.HTTP_201_CREATED
        data = response.json()
        assert len(data["collaboration_offerings"]) == 3
        assert data["collaboration_offerings"][0]["collaboration_type"] == "Free Stay"
        assert data["collaboration_offerings"][1]["collaboration_type"] == "Paid"
        assert data["collaboration_offerings"][1]["paid_max_amount"] == 1500.0
        assert data["collaboration_offerings"][2]["collaboration_type"] == "Discount"
        assert data["collaboration_offerings"][2]["discount_percentage"] == 30
    
    def test_create_listing_validation_errors(self, client, test_hotel_profile, hotel_auth_headers):
        """Test creating listing with validation errors"""
        hotel_profile_id, user_id = test_hotel_profile
        
        # Test with too short description
        response = client.post(
            "/hotels/me/listings",
            headers=hotel_auth_headers,
            json={
                "name": "Test",
                "location": "Test",
                "description": "Short",
                "collaboration_offerings": [],
                "creator_requirements": {
                    "platforms": ["Instagram"],
                    "target_countries": ["USA"]
                }
            }
        )
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY
        errors = response.json()["detail"]
        assert any(error["loc"] == ["body", "description"] for error in errors)
        assert any(error["loc"] == ["body", "collaboration_offerings"] for error in errors)
    
    def test_create_listing_invalid_free_stay(self, client, test_hotel_profile, hotel_auth_headers):
        """Test creating listing with invalid Free Stay offering"""
        hotel_profile_id, user_id = test_hotel_profile
        
        response = client.post(
            "/hotels/me/listings",
            headers=hotel_auth_headers,
            json={
                "name": "Test Villa",
                "location": "Test Location",
                "description": "A test villa description that is long enough",
                "collaboration_offerings": [
                    {
                        "collaboration_type": "Free Stay",
                        "availability_months": ["January"],
                        "platforms": ["Instagram"],
                        "free_stay_min_nights": 5,
                        "free_stay_max_nights": 2  # Invalid: max < min
                    }
                ],
                "creator_requirements": {
                    "platforms": ["Instagram"],
                    "target_countries": ["USA"]
                }
            }
        )
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY
    
    def test_create_listing_missing_type_specific_fields(self, client, test_hotel_profile, hotel_auth_headers):
        """Test creating listing with missing type-specific fields"""
        hotel_profile_id, user_id = test_hotel_profile
        
        # Free Stay without min/max nights
        response = client.post(
            "/hotels/me/listings",
            headers=hotel_auth_headers,
            json={
                "name": "Test Villa",
                "location": "Test Location",
                "description": "A test villa description that is long enough",
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
                    "target_countries": ["USA"]
                }
            }
        )
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY
    
    def test_update_listing(self, client, test_hotel_profile, hotel_auth_headers):
        """Test updating a listing"""
        hotel_profile_id, user_id = test_hotel_profile
        
        # Create listing first
        create_response = client.post(
            "/hotels/me/listings",
            headers=hotel_auth_headers,
            json={
                "name": "Original Villa",
                "location": "Original Location",
                "description": "Original description that is long enough",
                "collaboration_offerings": [
                    {
                        "collaboration_type": "Free Stay",
                        "availability_months": ["January"],
                        "platforms": ["Instagram"],
                        "free_stay_min_nights": 2,
                        "free_stay_max_nights": 5
                    }
                ],
                "creator_requirements": {
                    "platforms": ["Instagram"],
                    "target_countries": ["USA"]
                }
            }
        )
        listing_id = create_response.json()["id"]
        
        # Update listing
        response = client.put(
            f"/hotels/me/listings/{listing_id}",
            headers=hotel_auth_headers,
            json={
                "name": "Updated Villa",
                "description": "Updated description that is long enough"
            }
        )
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert data["name"] == "Updated Villa"
        assert data["description"] == "Updated description that is long enough"
        assert data["location"] == "Original Location"  # Should remain unchanged
        assert len(data["collaboration_offerings"]) == 1  # Should remain unchanged
    
    def test_update_listing_with_new_offerings(self, client, test_hotel_profile, hotel_auth_headers):
        """Test updating listing with new collaboration offerings"""
        hotel_profile_id, user_id = test_hotel_profile
        
        # Create listing first
        create_response = client.post(
            "/hotels/me/listings",
            headers=hotel_auth_headers,
            json={
                "name": "Original Villa",
                "location": "Original Location",
                "description": "Original description that is long enough",
                "collaboration_offerings": [
                    {
                        "collaboration_type": "Free Stay",
                        "availability_months": ["January"],
                        "platforms": ["Instagram"],
                        "free_stay_min_nights": 2,
                        "free_stay_max_nights": 5
                    }
                ],
                "creator_requirements": {
                    "platforms": ["Instagram"],
                    "target_countries": ["USA"]
                }
            }
        )
        listing_id = create_response.json()["id"]
        
        # Update with new offerings
        response = client.put(
            f"/hotels/me/listings/{listing_id}",
            headers=hotel_auth_headers,
            json={
                "collaboration_offerings": [
                    {
                        "collaboration_type": "Paid",
                        "availability_months": ["February"],
                        "platforms": ["TikTok"],
                        "paid_max_amount": 2000.00
                    }
                ]
            }
        )
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert len(data["collaboration_offerings"]) == 1
        assert data["collaboration_offerings"][0]["collaboration_type"] == "Paid"
        assert data["collaboration_offerings"][0]["paid_max_amount"] == 2000.0
    
    def test_update_listing_not_found(self, client, test_hotel_profile, hotel_auth_headers):
        """Test updating non-existent listing"""
        hotel_profile_id, user_id = test_hotel_profile
        fake_id = "00000000-0000-0000-0000-000000000000"
        
        response = client.put(
            f"/hotels/me/listings/{fake_id}",
            headers=hotel_auth_headers,
            json={
                "name": "Updated Name"
            }
        )
        assert response.status_code == status.HTTP_404_NOT_FOUND
    
    def test_delete_listing(self, client, test_hotel_profile, hotel_auth_headers):
        """Test deleting a listing"""
        hotel_profile_id, user_id = test_hotel_profile
        
        # Create listing first
        create_response = client.post(
            "/hotels/me/listings",
            headers=hotel_auth_headers,
            json={
                "name": "Villa to Delete",
                "location": "Test Location",
                "description": "A villa that will be deleted",
                "collaboration_offerings": [
                    {
                        "collaboration_type": "Free Stay",
                        "availability_months": ["January"],
                        "platforms": ["Instagram"],
                        "free_stay_min_nights": 2,
                        "free_stay_max_nights": 5
                    }
                ],
                "creator_requirements": {
                    "platforms": ["Instagram"],
                    "target_countries": ["USA"]
                }
            }
        )
        listing_id = create_response.json()["id"]
        
        # Delete listing
        response = client.delete(
            f"/hotels/me/listings/{listing_id}",
            headers=hotel_auth_headers
        )
        assert response.status_code == status.HTTP_204_NO_CONTENT
        
        # Verify it's deleted
        get_response = client.get(
            "/hotels/me",
            headers=hotel_auth_headers
        )
        listings = get_response.json()["listings"]
        assert len(listings) == 0
    
    def test_delete_listing_not_found(self, client, test_hotel_profile, hotel_auth_headers):
        """Test deleting non-existent listing"""
        hotel_profile_id, user_id = test_hotel_profile
        fake_id = "00000000-0000-0000-0000-000000000000"
        
        response = client.delete(
            f"/hotels/me/listings/{fake_id}",
            headers=hotel_auth_headers
        )
        assert response.status_code == status.HTTP_404_NOT_FOUND
    
    def test_unauthorized_access(self, client):
        """Test accessing hotel endpoints without authentication"""
        response = client.get("/hotels/me")
        assert response.status_code == status.HTTP_403_FORBIDDEN  # Missing Bearer token
    
    def test_wrong_user_type_access(self, client, test_creator_profile, auth_headers):
        """Test that creator users cannot access hotel endpoints"""
        creator_id, user_id = test_creator_profile
        
        response = client.get(
            "/hotels/me",
            headers=auth_headers
        )
        assert response.status_code == status.HTTP_403_FORBIDDEN
    
    def test_get_hotel_profile_with_listings(self, client, test_hotel_profile, hotel_auth_headers):
        """Test getting hotel profile with multiple listings"""
        hotel_profile_id, user_id = test_hotel_profile
        
        # Create multiple listings
        listing1_response = client.post(
            "/hotels/me/listings",
            headers=hotel_auth_headers,
            json={
                "name": "Villa 1",
                "location": "Location 1",
                "description": "Description for villa 1 that is long enough",
                "collaboration_offerings": [
                    {
                        "collaboration_type": "Free Stay",
                        "availability_months": ["January"],
                        "platforms": ["Instagram"],
                        "free_stay_min_nights": 2,
                        "free_stay_max_nights": 5
                    }
                ],
                "creator_requirements": {
                    "platforms": ["Instagram"],
                    "target_countries": ["USA"]
                }
            }
        )
        
        listing2_response = client.post(
            "/hotels/me/listings",
            headers=hotel_auth_headers,
            json={
                "name": "Villa 2",
                "location": "Location 2",
                "description": "Description for villa 2 that is long enough",
                "collaboration_offerings": [
                    {
                        "collaboration_type": "Paid",
                        "availability_months": ["February"],
                        "platforms": ["TikTok"],
                        "paid_max_amount": 1000.00
                    }
                ],
                "creator_requirements": {
                    "platforms": ["TikTok"],
                    "target_countries": ["Germany"]
                }
            }
        )
        
        # Get profile
        response = client.get(
            "/hotels/me",
            headers=hotel_auth_headers
        )
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert len(data["listings"]) == 2
        assert data["listings"][0]["name"] in ["Villa 1", "Villa 2"]
        assert data["listings"][1]["name"] in ["Villa 1", "Villa 2"]
    
    def test_upload_picture_structure(self, client, test_hotel_profile, hotel_auth_headers):
        """Test upload picture endpoint structure (returns placeholder)"""
        hotel_profile_id, user_id = test_hotel_profile
        
        # Create a simple image file for testing
        files = {
            "picture": ("test.jpg", b"fake image content", "image/jpeg")
        }
        
        response = client.post(
            "/hotels/me/upload-picture",
            headers=hotel_auth_headers,
            files=files
        )
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert "url" in data
        assert data["url"].startswith("https://example.com/uploads/")
    
    def test_upload_picture_invalid_file_type(self, client, test_hotel_profile, hotel_auth_headers):
        """Test upload picture with invalid file type"""
        hotel_profile_id, user_id = test_hotel_profile
        
        files = {
            "picture": ("test.txt", b"not an image", "text/plain")
        }
        
        response = client.post(
            "/hotels/me/upload-picture",
            headers=hotel_auth_headers,
            files=files
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
    
    def test_upload_listing_images_structure(self, client, test_hotel_profile, hotel_auth_headers):
        """Test upload listing images endpoint structure (returns placeholder)"""
        hotel_profile_id, user_id = test_hotel_profile
        
        # Create listing first
        create_response = client.post(
            "/hotels/me/listings",
            headers=hotel_auth_headers,
            json={
                "name": "Test Villa",
                "location": "Test Location",
                "description": "Description that is long enough for testing",
                "collaboration_offerings": [
                    {
                        "collaboration_type": "Free Stay",
                        "availability_months": ["January"],
                        "platforms": ["Instagram"],
                        "free_stay_min_nights": 2,
                        "free_stay_max_nights": 5
                    }
                ],
                "creator_requirements": {
                    "platforms": ["Instagram"],
                    "target_countries": ["USA"]
                }
            }
        )
        listing_id = create_response.json()["id"]
        
        # Upload images
        files = [
            ("images", ("image1.jpg", b"fake image 1", "image/jpeg")),
            ("images", ("image2.jpg", b"fake image 2", "image/jpeg"))
        ]
        
        response = client.post(
            f"/hotels/me/listings/{listing_id}/upload-images",
            headers=hotel_auth_headers,
            files=files
        )
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert "urls" in data
        assert len(data["urls"]) == 2
        assert all(url.startswith("https://example.com/uploads/") for url in data["urls"])

