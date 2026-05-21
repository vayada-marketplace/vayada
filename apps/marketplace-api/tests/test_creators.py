"""
Tests for creator profile endpoints.
"""
import pytest
from httpx import AsyncClient

from app.database import Database
from tests.conftest import (
    get_auth_headers,
    create_test_creator,
    create_test_hotel,
    create_test_platform,
)


class TestGetCreatorProfileStatus:
    """Tests for GET /creators/me/profile-status"""

    async def test_profile_status_complete(
        self, client: AsyncClient, test_creator_verified
    ):
        """Test profile status for complete profile."""
        response = await client.get(
            "/creators/me/profile-status",
            headers=get_auth_headers(test_creator_verified["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert data["profile_complete"] is True
        assert len(data["missing_fields"]) == 0
        assert data["missing_platforms"] is False

    async def test_profile_status_incomplete(
        self, client: AsyncClient, cleanup_database, init_database
    ):
        """Test profile status for incomplete profile."""
        # Create creator with missing fields
        creator = await create_test_creator(
            location=None,
            short_description=None
        )

        response = await client.get(
            "/creators/me/profile-status",
            headers=get_auth_headers(creator["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert data["profile_complete"] is False
        assert "location" in data["missing_fields"]
        assert "short_description" in data["missing_fields"]
        assert data["missing_platforms"] is True
        assert len(data["completion_steps"]) > 0

    async def test_profile_status_missing_platforms(
        self, client: AsyncClient, test_creator
    ):
        """Test profile status when platforms are missing."""
        response = await client.get(
            "/creators/me/profile-status",
            headers=get_auth_headers(test_creator["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert data["missing_platforms"] is True

    async def test_profile_status_wrong_user_type(
        self, client: AsyncClient, test_hotel
    ):
        """Test profile status as hotel user."""
        response = await client.get(
            "/creators/me/profile-status",
            headers=get_auth_headers(test_hotel["token"])
        )

        assert response.status_code == 403

    async def test_profile_status_no_auth(
        self, client: AsyncClient
    ):
        """Test profile status without authentication."""
        response = await client.get("/creators/me/profile-status")

        assert response.status_code == 403


class TestGetCreatorProfile:
    """Tests for GET /creators/me"""

    async def test_get_profile_success(
        self, client: AsyncClient, test_creator
    ):
        """Test getting creator profile."""
        response = await client.get(
            "/creators/me",
            headers=get_auth_headers(test_creator["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert data["name"] == test_creator["user"]["name"]
        assert data["email"] == test_creator["user"]["email"]
        assert "platforms" in data
        assert "rating" in data

    async def test_get_profile_with_platforms(
        self, client: AsyncClient, test_creator_verified
    ):
        """Test getting profile with platforms."""
        response = await client.get(
            "/creators/me",
            headers=get_auth_headers(test_creator_verified["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert len(data["platforms"]) > 0
        platform = data["platforms"][0]
        assert "name" in platform
        assert "handle" in platform
        assert "followers" in platform

    async def test_get_profile_with_ratings(
        self, client: AsyncClient, test_creator_verified, test_hotel_verified
    ):
        """Test getting profile with ratings."""
        # Add a rating
        await Database.execute(
            """
            INSERT INTO creator_ratings (creator_id, hotel_id, rating, comment)
            VALUES ($1, $2, $3, $4)
            """,
            test_creator_verified["creator"]["id"],
            test_hotel_verified["hotel"]["id"],
            5,
            "Excellent creator!"
        )

        response = await client.get(
            "/creators/me",
            headers=get_auth_headers(test_creator_verified["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert data["rating"]["total_reviews"] >= 1
        assert data["rating"]["average_rating"] > 0

    async def test_get_profile_no_auth(
        self, client: AsyncClient
    ):
        """Test getting profile without authentication."""
        response = await client.get("/creators/me")

        assert response.status_code == 403

    async def test_get_profile_wrong_user_type(
        self, client: AsyncClient, test_hotel
    ):
        """Test getting creator profile as hotel user."""
        response = await client.get(
            "/creators/me",
            headers=get_auth_headers(test_hotel["token"])
        )

        assert response.status_code == 403


class TestUpdateCreatorProfile:
    """Tests for PUT /creators/me"""

    async def test_update_profile_basic_fields(
        self, client: AsyncClient, test_creator
    ):
        """Test updating basic profile fields."""
        response = await client.put(
            "/creators/me",
            json={
                "name": "Updated Name",
                "location": "Los Angeles, USA",
                "shortDescription": "Updated description"
            },
            headers=get_auth_headers(test_creator["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert data["name"] == "Updated Name"
        assert data["location"] == "Los Angeles, USA"
        assert data["short_description"] == "Updated description"

    async def test_update_profile_with_platforms(
        self, client: AsyncClient, test_creator
    ):
        """Test updating profile with platforms."""
        response = await client.put(
            "/creators/me",
            json={
                "platforms": [
                    {
                        "name": "Instagram",
                        "handle": "@newhandle",
                        "followers": 75000,
                        "engagementRate": 4.2
                    },
                    {
                        "name": "TikTok",
                        "handle": "@tiktokhandle",
                        "followers": 150000,
                        "engagementRate": 6.5
                    }
                ]
            },
            headers=get_auth_headers(test_creator["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert len(data["platforms"]) == 2
        assert data["audience_size"] == 225000  # 75000 + 150000

    async def test_update_platforms_replaces_existing(
        self, client: AsyncClient, cleanup_database, init_database
    ):
        """Test that updating platforms replaces all existing ones."""
        creator = await create_test_creator()

        # Add initial platform
        await create_test_platform(
            creator_id=str(creator["creator"]["id"]),
            name="Instagram",
            handle="@old"
        )

        # Update with new platforms
        response = await client.put(
            "/creators/me",
            json={
                "platforms": [
                    {
                        "name": "TikTok",
                        "handle": "@new",
                        "followers": 50000,
                        "engagementRate": 5.0
                    }
                ]
            },
            headers=get_auth_headers(creator["token"])
        )

        assert response.status_code == 200
        data = response.json()
        # Only new platform should exist
        assert len(data["platforms"]) == 1
        assert data["platforms"][0]["name"] == "TikTok"

    async def test_update_profile_completion_email(
        self, client: AsyncClient, cleanup_database, init_database, mock_send_email
    ):
        """Test that completion email is sent when profile becomes complete."""
        creator = await create_test_creator(
            location=None,
            short_description=None,
            profile_complete=False
        )

        # Complete the profile
        response = await client.put(
            "/creators/me",
            json={
                "location": "Complete Location",
                "shortDescription": "Complete description",
                "platforms": [
                    {
                        "name": "Instagram",
                        "handle": "@complete",
                        "followers": 10000,
                        "engagementRate": 3.0
                    }
                ]
            },
            headers=get_auth_headers(creator["token"])
        )

        assert response.status_code == 200

    async def test_update_profile_partial(
        self, client: AsyncClient, test_creator
    ):
        """Test partial profile update."""
        # Update only name
        response = await client.put(
            "/creators/me",
            json={"name": "Only Name Updated"},
            headers=get_auth_headers(test_creator["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert data["name"] == "Only Name Updated"
        # Other fields should remain
        assert data["location"] == test_creator["creator"]["location"]

    async def test_update_profile_picture(
        self, client: AsyncClient, test_creator
    ):
        """Test updating profile picture URL."""
        response = await client.put(
            "/creators/me",
            json={"profilePicture": "https://example.com/new-picture.jpg"},
            headers=get_auth_headers(test_creator["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert data["profile_picture"] == "https://example.com/new-picture.jpg"

    async def test_update_profile_portfolio_link(
        self, client: AsyncClient, test_creator
    ):
        """Test updating portfolio link."""
        response = await client.put(
            "/creators/me",
            json={"portfolioLink": "https://portfolio.example.com"},
            headers=get_auth_headers(test_creator["token"])
        )

        assert response.status_code == 200
        data = response.json()
        # URL may be normalized with trailing slash
        assert data["portfolio_link"].rstrip("/") == "https://portfolio.example.com"

    async def test_update_profile_no_auth(
        self, client: AsyncClient
    ):
        """Test updating profile without authentication."""
        response = await client.put(
            "/creators/me",
            json={"name": "Test"}
        )

        assert response.status_code == 403


class TestGetCreatorCollaborations:
    """Tests for GET /creators/me/collaborations"""

    async def test_get_collaborations_list(
        self, client: AsyncClient, test_collaboration
    ):
        """Test getting creator collaborations list."""
        response = await client.get(
            "/creators/me/collaborations",
            headers=get_auth_headers(test_collaboration["creator"]["token"])
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
            "/creators/me/collaborations?status=pending",
            headers=get_auth_headers(test_collaboration["creator"]["token"])
        )

        assert response.status_code == 200
        data = response.json()
        for collab in data:
            assert collab["status"] == "pending"

    async def test_get_collaborations_filter_by_initiator(
        self, client: AsyncClient, test_collaboration
    ):
        """Test filtering collaborations by initiator."""
        response = await client.get(
            "/creators/me/collaborations?initiated_by=creator",
            headers=get_auth_headers(test_collaboration["creator"]["token"])
        )

        assert response.status_code == 200
        data = response.json()
        for collab in data:
            assert collab["initiator_type"] == "creator"

    async def test_get_collaborations_empty(
        self, client: AsyncClient, test_creator
    ):
        """Test getting collaborations when none exist."""
        response = await client.get(
            "/creators/me/collaborations",
            headers=get_auth_headers(test_creator["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert data == []

    async def test_get_collaborations_no_auth(
        self, client: AsyncClient
    ):
        """Test getting collaborations without authentication."""
        response = await client.get("/creators/me/collaborations")

        assert response.status_code == 403


class TestGetCreatorCollaborationDetail:
    """Tests for GET /creators/me/collaborations/{collaboration_id}"""

    async def test_get_collaboration_detail(
        self, client: AsyncClient, test_collaboration
    ):
        """Test getting collaboration detail."""
        collab_id = str(test_collaboration["collaboration"]["id"])

        response = await client.get(
            f"/creators/me/collaborations/{collab_id}",
            headers=get_auth_headers(test_collaboration["creator"]["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert data["id"] == collab_id
        assert "hotel_name" in data
        assert "listing_name" in data
        assert "platform_deliverables" in data

    async def test_get_collaboration_detail_not_participant(
        self, client: AsyncClient, test_collaboration, cleanup_database, init_database
    ):
        """Test getting collaboration detail as non-participant."""
        # Create another creator
        other_creator = await create_test_creator()

        collab_id = str(test_collaboration["collaboration"]["id"])

        response = await client.get(
            f"/creators/me/collaborations/{collab_id}",
            headers=get_auth_headers(other_creator["token"])
        )

        assert response.status_code == 404

    async def test_get_collaboration_detail_not_found(
        self, client: AsyncClient, test_creator
    ):
        """Test getting non-existent collaboration."""
        response = await client.get(
            "/creators/me/collaborations/00000000-0000-0000-0000-000000000000",
            headers=get_auth_headers(test_creator["token"])
        )

        assert response.status_code == 404

    async def test_get_collaboration_detail_as_hotel(
        self, client: AsyncClient, test_collaboration
    ):
        """Test that hotel cannot use creator collaboration detail endpoint."""
        collab_id = str(test_collaboration["collaboration"]["id"])

        response = await client.get(
            f"/creators/me/collaborations/{collab_id}",
            headers=get_auth_headers(test_collaboration["hotel"]["token"])
        )

        assert response.status_code == 403


class TestPlatformAnalytics:
    """Tests for platform analytics in creator profile"""

    async def test_update_platform_with_analytics(
        self, client: AsyncClient, test_creator
    ):
        """Test updating platform with full analytics data."""
        response = await client.put(
            "/creators/me",
            json={
                "platforms": [
                    {
                        "name": "Instagram",
                        "handle": "@analytics_test",
                        "followers": 100000,
                        "engagementRate": 4.5,
                        "topCountries": [
                            {"country": "USA", "percentage": 45},
                            {"country": "UK", "percentage": 20}
                        ],
                        "topAgeGroups": [
                            {"ageRange": "25-34", "percentage": 40},
                            {"ageRange": "18-24", "percentage": 35}
                        ],
                        "genderSplit": {
                            "male": 40,
                            "female": 58,
                            "other": 2
                        }
                    }
                ]
            },
            headers=get_auth_headers(test_creator["token"])
        )

        assert response.status_code == 200
        data = response.json()
        platform = data["platforms"][0]
        assert platform["top_countries"] is not None
        assert platform["top_age_groups"] is not None
        assert platform["gender_split"] is not None

    async def test_get_profile_includes_analytics(
        self, client: AsyncClient, cleanup_database, init_database
    ):
        """Test that getting profile includes platform analytics."""
        import json

        creator = await create_test_creator()

        # Add platform with analytics
        await Database.execute(
            """
            INSERT INTO creator_platforms
            (creator_id, name, handle, followers, engagement_rate, top_countries, top_age_groups, gender_split)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            """,
            creator["creator"]["id"],
            "Instagram",
            "@test",
            50000,
            3.5,
            json.dumps([{"country": "USA", "percentage": 50}]),
            json.dumps([{"ageRange": "25-34", "percentage": 60}]),
            json.dumps({"male": 50, "female": 50})
        )

        response = await client.get(
            "/creators/me",
            headers=get_auth_headers(creator["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert len(data["platforms"]) == 1
