"""
Tests for public /api/hotels/{slug}/rooms endpoint.
"""
import pytest
from tests.conftest import (
    create_test_user,
    create_test_hotel,
    create_test_room_type,
    create_test_booking,
    generate_test_slug,
)


class TestPublicRooms:
    async def test_get_rooms_by_slug(self, client, hotel_with_rooms):
        hotel = hotel_with_rooms["hotel"]
        resp = await client.get(f"/api/hotels/{hotel['slug']}/rooms")
        assert resp.status_code == 200
        rooms = resp.json()
        assert len(rooms) == 1
        assert rooms[0]["name"] == "Deluxe Suite"
        assert rooms[0]["remainingRooms"] == 5

    async def test_get_rooms_unknown_slug(self, client, init_database):
        resp = await client.get("/api/hotels/nonexistent-slug-xyz/rooms")
        assert resp.status_code == 200
        assert resp.json() == []

    async def test_inactive_rooms_hidden(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        await create_test_room_type(str(hotel["id"]), name="Active Room", is_active=True)
        await create_test_room_type(str(hotel["id"]), name="Inactive Room", is_active=False)

        resp = await client.get(f"/api/hotels/{hotel['slug']}/rooms")
        rooms = resp.json()
        assert len(rooms) == 1
        assert rooms[0]["name"] == "Active Room"

    async def test_rooms_with_availability(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]), total_rooms=3)

        # Create 2 bookings overlapping with the query dates
        await create_test_booking(
            str(hotel["id"]), str(room["id"]),
            check_in="2026-06-01", check_out="2026-06-05",
        )
        await create_test_booking(
            str(hotel["id"]), str(room["id"]),
            check_in="2026-06-03", check_out="2026-06-07",
            guest_email="guest2@example.com",
        )

        # Query with overlapping dates
        resp = await client.get(
            f"/api/hotels/{hotel['slug']}/rooms",
            params={"check_in": "2026-06-02", "check_out": "2026-06-04"},
        )
        rooms = resp.json()
        assert len(rooms) == 1
        assert rooms[0]["remainingRooms"] == 1  # 3 total - 2 booked

    async def test_rooms_no_dates_shows_total(self, client, hotel_with_rooms):
        """Without check_in/check_out, remainingRooms equals totalRooms."""
        hotel = hotel_with_rooms["hotel"]
        resp = await client.get(f"/api/hotels/{hotel['slug']}/rooms")
        rooms = resp.json()
        assert rooms[0]["remainingRooms"] == 5

    async def test_cancelled_bookings_dont_reduce_availability(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]), total_rooms=2)

        await create_test_booking(
            str(hotel["id"]), str(room["id"]),
            check_in="2026-06-01", check_out="2026-06-05",
            status="cancelled",
        )

        resp = await client.get(
            f"/api/hotels/{hotel['slug']}/rooms",
            params={"check_in": "2026-06-02", "check_out": "2026-06-04"},
        )
        rooms = resp.json()
        assert rooms[0]["remainingRooms"] == 2  # cancelled doesn't count

    async def test_rooms_response_shape(self, client, hotel_with_rooms):
        hotel = hotel_with_rooms["hotel"]
        resp = await client.get(f"/api/hotels/{hotel['slug']}/rooms")
        room = resp.json()[0]

        # Verify all expected guest-facing fields are present
        assert "id" in room
        assert "name" in room
        assert "description" in room
        assert "shortDescription" in room
        assert "maxOccupancy" in room
        assert "size" in room
        assert "baseRate" in room
        assert "nonRefundableRate" in room
        assert "currency" in room
        assert "amenities" in room
        assert "images" in room
        assert "bedType" in room
        assert "remainingRooms" in room
        assert "features" in room

        # Admin-only fields should NOT be present
        assert "hotelId" not in room
        assert "totalRooms" not in room
        assert "isActive" not in room
        assert "sortOrder" not in room

    async def test_rooms_with_non_refundable_rate(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        await create_test_room_type(str(hotel["id"]), name="NR Room", non_refundable_rate=120.0)

        resp = await client.get(f"/api/hotels/{hotel['slug']}/rooms")
        rooms = resp.json()
        assert len(rooms) == 1
        assert rooms[0]["nonRefundableRate"] == 120.0

    async def test_rooms_without_non_refundable_rate(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        await create_test_room_type(str(hotel["id"]), name="Flex Room")

        resp = await client.get(f"/api/hotels/{hotel['slug']}/rooms")
        rooms = resp.json()
        assert len(rooms) == 1
        # non_refundable_discount defaults to 10%, so NR rate = 150 * 0.9 = 135
        assert rooms[0]["nonRefundableRate"] == 135.0
