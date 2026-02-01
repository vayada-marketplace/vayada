"""
Tests for hotel profile and listing endpoints.
"""
import pytest
from httpx import AsyncClient
from io import BytesIO
from PIL import Image

from app.database import Database
from tests.conftest import (
    get_auth_headers,
    create_test_hotel,
    create_test_creator,
    create_test_listing,
    create_test_collaboration,
)


def create_test_image() -> bytes:
    """Create a test image."""
    img = Image.new("RGB", (100, 100), color="blue")
    buffer = BytesIO()
    img.save(buffer, format="JPEG")
    buffer.seek(0)
    return buffer.getvalue()


class TestGetHotelProfileStatus:
    """Tests for GET /hotels/me/profile-status"""

    async def test_profile_status_complete(
        self, client: AsyncClient, test_hotel_verified
    ):
        """Test profile status for complete hotel profile."""
        response = await client.get(
            "/hotels/me/profile-status",
            headers=get_auth_headers(test_hotel_verified["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert data["profile_complete"] is True
        assert len(data["missing_fields"]) == 0
        assert data["missing_listings"] is False

    async def test_profile_status_incomplete(
        self, client: AsyncClient, test_hotel
    ):
        """Test profile status for incomplete hotel profile."""
        response = await client.get(
            "/hotels/me/profile-status",
            headers=get_auth_headers(test_hotel["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert data["profile_complete"] is False
        assert data["missing_listings"] is True
        assert len(data["completion_steps"]) > 0

    async def test_profile_status_has_defaults(
        self, client: AsyncClient, cleanup_database, init_database
    ):
        """Test profile status with default location."""
        hotel = await create_test_hotel(location="Not specified")

        response = await client.get(
            "/hotels/me/profile-status",
            headers=get_auth_headers(hotel["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert data["has_defaults"]["location"] is True

    async def test_profile_status_wrong_user_type(
        self, client: AsyncClient, test_creator
    ):
        """Test profile status as creator user."""
        response = await client.get(
            "/hotels/me/profile-status",
            headers=get_auth_headers(test_creator["token"])
        )

        assert response.status_code == 403

    async def test_profile_status_no_auth(
        self, client: AsyncClient
    ):
        """Test profile status without authentication."""
        response = await client.get("/hotels/me/profile-status")

        assert response.status_code == 403


class TestGetHotelProfile:
    """Tests for GET /hotels/me"""

    async def test_get_profile_success(
        self, client: AsyncClient, test_hotel
    ):
        """Test getting hotel profile."""
        response = await client.get(
            "/hotels/me",
            headers=get_auth_headers(test_hotel["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert data["name"] == test_hotel["hotel"]["name"]
        assert data["email"] == test_hotel["user"]["email"]
        assert "listings" in data

    async def test_get_profile_with_listings(
        self, client: AsyncClient, test_hotel_verified
    ):
        """Test getting profile with listings."""
        response = await client.get(
            "/hotels/me",
            headers=get_auth_headers(test_hotel_verified["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert len(data["listings"]) > 0
        listing = data["listings"][0]
        assert "name" in listing
        assert "collaboration_offerings" in listing
        assert "creator_requirements" in listing

    async def test_get_profile_no_auth(
        self, client: AsyncClient
    ):
        """Test getting profile without authentication."""
        response = await client.get("/hotels/me")

        assert response.status_code == 403


class TestUpdateHotelProfile:
    """Tests for PUT /hotels/me"""

    async def test_update_profile_json(
        self, client: AsyncClient, test_hotel
    ):
        """Test updating profile with JSON body."""
        response = await client.put(
            "/hotels/me",
            json={
                "name": "Updated Hotel Name",
                "location": "Rome, Italy",
                "about": "A beautiful hotel in Rome"
            },
            headers=get_auth_headers(test_hotel["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert data["name"] == "Updated Hotel Name"
        assert data["location"] == "Rome, Italy"
        assert data["about"] == "A beautiful hotel in Rome"

    async def test_update_profile_multipart(
        self, client: AsyncClient, test_hotel, mock_s3_upload
    ):
        """Test updating profile with multipart form data including picture."""
        image_data = create_test_image()

        response = await client.put(
            "/hotels/me",
            data={
                "name": "Hotel with Picture",
                "location": "Barcelona, Spain"
            },
            files={"picture": ("hotel.jpg", image_data, "image/jpeg")},
            headers=get_auth_headers(test_hotel["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert data["name"] == "Hotel with Picture"
        assert data["picture"] is not None

    async def test_update_profile_completion_email(
        self, client: AsyncClient, cleanup_database, init_database, mock_send_email
    ):
        """Test that completion email is sent when profile becomes complete."""
        hotel = await create_test_hotel(
            about=None,
            profile_complete=False
        )

        # Add a listing to complete the profile
        await create_test_listing(hotel_profile_id=str(hotel["hotel"]["id"]))

        # Complete the profile
        response = await client.put(
            "/hotels/me",
            json={
                "about": "Complete description",
                "website": "https://hotel.example.com"
            },
            headers=get_auth_headers(hotel["token"])
        )

        assert response.status_code == 200

    async def test_update_profile_partial(
        self, client: AsyncClient, test_hotel
    ):
        """Test partial profile update."""
        response = await client.put(
            "/hotels/me",
            json={"phone": "+1234567890"},
            headers=get_auth_headers(test_hotel["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert data["phone"] == "+1234567890"
        # Other fields should remain unchanged
        assert data["name"] == test_hotel["hotel"]["name"]

    async def test_update_email(
        self, client: AsyncClient, test_hotel
    ):
        """Test updating email."""
        from tests.conftest import generate_test_email
        new_email = generate_test_email("newemail")

        response = await client.put(
            "/hotels/me",
            json={"email": new_email},
            headers=get_auth_headers(test_hotel["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert data["email"] == new_email


class TestCreateHotelListing:
    """Tests for POST /hotels/me/listings"""

    async def test_create_listing_success(
        self, client: AsyncClient, test_hotel
    ):
        """Test creating a listing."""
        response = await client.post(
            "/hotels/me/listings",
            json={
                "name": "Ocean View Suite",
                "location": "Maldives",
                "description": "Beautiful ocean view suite with panoramic views",
                "accommodationType": "Luxury Hotel",
                "images": ["https://example.com/image1.jpg"],
                "collaborationOfferings": [
                    {
                        "collaborationType": "Free Stay",
                        "availabilityMonths": ["January", "February", "March"],
                        "platforms": ["Instagram", "TikTok"],
                        "freeStayMinNights": 3,
                        "freeStayMaxNights": 7
                    }
                ],
                "creatorRequirements": {
                    "platforms": ["Instagram"],
                    "minFollowers": 10000,
                    "topCountries": ["USA", "UK"],
                    "targetAgeGroups": ["25-34"]
                }
            },
            headers=get_auth_headers(test_hotel["token"])
        )

        assert response.status_code == 201
        data = response.json()
        assert data["name"] == "Ocean View Suite"
        assert len(data["collaboration_offerings"]) == 1
        assert data["creator_requirements"] is not None

    async def test_create_listing_with_paid_offering(
        self, client: AsyncClient, test_hotel
    ):
        """Test creating listing with paid collaboration."""
        response = await client.post(
            "/hotels/me/listings",
            json={
                "name": "Paid Collaboration Suite",
                "location": "Paris, France",
                "description": "Luxury suite in the heart of Paris with stunning views",
                "accommodationType": "Luxury Hotel",
                "collaborationOfferings": [
                    {
                        "collaborationType": "Paid",
                        "availabilityMonths": ["April", "May", "June"],
                        "platforms": ["Instagram"],
                        "paidMaxAmount": 5000
                    }
                ],
                "creatorRequirements": {
                    "platforms": ["Instagram"],
                    "minFollowers": 50000
                }
            },
            headers=get_auth_headers(test_hotel["token"])
        )

        assert response.status_code == 201
        data = response.json()
        offering = data["collaboration_offerings"][0]
        assert offering["collaboration_type"] == "Paid"
        # paid_max_amount returned as string from decimal
        assert float(offering["paid_max_amount"]) == 5000

    async def test_create_listing_missing_fields(
        self, client: AsyncClient, test_hotel
    ):
        """Test creating listing with missing required fields."""
        response = await client.post(
            "/hotels/me/listings",
            json={
                "name": "Incomplete Listing"
                # Missing other required fields
            },
            headers=get_auth_headers(test_hotel["token"])
        )

        assert response.status_code == 422

    async def test_create_listing_wrong_user_type(
        self, client: AsyncClient, test_creator
    ):
        """Test creating listing as creator."""
        response = await client.post(
            "/hotels/me/listings",
            json={
                "name": "Test Listing",
                "location": "Test Location",
                "description": "Test description for this listing",
                "accommodationType": "Hotel",
                "collaborationOfferings": [
                    {
                        "collaborationType": "Free Stay",
                        "availabilityMonths": ["January"],
                        "platforms": ["Instagram"],
                        "freeStayMinNights": 2,
                        "freeStayMaxNights": 5
                    }
                ],
                "creatorRequirements": {"platforms": ["Instagram"], "minFollowers": 1000}
            },
            headers=get_auth_headers(test_creator["token"])
        )

        assert response.status_code == 403


class TestUpdateHotelListing:
    """Tests for PUT /hotels/me/listings/{listing_id}"""

    async def test_update_listing_success(
        self, client: AsyncClient, test_hotel_verified
    ):
        """Test updating a listing."""
        listing_id = str(test_hotel_verified["listing"]["listing"]["id"])

        response = await client.put(
            f"/hotels/me/listings/{listing_id}",
            json={
                "name": "Updated Listing Name",
                "description": "Updated description"
            },
            headers=get_auth_headers(test_hotel_verified["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert data["name"] == "Updated Listing Name"

    async def test_update_listing_offerings(
        self, client: AsyncClient, test_hotel_verified
    ):
        """Test updating listing collaboration offerings."""
        listing_id = str(test_hotel_verified["listing"]["listing"]["id"])

        response = await client.put(
            f"/hotels/me/listings/{listing_id}",
            json={
                "collaborationOfferings": [
                    {
                        "collaborationType": "Discount",
                        "availabilityMonths": ["July", "August"],
                        "platforms": ["Instagram"],
                        "discountPercentage": 50
                    }
                ]
            },
            headers=get_auth_headers(test_hotel_verified["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert len(data["collaboration_offerings"]) == 1
        assert data["collaboration_offerings"][0]["discount_percentage"] == 50

    async def test_update_listing_not_owner(
        self, client: AsyncClient, test_hotel_verified, cleanup_database, init_database
    ):
        """Test updating listing as different hotel."""
        other_hotel = await create_test_hotel()
        listing_id = str(test_hotel_verified["listing"]["listing"]["id"])

        response = await client.put(
            f"/hotels/me/listings/{listing_id}",
            json={"name": "Hacked Name"},
            headers=get_auth_headers(other_hotel["token"])
        )

        assert response.status_code == 404  # Not found because it doesn't belong to them

    async def test_update_listing_not_found(
        self, client: AsyncClient, test_hotel
    ):
        """Test updating non-existent listing."""
        response = await client.put(
            "/hotels/me/listings/00000000-0000-0000-0000-000000000000",
            json={"name": "Test"},
            headers=get_auth_headers(test_hotel["token"])
        )

        assert response.status_code == 404


class TestDeleteHotelListing:
    """Tests for DELETE /hotels/me/listings/{listing_id}"""

    async def test_delete_listing_success(
        self, client: AsyncClient, test_hotel_verified
    ):
        """Test deleting a listing."""
        listing_id = str(test_hotel_verified["listing"]["listing"]["id"])

        response = await client.delete(
            f"/hotels/me/listings/{listing_id}",
            headers=get_auth_headers(test_hotel_verified["token"])
        )

        assert response.status_code == 204

        # Verify listing is deleted
        listing = await Database.fetchrow(
            "SELECT id FROM hotel_listings WHERE id = $1",
            test_hotel_verified["listing"]["listing"]["id"]
        )
        assert listing is None

    async def test_delete_listing_not_found(
        self, client: AsyncClient, test_hotel
    ):
        """Test deleting non-existent listing."""
        response = await client.delete(
            "/hotels/me/listings/00000000-0000-0000-0000-000000000000",
            headers=get_auth_headers(test_hotel["token"])
        )

        assert response.status_code == 404

    async def test_delete_listing_not_owner(
        self, client: AsyncClient, test_hotel_verified, cleanup_database, init_database
    ):
        """Test deleting listing as different hotel."""
        other_hotel = await create_test_hotel()
        listing_id = str(test_hotel_verified["listing"]["listing"]["id"])

        response = await client.delete(
            f"/hotels/me/listings/{listing_id}",
            headers=get_auth_headers(other_hotel["token"])
        )

        assert response.status_code == 404


class TestGetHotelCollaborations:
    """Tests for GET /hotels/me/collaborations"""

    async def test_get_collaborations_list(
        self, client: AsyncClient, test_collaboration
    ):
        """Test getting hotel collaborations list."""
        response = await client.get(
            "/hotels/me/collaborations",
            headers=get_auth_headers(test_collaboration["hotel"]["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        assert len(data) >= 1

    async def test_get_collaborations_filter_by_status(
        self, client: AsyncClient, test_collaboration
    ):
        """Test filtering collaborations by status."""
        response = await client.get(
            "/hotels/me/collaborations?status=pending",
            headers=get_auth_headers(test_collaboration["hotel"]["token"])
        )

        assert response.status_code == 200
        data = response.json()
        for collab in data:
            assert collab["status"] == "pending"

    async def test_get_collaborations_filter_by_listing(
        self, client: AsyncClient, test_collaboration
    ):
        """Test filtering collaborations by listing."""
        listing_id = str(test_collaboration["hotel"]["listing"]["listing"]["id"])

        response = await client.get(
            f"/hotels/me/collaborations?listing_id={listing_id}",
            headers=get_auth_headers(test_collaboration["hotel"]["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)

    async def test_get_collaborations_filter_by_initiator(
        self, client: AsyncClient, test_collaboration
    ):
        """Test filtering collaborations by initiator."""
        response = await client.get(
            "/hotels/me/collaborations?initiated_by=creator",
            headers=get_auth_headers(test_collaboration["hotel"]["token"])
        )

        assert response.status_code == 200
        data = response.json()
        for collab in data:
            assert collab["initiator_type"] == "creator"

    async def test_get_collaborations_empty(
        self, client: AsyncClient, test_hotel
    ):
        """Test getting collaborations when none exist."""
        response = await client.get(
            "/hotels/me/collaborations",
            headers=get_auth_headers(test_hotel["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert data == []


class TestGetHotelCollaborationDetail:
    """Tests for GET /hotels/me/collaborations/{collaboration_id}"""

    async def test_get_collaboration_detail(
        self, client: AsyncClient, test_collaboration
    ):
        """Test getting collaboration detail."""
        collab_id = str(test_collaboration["collaboration"]["id"])

        response = await client.get(
            f"/hotels/me/collaborations/{collab_id}",
            headers=get_auth_headers(test_collaboration["hotel"]["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert data["id"] == collab_id
        assert "creator_name" in data
        assert "platforms" in data
        assert "platform_deliverables" in data

    async def test_get_collaboration_detail_not_participant(
        self, client: AsyncClient, test_collaboration, cleanup_database, init_database
    ):
        """Test getting collaboration detail as non-participant."""
        other_hotel = await create_test_hotel()

        collab_id = str(test_collaboration["collaboration"]["id"])

        response = await client.get(
            f"/hotels/me/collaborations/{collab_id}",
            headers=get_auth_headers(other_hotel["token"])
        )

        assert response.status_code == 404

    async def test_get_collaboration_detail_includes_creator_info(
        self, client: AsyncClient, test_collaboration
    ):
        """Test that collaboration detail includes creator information."""
        collab_id = str(test_collaboration["collaboration"]["id"])

        response = await client.get(
            f"/hotels/me/collaborations/{collab_id}",
            headers=get_auth_headers(test_collaboration["hotel"]["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert "total_followers" in data
        assert "avg_engagement_rate" in data
        assert "platforms" in data


class TestListingCollaborationOfferings:
    """Tests for listing collaboration offerings"""

    async def test_create_listing_multiple_offerings(
        self, client: AsyncClient, test_hotel
    ):
        """Test creating listing with multiple collaboration offerings."""
        response = await client.post(
            "/hotels/me/listings",
            json={
                "name": "Multi-Offering Suite",
                "location": "Dubai",
                "description": "Luxury suite with stunning views of the city skyline",
                "accommodationType": "Luxury Hotel",
                "collaborationOfferings": [
                    {
                        "collaborationType": "Free Stay",
                        "availabilityMonths": ["March", "April"],
                        "platforms": ["Instagram"],
                        "freeStayMinNights": 3,
                        "freeStayMaxNights": 5
                    },
                    {
                        "collaborationType": "Paid",
                        "availabilityMonths": ["May", "June"],
                        "platforms": ["TikTok"],
                        "paidMaxAmount": 2000
                    }
                ],
                "creatorRequirements": {
                    "platforms": ["Instagram", "TikTok"],
                    "minFollowers": 25000
                }
            },
            headers=get_auth_headers(test_hotel["token"])
        )

        assert response.status_code == 201
        data = response.json()
        assert len(data["collaboration_offerings"]) == 2

    async def test_create_listing_with_availability_months(
        self, client: AsyncClient, test_hotel
    ):
        """Test creating listing with availability months."""
        response = await client.post(
            "/hotels/me/listings",
            json={
                "name": "Seasonal Suite",
                "location": "Alps",
                "description": "Winter suite with breathtaking mountain views",
                "accommodationType": "Lodge",
                "collaborationOfferings": [
                    {
                        "collaborationType": "Free Stay",
                        "platforms": ["Instagram"],
                        "availabilityMonths": ["December", "January", "February"],
                        "freeStayMinNights": 5,
                        "freeStayMaxNights": 10
                    }
                ],
                "creatorRequirements": {
                    "platforms": ["Instagram"],
                    "minFollowers": 50000
                }
            },
            headers=get_auth_headers(test_hotel["token"])
        )

        assert response.status_code == 201
        data = response.json()
        offering = data["collaboration_offerings"][0]
        assert offering["availability_months"] == ["December", "January", "February"]


class TestCreatorRequirements:
    """Tests for listing creator requirements"""

    async def test_create_listing_with_age_requirements(
        self, client: AsyncClient, test_hotel
    ):
        """Test creating listing with age range requirements."""
        response = await client.post(
            "/hotels/me/listings",
            json={
                "name": "Youth Focused Hotel",
                "location": "Ibiza",
                "description": "Party destination with amazing nightlife and beach access",
                "accommodationType": "Hotel",
                "collaborationOfferings": [
                    {
                        "collaborationType": "Free Stay",
                        "availabilityMonths": ["July", "August"],
                        "platforms": ["TikTok"],
                        "freeStayMinNights": 2,
                        "freeStayMaxNights": 4
                    }
                ],
                "creatorRequirements": {
                    "platforms": ["TikTok"],
                    "minFollowers": 100000,
                    "targetAgeMin": 18,
                    "targetAgeMax": 30,
                    "targetAgeGroups": ["18-24", "25-34"]
                }
            },
            headers=get_auth_headers(test_hotel["token"])
        )

        assert response.status_code == 201
        data = response.json()
        reqs = data["creator_requirements"]
        assert reqs["target_age_min"] == 18
        assert reqs["target_age_max"] == 30
        assert "18-24" in reqs["target_age_groups"]
