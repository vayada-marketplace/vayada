"""
Tests for public marketplace endpoints.
"""
import pytest
from httpx import AsyncClient
import json

from app.database import Database
from tests.conftest import (
    create_test_creator,
    create_test_hotel,
    create_test_listing,
    create_test_platform,
)


class TestGetMarketplaceListings:
    """Tests for GET /marketplace/listings"""

    async def test_get_listings_success(
        self, client: AsyncClient, test_hotel_verified
    ):
        """Test getting marketplace listings."""
        response = await client.get("/marketplace/listings")

        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)

    async def test_listings_only_verified_hotels(
        self, client: AsyncClient, cleanup_database, init_database
    ):
        """Test that only verified hotels' listings appear."""
        # Create unverified hotel with listing
        unverified_hotel = await create_test_hotel(status="pending", profile_complete=True)
        await create_test_listing(hotel_profile_id=str(unverified_hotel["hotel"]["id"]))

        # Create verified hotel with listing
        verified_hotel = await create_test_hotel(status="verified", profile_complete=True)
        await create_test_listing(
            hotel_profile_id=str(verified_hotel["hotel"]["id"]),
            name="Verified Hotel Listing"
        )

        response = await client.get("/marketplace/listings")

        assert response.status_code == 200
        data = response.json()

        # Only verified hotel listings should appear
        listing_names = [l["name"] for l in data]
        assert "Verified Hotel Listing" in listing_names

    async def test_listings_only_complete_profiles(
        self, client: AsyncClient, cleanup_database, init_database
    ):
        """Test that only listings from complete profiles appear."""
        # Create hotel with incomplete profile (no website - trigger sets profile_complete=false)
        incomplete_hotel = await create_test_hotel(
            status="verified",
            profile_complete=False,
            website=""  # Empty website means profile is incomplete
        )
        await create_test_listing(
            hotel_profile_id=str(incomplete_hotel["hotel"]["id"]),
            name="Incomplete Profile Listing"
        )

        # Create hotel with complete profile (all fields set)
        complete_hotel = await create_test_hotel(
            status="verified",
            profile_complete=True,
            website="https://complete-hotel.com"
        )
        await create_test_listing(
            hotel_profile_id=str(complete_hotel["hotel"]["id"]),
            name="Complete Profile Listing"
        )

        response = await client.get("/marketplace/listings")

        assert response.status_code == 200
        data = response.json()

        listing_names = [l["name"] for l in data]
        assert "Complete Profile Listing" in listing_names
        assert "Incomplete Profile Listing" not in listing_names

    async def test_listings_include_hotel_info(
        self, client: AsyncClient, test_hotel_verified
    ):
        """Test that listings include hotel information."""
        response = await client.get("/marketplace/listings")

        assert response.status_code == 200
        data = response.json()

        if len(data) > 0:
            listing = data[0]
            assert "hotel_name" in listing
            assert "hotel_profile_id" in listing
            assert "hotel_picture" in listing

    async def test_listings_include_offerings(
        self, client: AsyncClient, test_hotel_verified
    ):
        """Test that listings include collaboration offerings."""
        response = await client.get("/marketplace/listings")

        assert response.status_code == 200
        data = response.json()

        if len(data) > 0:
            listing = data[0]
            assert "collaboration_offerings" in listing
            assert isinstance(listing["collaboration_offerings"], list)

    async def test_listings_include_requirements(
        self, client: AsyncClient, test_hotel_verified
    ):
        """Test that listings include creator requirements."""
        response = await client.get("/marketplace/listings")

        assert response.status_code == 200
        data = response.json()

        if len(data) > 0:
            listing = data[0]
            assert "creator_requirements" in listing

    async def test_listings_exclude_unverified_hotels(
        self, client: AsyncClient, cleanup_database, init_database
    ):
        """Test that listings from unverified hotels are excluded."""
        # Create an unverified hotel with a listing
        unverified_hotel = await create_test_hotel(status="pending", profile_complete=True)
        unverified_listing = await create_test_listing(hotel_profile_id=str(unverified_hotel["hotel"]["id"]))

        response = await client.get("/marketplace/listings")

        assert response.status_code == 200
        data = response.json()
        # Verify the unverified hotel's listing is NOT in the results
        listing_ids = [listing["id"] for listing in data]
        assert str(unverified_listing["listing"]["id"]) not in listing_ids

    async def test_listings_public_no_auth_required(
        self, client: AsyncClient
    ):
        """Test that marketplace listings are public."""
        response = await client.get("/marketplace/listings")

        assert response.status_code == 200


