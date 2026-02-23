"""
Tests for GET /admin/calendar endpoint.
"""
from tests.conftest import (
    create_test_user,
    create_test_hotel,
    create_test_room_type,
    create_test_booking,
    create_test_room_block,
    get_auth_headers,
)


class TestCalendar:
    async def test_calendar_empty(self, client, cleanup_database):
        """Calendar with no bookings or blocks returns empty lists."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        await create_test_room_type(str(hotel["id"]))

        resp = await client.get(
            "/admin/calendar?start=2026-06-01&end=2026-06-30",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert len(body["roomTypes"]) == 1
        assert body["bookings"] == []
        assert body["blocks"] == []

    async def test_calendar_with_bookings(self, client, hotel_with_booking):
        """Calendar returns bookings within the date range."""
        user = hotel_with_booking["user"]

        resp = await client.get(
            "/admin/calendar?start=2026-05-01&end=2026-07-01",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert len(body["bookings"]) == 1
        assert body["bookings"][0]["guestFirstName"] == "John"
        assert body["bookings"][0]["guestLastName"] == "Doe"
        assert "checkIn" in body["bookings"][0]
        assert "checkOut" in body["bookings"][0]
        assert "status" in body["bookings"][0]

    async def test_calendar_bookings_outside_range(self, client, hotel_with_booking):
        """Calendar does not return bookings outside the date range."""
        user = hotel_with_booking["user"]

        resp = await client.get(
            "/admin/calendar?start=2026-01-01&end=2026-01-31",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        assert resp.json()["bookings"] == []

    async def test_calendar_with_room_blocks(self, client, cleanup_database):
        """Calendar returns room blocks within the date range."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        await create_test_room_block(
            str(hotel["id"]), str(room["id"]),
            start_date="2026-07-01", end_date="2026-07-05",
            reason="Renovation",
        )

        resp = await client.get(
            "/admin/calendar?start=2026-07-01&end=2026-07-31",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert len(body["blocks"]) == 1
        assert body["blocks"][0]["reason"] == "Renovation"
        assert body["blocks"][0]["blockedCount"] == 1

    async def test_calendar_room_types_shape(self, client, hotel_with_rooms):
        """Room types include id, name, totalRooms."""
        user = hotel_with_rooms["user"]

        resp = await client.get(
            "/admin/calendar?start=2026-06-01&end=2026-06-30",
            headers=get_auth_headers(user["token"]),
        )
        rt = resp.json()["roomTypes"][0]
        assert "id" in rt
        assert rt["name"] == "Deluxe Suite"
        assert rt["totalRooms"] == 5

    async def test_calendar_requires_auth(self, client):
        resp = await client.get("/admin/calendar?start=2026-06-01&end=2026-06-30")
        assert resp.status_code == 403

    async def test_calendar_requires_dates(self, client, hotel_with_rooms):
        """Missing start/end params → 422."""
        user = hotel_with_rooms["user"]
        resp = await client.get(
            "/admin/calendar",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 422

    async def test_calendar_no_hotel(self, client, cleanup_database):
        """User with no hotel → 404."""
        user = await create_test_user()
        resp = await client.get(
            "/admin/calendar?start=2026-06-01&end=2026-06-30",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 404
