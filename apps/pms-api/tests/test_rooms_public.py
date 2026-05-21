"""
Tests for public /api/hotels/{slug}/rooms endpoint.
"""

import json

import pytest
from app.database import Database

from tests.conftest import (
    create_test_booking,
    create_test_hotel,
    create_test_room_type,
    create_test_user,
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

    async def test_guest_mix_filters_room_occupancy_limits(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        await create_test_room_type(
            str(hotel["id"]),
            name="Family Room",
            max_occupancy=3,
            max_adults=2,
            max_children=1,
        )

        resp = await client.get(f"/api/hotels/{hotel['slug']}/rooms?adults=2&children=1")
        assert resp.status_code == 200
        assert [room["name"] for room in resp.json()] == ["Family Room"]
        assert resp.json()[0]["maxAdults"] == 2
        assert resp.json()[0]["maxChildren"] == 1

        too_many_adults = await client.get(f"/api/hotels/{hotel['slug']}/rooms?adults=3&children=0")
        assert too_many_adults.status_code == 200
        assert too_many_adults.json() == []

        too_many_children = await client.get(
            f"/api/hotels/{hotel['slug']}/rooms?adults=1&children=2"
        )
        assert too_many_children.status_code == 200
        assert too_many_children.json() == []

    async def test_unconfigured_adult_child_limits_fall_back_to_total_occupancy(
        self, client, cleanup_database
    ):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        await create_test_room_type(str(hotel["id"]), name="Legacy Room", max_occupancy=3)

        resp = await client.get(f"/api/hotels/{hotel['slug']}/rooms?adults=3&children=0")
        assert resp.status_code == 200
        assert [room["name"] for room in resp.json()] == ["Legacy Room"]

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
            str(hotel["id"]),
            str(room["id"]),
            check_in="2026-06-01",
            check_out="2026-06-05",
        )
        await create_test_booking(
            str(hotel["id"]),
            str(room["id"]),
            check_in="2026-06-03",
            check_out="2026-06-07",
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
            str(hotel["id"]),
            str(room["id"]),
            check_in="2026-06-01",
            check_out="2026-06-05",
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
        # base_rate=150, default discount=5% → NR rate = 150 * 0.95 = 142.5
        await create_test_room_type(
            str(hotel["id"]), name="NR Room", non_refundable_rate=120.0, non_refundable_enabled=True
        )

        resp = await client.get(f"/api/hotels/{hotel['slug']}/rooms")
        rooms = resp.json()
        assert len(rooms) == 1
        # When flexible is enabled, NR rate is calculated from discount (5% off base_rate=150)
        assert rooms[0]["nonRefundableRate"] == 142.5

    async def test_rooms_without_non_refundable_rate(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        await create_test_room_type(str(hotel["id"]), name="Flex Room")

        resp = await client.get(f"/api/hotels/{hotel['slug']}/rooms")
        rooms = resp.json()
        assert len(rooms) == 1
        # non_refundable_enabled defaults to False, so NR rate should be None
        assert rooms[0]["nonRefundableRate"] is None

    async def test_rate_payment_methods_exposed(self, client, cleanup_database):
        """rate_payment_methods JSONB column round-trips to the guest response."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        methods = {
            "flexible": ["card", "pay_at_property", "bank_transfer"],
            "nonrefundable": ["card", "bank_transfer"],
        }
        await Database.execute(
            "UPDATE room_types SET rate_payment_methods = $1::jsonb WHERE id = $2",
            json.dumps(methods),
            str(room["id"]),
        )

        resp = await client.get(f"/api/hotels/{hotel['slug']}/rooms")
        assert resp.status_code == 200
        rooms = resp.json()
        assert rooms[0]["ratePaymentMethods"] == methods

    async def test_rate_payment_methods_null_default(self, client, hotel_with_rooms):
        """Rooms without explicit per-rate methods return null (hotel-level fallback)."""
        hotel = hotel_with_rooms["hotel"]
        resp = await client.get(f"/api/hotels/{hotel['slug']}/rooms")
        assert resp.status_code == 200
        assert resp.json()[0]["ratePaymentMethods"] is None
