"""
Tests for public /api/hotels/{slug}/bookings endpoints (create + lookup).
"""
import pytest
from unittest.mock import patch, AsyncMock
from tests.conftest import (
    create_test_user,
    create_test_hotel,
    create_test_room_type,
    create_test_booking,
    create_test_payment_settings,
)


class TestCreateBooking:
    @patch("app.services.stripe_service.create_payment_intent", new_callable=AsyncMock)
    @patch("app.services.email_service.send_booking_request_notification", new_callable=AsyncMock)
    @patch("app.services.email_service.send_guest_booking_requested", new_callable=AsyncMock)
    async def test_create_booking(
        self, mock_guest_email, mock_host_email, mock_stripe, client, hotel_with_rooms
    ):
        mock_stripe.return_value = {
            "id": "pi_test_123",
            "client_secret": "pi_test_123_secret_abc",
            "status": "requires_confirmation",
        }
        hotel = hotel_with_rooms["hotel"]
        room = hotel_with_rooms["room"]
        await create_test_payment_settings(
            str(hotel["id"]),
            stripe_connect_account_id="acct_test_123",
            stripe_connect_onboarded=True,
        )

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings",
            json={
                "roomTypeId": str(room["id"]),
                "guestFirstName": "Jane",
                "guestLastName": "Smith",
                "guestEmail": "jane@example.com",
                "guestPhone": "+9876543210",
                "checkIn": "2026-08-10",
                "checkOut": "2026-08-15",
                "adults": 2,
                "children": 1,
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        booking = body["booking"]
        assert booking["guestFirstName"] == "Jane"
        assert booking["guestLastName"] == "Smith"
        assert booking["hotelName"] == "Test Hotel"
        assert booking["roomName"] == "Deluxe Suite"
        assert booking["nights"] == 5
        assert booking["nightlyRate"] == 150.0
        assert booking["totalAmount"] == 750.0
        assert booking["status"] == "pending"
        assert booking["bookingReference"].startswith("VAY-")
        assert body["clientSecret"] == "pi_test_123_secret_abc"
        assert body["paymentMethod"] == "card"

    async def test_create_booking_invalid_room(self, client, hotel_with_rooms):
        hotel = hotel_with_rooms["hotel"]

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings",
            json={
                "roomTypeId": "00000000-0000-0000-0000-000000000000",
                "guestFirstName": "Test",
                "guestLastName": "User",
                "guestEmail": "test@example.com",
                "guestPhone": "+1234",
                "checkIn": "2026-08-10",
                "checkOut": "2026-08-15",
            },
        )
        assert resp.status_code == 400

    async def test_create_booking_checkout_before_checkin(self, client, hotel_with_rooms):
        hotel = hotel_with_rooms["hotel"]
        room = hotel_with_rooms["room"]

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings",
            json={
                "roomTypeId": str(room["id"]),
                "guestFirstName": "Test",
                "guestLastName": "User",
                "guestEmail": "test@example.com",
                "guestPhone": "+1234",
                "checkIn": "2026-08-15",
                "checkOut": "2026-08-10",
            },
        )
        assert resp.status_code == 400

    async def test_create_booking_no_availability(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]), total_rooms=1)

        # Book the only room
        await create_test_booking(
            str(hotel["id"]), str(room["id"]),
            check_in="2026-08-01", check_out="2026-08-05",
        )

        # Try to book overlapping dates
        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings",
            json={
                "roomTypeId": str(room["id"]),
                "guestFirstName": "Second",
                "guestLastName": "Guest",
                "guestEmail": "second@example.com",
                "guestPhone": "+1111",
                "checkIn": "2026-08-02",
                "checkOut": "2026-08-04",
            },
        )
        assert resp.status_code == 400

    async def test_create_booking_unknown_hotel(self, client, init_database):
        resp = await client.post(
            "/api/hotels/nonexistent-hotel/bookings",
            json={
                "roomTypeId": "00000000-0000-0000-0000-000000000000",
                "guestFirstName": "Test",
                "guestLastName": "User",
                "guestEmail": "test@example.com",
                "guestPhone": "+1234",
                "checkIn": "2026-08-10",
                "checkOut": "2026-08-15",
            },
        )
        assert resp.status_code == 400

    async def test_create_booking_inactive_room(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]), is_active=False)

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings",
            json={
                "roomTypeId": str(room["id"]),
                "guestFirstName": "Test",
                "guestLastName": "User",
                "guestEmail": "test@example.com",
                "guestPhone": "+1234",
                "checkIn": "2026-08-10",
                "checkOut": "2026-08-15",
            },
        )
        assert resp.status_code == 400

    async def test_create_booking_below_min_stay(self, client, cleanup_database):
        import json as _json
        from app.database import Database

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))

        seasons = [{
            "name": "All year",
            "tier": "Mid",
            "from": "01-01",
            "to": "12-31",
            "rate": "150",
            "minStay": 2,
        }]
        await Database.execute(
            "UPDATE room_types SET seasons = $1::jsonb WHERE id = $2",
            _json.dumps(seasons), room["id"],
        )

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings",
            json={
                "roomTypeId": str(room["id"]),
                "guestFirstName": "Test",
                "guestLastName": "User",
                "guestEmail": "test@example.com",
                "guestPhone": "+1234",
                "checkIn": "2026-08-10",
                "checkOut": "2026-08-11",
            },
        )
        assert resp.status_code == 400
        assert "minimum stay" in resp.json()["detail"].lower()


class TestBookingLookup:
    async def test_lookup_booking(self, client, hotel_with_booking):
        hotel = hotel_with_booking["hotel"]
        booking = hotel_with_booking["booking"]

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings/lookup",
            json={
                "bookingReference": booking["booking_reference"],
                "guestEmail": "guest@example.com",
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["bookingReference"] == booking["booking_reference"]
        assert body["guestFirstName"] == "John"

    async def test_lookup_booking_case_insensitive_email(self, client, hotel_with_booking):
        hotel = hotel_with_booking["hotel"]
        booking = hotel_with_booking["booking"]

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings/lookup",
            json={
                "bookingReference": booking["booking_reference"],
                "guestEmail": "GUEST@EXAMPLE.COM",
            },
        )
        assert resp.status_code == 200

    async def test_lookup_booking_not_found(self, client, hotel_with_rooms):
        hotel = hotel_with_rooms["hotel"]

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings/lookup",
            json={
                "bookingReference": "VAY-NONEXIST",
                "guestEmail": "nobody@example.com",
            },
        )
        assert resp.status_code == 404

    async def test_lookup_booking_wrong_hotel(self, client, cleanup_database):
        """Booking exists but lookup is against wrong hotel slug."""
        user1 = await create_test_user()
        hotel1 = await create_test_hotel(str(user1["id"]), name="Hotel 1")
        room1 = await create_test_room_type(str(hotel1["id"]))
        booking = await create_test_booking(str(hotel1["id"]), str(room1["id"]))

        user2 = await create_test_user()
        hotel2 = await create_test_hotel(str(user2["id"]), name="Hotel 2")

        resp = await client.post(
            f"/api/hotels/{hotel2['slug']}/bookings/lookup",
            json={
                "bookingReference": booking["booking_reference"],
                "guestEmail": "guest@example.com",
            },
        )
        assert resp.status_code == 404