class TestGetMarketplaceCreators:
    """Tests for GET /marketplace/creators"""

    async def test_get_creators_success(
        self, client: AsyncClient, test_creator_verified
    ):
        """Test getting marketplace creators."""
        response = await client.get("/marketplace/creators")

        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)

    async def test_creators_only_verified(
        self, client: AsyncClient, cleanup_database, init_database
    ):
        """Test that only verified creators appear."""
        # Create unverified creator
        unverified = await create_test_creator(
            name="Unverified Creator",
            status="pending",
            profile_complete=True
        )
        await create_test_platform(
            creator_id=str(unverified["creator"]["id"]),
            name="Instagram",
            handle="@unverified"
        )

        # Create verified creator
        verified = await create_test_creator(
            name="Verified Creator",
            status="verified",
            profile_complete=True
        )
        await create_test_platform(
            creator_id=str(verified["creator"]["id"]),
            name="Instagram",
            handle="@verified"
        )

        response = await client.get("/marketplace/creators")

        assert response.status_code == 200
        data = response.json()

        creator_names = [c["name"] for c in data]
        assert "Verified Creator" in creator_names
        assert "Unverified Creator" not in creator_names

    async def test_creators_only_complete_profiles(
        self, client: AsyncClient, cleanup_database, init_database
    ):
        """Test that only creators with complete profiles appear."""
        # Create creator with incomplete profile
        incomplete = await create_test_creator(
            name="Incomplete Creator",
            status="verified",
            profile_complete=False
        )

        # Create creator with complete profile
        complete = await create_test_creator(
            name="Complete Creator",
            status="verified",
            profile_complete=True
        )
        await create_test_platform(
            creator_id=str(complete["creator"]["id"]),
            name="Instagram",
            handle="@complete"
        )

        response = await client.get("/marketplace/creators")

        assert response.status_code == 200
        data = response.json()

        creator_names = [c["name"] for c in data]
        assert "Complete Creator" in creator_names
        assert "Incomplete Creator" not in creator_names

    async def test_creators_include_audience_size(
        self, client: AsyncClient, test_creator_verified
    ):
        """Test that creators include calculated audience size."""
        response = await client.get("/marketplace/creators")

        assert response.status_code == 200
        data = response.json()

        if len(data) > 0:
            creator = data[0]
            assert "audience_size" in creator
            assert isinstance(creator["audience_size"], int)

    async def test_creators_audience_size_calculation(
        self, client: AsyncClient, cleanup_database, init_database
    ):
        """Test that audience size is sum of all platform followers."""
        creator = await create_test_creator(
            status="verified",
            profile_complete=True
        )

        # Add multiple platforms
        await create_test_platform(
            creator_id=str(creator["creator"]["id"]),
            name="Instagram",
            handle="@multi1",
            followers=50000
        )
        await create_test_platform(
            creator_id=str(creator["creator"]["id"]),
            name="TikTok",
            handle="@multi2",
            followers=100000
        )

        response = await client.get("/marketplace/creators")

        assert response.status_code == 200
        data = response.json()

        creator_data = [c for c in data if c["name"] == creator["user"]["name"]]
        if creator_data:
            assert creator_data[0]["audience_size"] == 150000

    async def test_creators_include_platforms(
        self, client: AsyncClient, test_creator_verified
    ):
        """Test that creators include platform information."""
        response = await client.get("/marketplace/creators")

        assert response.status_code == 200
        data = response.json()

        if len(data) > 0:
            creator = data[0]
            assert "platforms" in creator
            assert isinstance(creator["platforms"], list)

    async def test_creators_include_ratings(
        self, client: AsyncClient, test_creator_verified, test_hotel_verified
    ):
        """Test that creators include rating information."""
        # Add a rating
        await Database.execute(
            """
            INSERT INTO creator_ratings (creator_id, hotel_id, rating, comment)
            VALUES ($1, $2, $3, $4)
            """,
            test_creator_verified["creator"]["id"],
            test_hotel_verified["hotel"]["id"],
            4.5,
            "Great creator!"
        )

        response = await client.get("/marketplace/creators")

        assert response.status_code == 200
        data = response.json()

        if len(data) > 0:
            creator = data[0]
            assert "average_rating" in creator
            assert "total_reviews" in creator

    async def test_creators_public_no_auth_required(
        self, client: AsyncClient
    ):
        """Test that marketplace creators are public."""
        response = await client.get("/marketplace/creators")

        assert response.status_code == 200


