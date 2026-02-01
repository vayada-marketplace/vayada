"""
Tests for admin management endpoints.
"""
import pytest
from httpx import AsyncClient

from app.database import Database
from tests.conftest import (
    get_auth_headers,
    create_test_creator,
    create_test_hotel,
    create_test_admin,
    create_test_listing,
    create_test_platform,
    create_test_collaboration,
    generate_test_email,
)


class TestGetUsers:
    """Tests for GET /admin/users"""

    async def test_get_users_success(
        self, client: AsyncClient, test_admin, test_creator
    ):
        """Test getting users list."""
        response = await client.get(
            "/admin/users",
            headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert "users" in data
        assert "total" in data
        assert isinstance(data["users"], list)

    async def test_get_users_pagination(
        self, client: AsyncClient, test_admin, cleanup_database, init_database
    ):
        """Test pagination of users list."""
        # Create multiple users
        for i in range(5):
            await create_test_creator()

        response = await client.get(
            "/admin/users?page=1&page_size=3",
            headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert len(data["users"]) <= 3
        assert data["total"] >= 5

    async def test_get_users_filter_by_type(
        self, client: AsyncClient, test_admin, test_creator, test_hotel
    ):
        """Test filtering users by type."""
        response = await client.get(
            "/admin/users?type=creator",
            headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 200
        data = response.json()
        for user in data["users"]:
            assert user["type"] == "creator"

    async def test_get_users_filter_by_status(
        self, client: AsyncClient, test_admin, cleanup_database, init_database
    ):
        """Test filtering users by status."""
        await create_test_creator(status="verified")
        await create_test_creator(status="pending")

        response = await client.get(
            "/admin/users?status=verified",
            headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 200
        data = response.json()
        for user in data["users"]:
            assert user["status"] == "verified"

    async def test_get_users_search(
        self, client: AsyncClient, test_admin, cleanup_database, init_database
    ):
        """Test searching users by name or email."""
        await create_test_creator(name="Unique Name Creator")

        response = await client.get(
            "/admin/users?search=Unique Name",
            headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert any("Unique Name" in u["name"] for u in data["users"])

    async def test_get_users_not_admin(
        self, client: AsyncClient, test_creator
    ):
        """Test that non-admin cannot access users list."""
        response = await client.get(
            "/admin/users",
            headers=get_auth_headers(test_creator["token"])
        )

        assert response.status_code == 403

    async def test_get_users_no_auth(
        self, client: AsyncClient
    ):
        """Test that unauthenticated request is rejected."""
        response = await client.get("/admin/users")

        assert response.status_code == 403


class TestGetUserDetails:
    """Tests for GET /admin/users/{user_id}"""

    async def test_get_creator_details(
        self, client: AsyncClient, test_admin, test_creator_verified
    ):
        """Test getting creator user details."""
        user_id = str(test_creator_verified["user"]["id"])

        response = await client.get(
            f"/admin/users/{user_id}",
            headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert data["id"] == user_id
        assert data["type"] == "creator"
        assert "profile" in data
        assert data["profile"]["platforms"] is not None

    async def test_get_hotel_details(
        self, client: AsyncClient, test_admin, test_hotel_verified
    ):
        """Test getting hotel user details with listings."""
        user_id = str(test_hotel_verified["user"]["id"])

        response = await client.get(
            f"/admin/users/{user_id}",
            headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert data["id"] == user_id
        assert data["type"] == "hotel"
        assert "profile" in data
        assert "listings" in data["profile"]

    async def test_get_user_not_found(
        self, client: AsyncClient, test_admin
    ):
        """Test getting non-existent user."""
        response = await client.get(
            "/admin/users/00000000-0000-0000-0000-000000000000",
            headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 404


class TestCreateUser:
    """Tests for POST /admin/users"""

    async def test_create_creator(
        self, client: AsyncClient, test_admin
    ):
        """Test creating a creator user."""
        email = generate_test_email("admin_created")

        response = await client.post(
            "/admin/users",
            json={
                "email": email,
                "password": "SecurePassword123!",
                "name": "Admin Created Creator",
                "type": "creator",
                "status": "verified",
                "emailVerified": True,
                "creatorProfile": {
                    "location": "New York, USA",
                    "shortDescription": "Professional content creator"
                }
            },
            headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 201
        data = response.json()
        assert data["email"] == email
        assert data["type"] == "creator"
        assert data["status"] == "verified"

    async def test_create_hotel_with_listings(
        self, client: AsyncClient, test_admin
    ):
        """Test creating a hotel user with listings."""
        email = generate_test_email("admin_hotel")

        response = await client.post(
            "/admin/users",
            json={
                "email": email,
                "password": "SecurePassword123!",
                "name": "Admin Created Hotel",
                "type": "hotel",
                "status": "verified",
                "hotelProfile": {
                    "name": "Luxury Hotel",
                    "location": "Paris, France",
                    "about": "A beautiful hotel with amazing amenities",
                    "listings": [
                        {
                            "name": "Deluxe Suite",
                            "location": "Paris",
                            "description": "Luxury suite with stunning views of the Eiffel Tower",
                            "accommodationType": "Luxury Hotel",
                            "collaborationOfferings": [
                                {
                                    "collaborationType": "Free Stay",
                                    "availabilityMonths": ["January", "February"],
                                    "platforms": ["Instagram"],
                                    "freeStayMinNights": 3,
                                    "freeStayMaxNights": 5
                                }
                            ],
                            "creatorRequirements": {
                                "platforms": ["Instagram"],
                                "minFollowers": 10000
                            }
                        }
                    ]
                }
            },
            headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 201
        data = response.json()
        assert data["type"] == "hotel"

    async def test_create_user_duplicate_email(
        self, client: AsyncClient, test_admin, test_creator
    ):
        """Test creating user with duplicate email."""
        response = await client.post(
            "/admin/users",
            json={
                "email": test_creator["user"]["email"],
                "password": "SecurePassword123!",
                "name": "Duplicate User",
                "type": "creator"
            },
            headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 400
        assert "already registered" in response.json()["detail"].lower()

    async def test_create_user_with_platforms(
        self, client: AsyncClient, test_admin
    ):
        """Test creating creator with platforms."""
        email = generate_test_email("with_platforms")

        response = await client.post(
            "/admin/users",
            json={
                "email": email,
                "password": "SecurePassword123!",
                "name": "Creator With Platforms",
                "type": "creator",
                "creatorProfile": {
                    "location": "London",
                    "platforms": [
                        {
                            "name": "Instagram",
                            "handle": "@admintest",
                            "followers": 100000,
                            "engagementRate": 4.5
                        }
                    ]
                }
            },
            headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 201


class TestUpdateUser:
    """Tests for PUT /admin/users/{user_id}"""

    async def test_update_user_status(
        self, client: AsyncClient, test_admin, test_creator
    ):
        """Test updating user status."""
        user_id = str(test_creator["user"]["id"])

        response = await client.put(
            f"/admin/users/{user_id}",
            json={"status": "verified"},
            headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "verified"

    async def test_update_user_email(
        self, client: AsyncClient, test_admin, test_creator
    ):
        """Test updating user email."""
        user_id = str(test_creator["user"]["id"])
        new_email = generate_test_email("updated")

        response = await client.put(
            f"/admin/users/{user_id}",
            json={"email": new_email},
            headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert data["email"] == new_email

    async def test_update_user_not_found(
        self, client: AsyncClient, test_admin
    ):
        """Test updating non-existent user."""
        response = await client.put(
            "/admin/users/00000000-0000-0000-0000-000000000000",
            json={"name": "Test"},
            headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 404

    async def test_admin_cannot_modify_own_status(
        self, client: AsyncClient, test_admin
    ):
        """Test that admin cannot modify their own status."""
        admin_id = str(test_admin["user"]["id"])

        response = await client.put(
            f"/admin/users/{admin_id}",
            json={"status": "suspended"},
            headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 400


class TestDeleteUser:
    """Tests for DELETE /admin/users/{user_id}"""

    async def test_delete_user_success(
        self, client: AsyncClient, test_admin, cleanup_database, init_database, mock_s3_delete
    ):
        """Test deleting a user."""
        creator = await create_test_creator()
        user_id = str(creator["user"]["id"])

        response = await client.delete(
            f"/admin/users/{user_id}",
            headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert data["deleted_user"]["id"] == user_id

        # Verify user is deleted
        user = await Database.fetchrow(
            "SELECT id FROM users WHERE id = $1",
            creator["user"]["id"]
        )
        assert user is None

    async def test_delete_user_cascade(
        self, client: AsyncClient, test_admin, cleanup_database, init_database, mock_s3_delete
    ):
        """Test that deleting user cascades to profile."""
        creator = await create_test_creator()
        await create_test_platform(creator_id=str(creator["creator"]["id"]))
        user_id = str(creator["user"]["id"])

        response = await client.delete(
            f"/admin/users/{user_id}",
            headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 200

        # Verify related data is deleted
        creator_profile = await Database.fetchrow(
            "SELECT id FROM creators WHERE user_id = $1",
            creator["user"]["id"]
        )
        assert creator_profile is None

    async def test_delete_user_not_found(
        self, client: AsyncClient, test_admin
    ):
        """Test deleting non-existent user."""
        response = await client.delete(
            "/admin/users/00000000-0000-0000-0000-000000000000",
            headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 404

    async def test_admin_cannot_delete_self(
        self, client: AsyncClient, test_admin
    ):
        """Test that admin cannot delete themselves."""
        admin_id = str(test_admin["user"]["id"])

        response = await client.delete(
            f"/admin/users/{admin_id}",
            headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 400


class TestUpdateCreatorProfile:
    """Tests for PUT /admin/users/{user_id}/profile/creator"""

    async def test_update_creator_profile(
        self, client: AsyncClient, test_admin, test_creator
    ):
        """Test updating creator profile."""
        user_id = str(test_creator["user"]["id"])

        response = await client.put(
            f"/admin/users/{user_id}/profile/creator",
            json={
                "name": "Updated Creator Name",
                "location": "San Francisco, USA",
                "shortDescription": "Updated description"
            },
            headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert data["name"] == "Updated Creator Name"
        assert data["location"] == "San Francisco, USA"

    async def test_update_creator_with_platforms(
        self, client: AsyncClient, test_admin, test_creator
    ):
        """Test updating creator profile with platforms."""
        user_id = str(test_creator["user"]["id"])

        response = await client.put(
            f"/admin/users/{user_id}/profile/creator",
            json={
                "platforms": [
                    {
                        "name": "TikTok",
                        "handle": "@admin_updated",
                        "followers": 200000,
                        "engagementRate": 5.5
                    }
                ]
            },
            headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert len(data["platforms"]) == 1
        assert data["platforms"][0]["name"] == "TikTok"

    async def test_update_creator_wrong_type(
        self, client: AsyncClient, test_admin, test_hotel
    ):
        """Test updating creator profile for hotel user."""
        user_id = str(test_hotel["user"]["id"])

        response = await client.put(
            f"/admin/users/{user_id}/profile/creator",
            json={"name": "Test"},
            headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 400


class TestUpdateHotelProfile:
    """Tests for PUT /admin/users/{user_id}/profile/hotel"""

    async def test_update_hotel_profile(
        self, client: AsyncClient, test_admin, test_hotel
    ):
        """Test updating hotel profile."""
        user_id = str(test_hotel["user"]["id"])

        response = await client.put(
            f"/admin/users/{user_id}/profile/hotel",
            json={
                "name": "Updated Hotel Name",
                "location": "Barcelona, Spain",
                "about": "Updated description"
            },
            headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert data["name"] == "Updated Hotel Name"
        assert data["location"] == "Barcelona, Spain"

    async def test_update_hotel_wrong_type(
        self, client: AsyncClient, test_admin, test_creator
    ):
        """Test updating hotel profile for creator user."""
        user_id = str(test_creator["user"]["id"])

        response = await client.put(
            f"/admin/users/{user_id}/profile/hotel",
            json={"name": "Test"},
            headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 400


class TestAdminCreateListing:
    """Tests for POST /admin/users/{user_id}/listings"""

    async def test_create_listing(
        self, client: AsyncClient, test_admin, test_hotel
    ):
        """Test admin creating listing for hotel."""
        user_id = str(test_hotel["user"]["id"])

        response = await client.post(
            f"/admin/users/{user_id}/listings",
            json={
                "name": "Admin Created Listing",
                "location": "Dubai",
                "description": "Luxury listing with stunning desert views and amenities",
                "accommodationType": "Luxury Hotel",
                "collaborationOfferings": [
                    {
                        "collaborationType": "Free Stay",
                        "availabilityMonths": ["March", "April"],
                        "platforms": ["Instagram"],
                        "freeStayMinNights": 4,
                        "freeStayMaxNights": 7
                    }
                ],
                "creatorRequirements": {
                    "platforms": ["Instagram"],
                    "minFollowers": 50000
                }
            },
            headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 201
        data = response.json()
        assert data["name"] == "Admin Created Listing"

    async def test_create_listing_wrong_type(
        self, client: AsyncClient, test_admin, test_creator
    ):
        """Test creating listing for non-hotel user."""
        user_id = str(test_creator["user"]["id"])

        response = await client.post(
            f"/admin/users/{user_id}/listings",
            json={
                "name": "Test Listing",
                "location": "Test Location",
                "description": "Test description for the listing creation",
                "accommodationType": "Hotel",
                "collaborationOfferings": [
                    {
                        "collaborationType": "Free Stay",
                        "availabilityMonths": ["May"],
                        "platforms": ["Instagram"],
                        "freeStayMinNights": 2,
                        "freeStayMaxNights": 5
                    }
                ],
                "creatorRequirements": {"platforms": ["Instagram"], "minFollowers": 1000}
            },
            headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 400


class TestAdminUpdateListing:
    """Tests for PUT /admin/users/{user_id}/listings/{listing_id}"""

    async def test_update_listing(
        self, client: AsyncClient, test_admin, test_hotel_verified
    ):
        """Test admin updating listing."""
        user_id = str(test_hotel_verified["user"]["id"])
        listing_id = str(test_hotel_verified["listing"]["listing"]["id"])

        response = await client.put(
            f"/admin/users/{user_id}/listings/{listing_id}",
            json={
                "name": "Admin Updated Listing",
                "description": "Updated by admin"
            },
            headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert data["name"] == "Admin Updated Listing"

    async def test_update_listing_not_found(
        self, client: AsyncClient, test_admin, test_hotel
    ):
        """Test updating non-existent listing."""
        user_id = str(test_hotel["user"]["id"])

        response = await client.put(
            f"/admin/users/{user_id}/listings/00000000-0000-0000-0000-000000000000",
            json={"name": "Test"},
            headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 404


class TestAdminDeleteListing:
    """Tests for DELETE /admin/users/{user_id}/listings/{listing_id}"""

    async def test_delete_listing(
        self, client: AsyncClient, test_admin, test_hotel_verified, mock_s3_delete
    ):
        """Test admin deleting listing."""
        user_id = str(test_hotel_verified["user"]["id"])
        listing_id = str(test_hotel_verified["listing"]["listing"]["id"])

        response = await client.delete(
            f"/admin/users/{user_id}/listings/{listing_id}",
            headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert data["deleted_listing"]["id"] == listing_id

    async def test_delete_listing_not_found(
        self, client: AsyncClient, test_admin, test_hotel
    ):
        """Test deleting non-existent listing."""
        user_id = str(test_hotel["user"]["id"])

        response = await client.delete(
            f"/admin/users/{user_id}/listings/00000000-0000-0000-0000-000000000000",
            headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 404


class TestAdminGetCollaborations:
    """Tests for GET /admin/collaborations"""

    async def test_get_collaborations(
        self, client: AsyncClient, test_admin, test_collaboration
    ):
        """Test getting all collaborations."""
        response = await client.get(
            "/admin/collaborations",
            headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert "collaborations" in data
        assert "total" in data

    async def test_get_collaborations_pagination(
        self, client: AsyncClient, test_admin, test_collaboration
    ):
        """Test collaborations pagination."""
        response = await client.get(
            "/admin/collaborations?page=1&page_size=10",
            headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert len(data["collaborations"]) <= 10

    async def test_get_collaborations_filter_by_status(
        self, client: AsyncClient, test_admin, test_collaboration
    ):
        """Test filtering collaborations by status."""
        response = await client.get(
            "/admin/collaborations?status=pending",
            headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 200
        data = response.json()
        for collab in data["collaborations"]:
            assert collab["status"] == "pending"

    async def test_get_collaborations_search(
        self, client: AsyncClient, test_admin, test_collaboration
    ):
        """Test searching collaborations."""
        creator_name = test_collaboration["creator"]["user"]["name"]

        response = await client.get(
            f"/admin/collaborations?search={creator_name}",
            headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert len(data["collaborations"]) >= 1


class TestAdminAuthorization:
    """Tests for admin authorization"""

    async def test_creator_cannot_access_admin(
        self, client: AsyncClient, test_creator
    ):
        """Test that creator cannot access admin endpoints."""
        response = await client.get(
            "/admin/users",
            headers=get_auth_headers(test_creator["token"])
        )

        assert response.status_code == 403

    async def test_hotel_cannot_access_admin(
        self, client: AsyncClient, test_hotel
    ):
        """Test that hotel cannot access admin endpoints."""
        response = await client.get(
            "/admin/users",
            headers=get_auth_headers(test_hotel["token"])
        )

        assert response.status_code == 403

    async def test_suspended_admin_cannot_access(
        self, client: AsyncClient, cleanup_database, init_database
    ):
        """Test that suspended admin cannot access endpoints."""
        from tests.conftest import create_test_user
        from app.jwt_utils import create_access_token

        admin_user = await create_test_user(
            user_type="admin",
            status="suspended"
        )
        token = create_access_token({
            "sub": str(admin_user["id"]),
            "email": admin_user["email"],
            "type": "admin"
        })

        response = await client.get(
            "/admin/users",
            headers=get_auth_headers(token)
        )

        assert response.status_code == 403
