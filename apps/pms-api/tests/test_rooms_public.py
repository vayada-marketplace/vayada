"""
Tests for public /api/hotels/{slug}/rooms endpoint.
"""

import json
from datetime import date, timedelta

import pytest
from app.database import Database

from tests.conftest import (
    create_test_booking,
    create_test_hotel,
    create_test_room,
    create_test_room_block,
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
        # total_rooms=1 isolates the per-unit occupancy check; multi-room
        # behavior is covered separately in TestMultiRoomCapacity (VAY-492).
        await create_test_room_type(
            str(hotel["id"]),
            name="Family Room",
            max_occupancy=3,
            max_adults=2,
            max_children=1,
            total_rooms=1,
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
        await create_test_room_type(
            str(hotel["id"]), name="Legacy Room", max_occupancy=3, total_rooms=1
        )

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

    async def test_rooms_with_staggered_booking_and_block_keep_inventory(
        self, client, cleanup_database
    ):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]), total_rooms=2)

        await create_test_booking(
            str(hotel["id"]),
            str(room["id"]),
            check_in="2026-06-01",
            check_out="2026-06-02",
        )
        await create_test_room_block(
            str(hotel["id"]),
            str(room["id"]),
            start_date="2026-06-02",
            end_date="2026-06-03",
        )

        resp = await client.get(
            f"/api/hotels/{hotel['slug']}/rooms",
            params={"check_in": "2026-06-01", "check_out": "2026-06-03"},
        )

        assert resp.status_code == 200
        rooms = resp.json()
        assert len(rooms) == 1
        assert rooms[0]["remainingRooms"] == 1

    async def test_checkout_date_does_not_require_availability(self, client, cleanup_database):
        base_date = date.today()
        check_in = (base_date + timedelta(days=30)).isoformat()
        sold_out_date = (base_date + timedelta(days=31)).isoformat()
        check_out = (base_date + timedelta(days=32)).isoformat()
        search_end = (base_date + timedelta(days=33)).isoformat()
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]), total_rooms=1)
        unit = await create_test_room(str(hotel["id"]), str(room["id"]), room_number="101")
        sold_out_night = await create_test_booking(
            str(hotel["id"]),
            str(room["id"]),
            check_in=sold_out_date,
            check_out=check_out,
        )
        await Database.execute(
            "UPDATE bookings SET room_id = $1 WHERE id = $2",
            str(unit["id"]),
            str(sold_out_night["id"]),
        )

        unavailable = await client.get(
            f"/api/hotels/{hotel['slug']}/unavailable-dates",
            params={"start": check_in, "end": search_end},
        )
        assert unavailable.status_code == 200
        assert unavailable.json()["dates"] == [sold_out_date]

        one_night = await client.get(
            f"/api/hotels/{hotel['slug']}/rooms",
            params={"check_in": check_in, "check_out": sold_out_date},
        )
        assert one_night.status_code == 200
        assert one_night.json()[0]["remainingRooms"] == 1

        crosses_sold_out_night = await client.get(
            f"/api/hotels/{hotel['slug']}/rooms",
            params={"check_in": check_in, "check_out": check_out},
        )
        assert crosses_sold_out_night.status_code == 200
        assert crosses_sold_out_night.json()[0]["remainingRooms"] == 0

    async def test_remaining_rooms_requires_same_physical_unit_for_whole_stay(
        self, client, cleanup_database
    ):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]), total_rooms=2)
        first_unit = await create_test_room(str(hotel["id"]), str(room["id"]), room_number="101")
        second_unit = await create_test_room(str(hotel["id"]), str(room["id"]), room_number="102")
        first_night = await create_test_booking(
            str(hotel["id"]),
            str(room["id"]),
            check_in="2026-06-06",
            check_out="2026-06-07",
        )
        second_night = await create_test_booking(
            str(hotel["id"]),
            str(room["id"]),
            check_in="2026-06-07",
            check_out="2026-06-08",
            guest_email="second@example.com",
        )
        await Database.execute(
            "UPDATE hotels SET auto_rearrange_enabled = FALSE WHERE id = $1",
            hotel["id"],
        )
        await Database.execute(
            "UPDATE bookings SET room_id = $1 WHERE id = $2",
            str(first_unit["id"]),
            str(first_night["id"]),
        )
        await Database.execute(
            "UPDATE bookings SET room_id = $1 WHERE id = $2",
            str(second_unit["id"]),
            str(second_night["id"]),
        )

        resp = await client.get(
            f"/api/hotels/{hotel['slug']}/rooms",
            params={"check_in": "2026-06-06", "check_out": "2026-06-08"},
        )

        assert resp.status_code == 200
        assert resp.json()[0]["remainingRooms"] == 0

    async def test_unassigned_bookings_still_consume_physical_inventory(
        self, client, cleanup_database
    ):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]), total_rooms=1)
        await create_test_room(str(hotel["id"]), str(room["id"]), room_number="101")
        await create_test_booking(
            str(hotel["id"]),
            str(room["id"]),
            check_in="2026-06-06",
            check_out="2026-06-07",
        )

        resp = await client.get(
            f"/api/hotels/{hotel['slug']}/rooms",
            params={"check_in": "2026-06-06", "check_out": "2026-06-07"},
        )

        assert resp.status_code == 200
        assert resp.json()[0]["remainingRooms"] == 0

    async def test_abstract_inventory_caps_but_does_not_consume_direct_fit(
        self, client, cleanup_database
    ):
        base_date = date.today()
        check_in = (base_date + timedelta(days=30)).isoformat()
        blocked_date = (base_date + timedelta(days=31)).isoformat()
        check_out = (base_date + timedelta(days=32)).isoformat()
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]), total_rooms=2)
        first_unit = await create_test_room(str(hotel["id"]), str(room["id"]), room_number="101")
        await create_test_room(str(hotel["id"]), str(room["id"]), room_number="102")
        first_night = await create_test_booking(
            str(hotel["id"]),
            str(room["id"]),
            check_in=check_in,
            check_out=blocked_date,
        )
        await Database.execute(
            "UPDATE bookings SET room_id = $1 WHERE id = $2",
            str(first_unit["id"]),
            str(first_night["id"]),
        )
        await create_test_room_block(
            str(hotel["id"]),
            str(room["id"]),
            start_date=blocked_date,
            end_date=check_out,
            blocked_count=1,
        )

        resp = await client.get(
            f"/api/hotels/{hotel['slug']}/rooms",
            params={"check_in": check_in, "check_out": check_out},
        )

        assert resp.status_code == 200
        assert resp.json()[0]["remainingRooms"] == 1

    async def test_rooms_over_max_stay_show_zero_remaining(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]), total_rooms=3)
        seasons = [
            {
                "name": "All year",
                "tier": "Mid",
                "from": "01-01",
                "to": "12-31",
                "rate": "150",
                "minStay": 1,
                "maxStay": 3,
            }
        ]
        await Database.execute(
            "UPDATE room_types SET seasons = $1::jsonb WHERE id = $2",
            json.dumps(seasons),
            room["id"],
        )

        resp = await client.get(
            f"/api/hotels/{hotel['slug']}/rooms",
            params={"check_in": "2026-06-01", "check_out": "2026-06-06"},
        )
        assert resp.status_code == 200
        rooms = resp.json()
        assert rooms[0]["remainingRooms"] == 0

    async def test_rooms_quote_uses_per_night_rates_across_season_boundary(
        self, client, cleanup_database
    ):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(
            str(hotel["id"]),
            base_rate=0,
            total_rooms=3,
            non_refundable_enabled=True,
        )
        seasons = [
            {
                "name": "July",
                "tier": "High",
                "from": "07-01",
                "to": "07-31",
                "rate": "4800000",
            },
            {
                "name": "Peak",
                "tier": "Peak",
                "from": "08-01",
                "to": "08-31",
                "rate": "6100000",
            },
        ]
        await Database.execute(
            "UPDATE room_types SET seasons = $1::jsonb, currency = 'IDR', "
            "non_refundable_discount = 5 WHERE id = $2",
            json.dumps(seasons),
            room["id"],
        )

        resp = await client.get(
            f"/api/hotels/{hotel['slug']}/rooms",
            params={"check_in": "2026-07-29", "check_out": "2026-08-03", "adults": 2},
        )

        assert resp.status_code == 200
        quoted = resp.json()[0]
        assert quoted["nightlyRates"] == [4800000, 4800000, 4800000, 6100000, 6100000]
        assert quoted["baseRate"] == 5320000
        assert quoted["nonRefundableNightlyRates"] == [
            4560000,
            4560000,
            4560000,
            5795000,
            5795000,
        ]
        assert quoted["nonRefundableRate"] == 5054000

    async def test_unavailable_dates_includes_max_stay_by_arrival(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]), total_rooms=3)
        seasons = [
            {
                "name": "All year",
                "tier": "Mid",
                "from": "01-01",
                "to": "12-31",
                "rate": "150",
                "minStay": 1,
                "maxStay": 3,
            }
        ]
        await Database.execute(
            "UPDATE room_types SET seasons = $1::jsonb WHERE id = $2",
            json.dumps(seasons),
            room["id"],
        )

        resp = await client.get(
            f"/api/hotels/{hotel['slug']}/unavailable-dates",
            params={"start": "2026-06-01", "end": "2026-06-03"},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["max_stay_by_arrival"]["2026-06-01"] == 3

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


class TestMultiRoomCapacity:
    """VAY-492: a room type should surface when its combined inventory can
    fit a party, even if a single unit cannot. Frontend computes
    ``ceil(totalGuests / maxOccupancy)`` and renders "Select N villas" —
    the backend's job is to not pre-filter the room type away."""

    async def test_party_exceeds_one_unit_but_fits_two(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        await create_test_room_type(
            str(hotel["id"]), name="Two-Bedroom Pool Villa", max_occupancy=4, total_rooms=2
        )

        resp = await client.get(f"/api/hotels/{hotel['slug']}/rooms?adults=6&children=0")
        assert resp.status_code == 200
        rooms = resp.json()
        assert [r["name"] for r in rooms] == ["Two-Bedroom Pool Villa"]

    async def test_party_exceeds_combined_capacity(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        await create_test_room_type(
            str(hotel["id"]), name="Two-Bedroom Pool Villa", max_occupancy=4, total_rooms=2
        )

        # 9 > 4 * 2 — combined capacity insufficient
        resp = await client.get(f"/api/hotels/{hotel['slug']}/rooms?adults=9&children=0")
        assert resp.status_code == 200
        assert resp.json() == []

    async def test_single_unit_inventory_does_not_combine(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        await create_test_room_type(
            str(hotel["id"]), name="Solo Villa", max_occupancy=4, total_rooms=1
        )

        resp = await client.get(f"/api/hotels/{hotel['slug']}/rooms?adults=6&children=0")
        assert resp.status_code == 200
        assert resp.json() == []

    async def test_remaining_under_required_still_returns_room_for_sold_out_badge(
        self, client, cleanup_database
    ):
        """Capacity gate uses ``total_rooms`` (theoretical capability) so the
        frontend can render the "Sold Out" badge when ``remaining < ceil(guests/cap)``.
        Hiding it server-side would surprise guests whose dates just shifted."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(
            str(hotel["id"]), name="Two-Bedroom Pool Villa", max_occupancy=4, total_rooms=2
        )

        # Book one of the two units — only 1 remains for these dates,
        # but 6 guests need 2 units → frontend will show "Sold Out".
        await create_test_booking(
            str(hotel["id"]),
            str(room["id"]),
            check_in="2026-09-14",
            check_out="2026-09-16",
        )

        resp = await client.get(
            f"/api/hotels/{hotel['slug']}/rooms",
            params={
                "check_in": "2026-09-14",
                "check_out": "2026-09-16",
                "adults": 6,
                "children": 0,
            },
        )
        assert resp.status_code == 200
        rooms = resp.json()
        assert len(rooms) == 1
        assert rooms[0]["remainingRooms"] == 1

    async def test_adults_constraint_scales_with_units(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        # Per-unit: max 2 adults; with 3 units combined: max 6.
        await create_test_room_type(
            str(hotel["id"]),
            name="Couples Suite",
            max_occupancy=2,
            max_adults=2,
            max_children=0,
            total_rooms=3,
        )

        ok = await client.get(f"/api/hotels/{hotel['slug']}/rooms?adults=6&children=0")
        assert [r["name"] for r in ok.json()] == ["Couples Suite"]

        too_many = await client.get(f"/api/hotels/{hotel['slug']}/rooms?adults=7&children=0")
        assert too_many.json() == []