class TestMarketplacePlatformAnalytics:
    """Tests for platform analytics in marketplace"""

    async def test_creators_include_platform_demographics(
        self, client: AsyncClient, cleanup_database, init_database
    ):
        """Test that marketplace creators include platform demographics."""
        creator = await create_test_creator(
            status="verified",
            profile_complete=True
        )

        # Add platform with analytics
        await Database.execute(
            """
            INSERT INTO creator_platforms
            (creator_id, name, handle, followers, engagement_rate, top_countries, top_age_groups, gender_split)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            """,
            creator["creator"]["id"],
            "Instagram",
            "@analytics",
            100000,
            4.5,
            json.dumps({"USA": 45, "UK": 20}),
            json.dumps({"25-34": 40, "35-44": 30}),
            json.dumps({"male": 40, "female": 58, "other": 2})
        )

        response = await client.get("/marketplace/creators")

        assert response.status_code == 200
        data = response.json()

        creator_data = [c for c in data if c["name"] == creator["user"]["name"]]
        if creator_data and len(creator_data[0]["platforms"]) > 0:
            platform = creator_data[0]["platforms"][0]
            assert "top_countries" in platform
            assert "top_age_groups" in platform
            assert "gender_split" in platform


class TestMarketplaceListingDetails:
    """Tests for listing details in marketplace"""

    async def test_listing_includes_images(
        self, client: AsyncClient, cleanup_database, init_database
    ):
        """Test that listings include images."""
        hotel = await create_test_hotel(status="verified", profile_complete=True)
        await create_test_listing(
            hotel_profile_id=str(hotel["hotel"]["id"]),
            images=["https://example.com/img1.jpg", "https://example.com/img2.jpg"]
        )

        response = await client.get("/marketplace/listings")

        assert response.status_code == 200
        data = response.json()

        if len(data) > 0:
            listing = data[0]
            assert "images" in listing
            assert isinstance(listing["images"], list)

    async def test_listing_includes_accommodation_type(
        self, client: AsyncClient, test_hotel_verified
    ):
        """Test that listings include accommodation type."""
        response = await client.get("/marketplace/listings")

        assert response.status_code == 200
        data = response.json()

        if len(data) > 0:
            listing = data[0]
            assert "accommodation_type" in listing

    async def test_listing_includes_location(
        self, client: AsyncClient, test_hotel_verified
    ):
        """Test that listings include location."""
        response = await client.get("/marketplace/listings")

        assert response.status_code == 200
        data = response.json()

        if len(data) > 0:
            listing = data[0]
            assert "location" in listing


class TestMarketplaceOrdering:
    """Tests for marketplace result ordering"""

    async def test_listings_ordered_by_created_at(
        self, client: AsyncClient, cleanup_database, init_database
    ):
        """Test that listings are ordered by creation date (newest first)."""
        hotel = await create_test_hotel(status="verified", profile_complete=True)

        # Create listings in order
        await create_test_listing(
            hotel_profile_id=str(hotel["hotel"]["id"]),
            name="First Listing"
        )
        await create_test_listing(
            hotel_profile_id=str(hotel["hotel"]["id"]),
            name="Second Listing"
        )

        response = await client.get("/marketplace/listings")

        assert response.status_code == 200
        data = response.json()

        # Newest should be first
        if len(data) >= 2:
            assert data[0]["name"] == "Second Listing"
            assert data[1]["name"] == "First Listing"

    async def test_creators_ordered_by_created_at(
        self, client: AsyncClient, cleanup_database, init_database
    ):
        """Test that creators are ordered by creation date (newest first)."""
        # Create creators in order
        first = await create_test_creator(
            name="First Creator",
            status="verified",
            profile_complete=True
        )
        await create_test_platform(creator_id=str(first["creator"]["id"]))

        second = await create_test_creator(
            name="Second Creator",
            status="verified",
            profile_complete=True
        )
        await create_test_platform(creator_id=str(second["creator"]["id"]))

        response = await client.get("/marketplace/creators")

        assert response.status_code == 200
        data = response.json()

        # Newest should be first
        if len(data) >= 2:
            assert data[0]["name"] == "Second Creator"
            assert data[1]["name"] == "First Creator"
