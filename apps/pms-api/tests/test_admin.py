"""
Tests for /admin endpoints — hotel registration, setup status, room CRUD, booking management.
"""
import pytest
from tests.conftest import (
    create_test_user,
    create_test_hotel,
    create_test_room_type,
    create_test_booking,
    get_auth_headers,
    generate_test_slug,
)


# ── Hotel Registration ────────────────────────────────────────────


class TestRegisterHotel:
    async def test_register_hotel(self, client, cleanup_database):
        user = await create_test_user()
        slug = generate_test_slug()
        resp = await client.post(
            "/admin/register-hotel",
            json={"name": "My Hotel", "slug": slug, "contactEmail": "info@hotel.com"},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 201
        body = resp.json()
        assert body["name"] == "My Hotel"
        assert body["slug"] == slug
        assert body["contactEmail"] == "info@hotel.com"
        assert body["userId"] == str(user["id"])

    async def test_register_hotel_idempotent(self, client, cleanup_database):
        user = await create_test_user()
        slug = generate_test_slug()
        payload = {"name": "Hotel One", "slug": slug, "contactEmail": "a@b.com"}
        headers = get_auth_headers(user["token"])

        resp1 = await client.post("/admin/register-hotel", json=payload, headers=headers)
        assert resp1.status_code == 201
        hotel_id = resp1.json()["id"]

        # Second call returns same hotel
        resp2 = await client.post(
            "/admin/register-hotel",
            json={"name": "Ignored Name", "slug": "ignored-slug", "contactEmail": "ignored@b.com"},
            headers=headers,
        )
        assert resp2.status_code == 201
        assert resp2.json()["id"] == hotel_id
        assert resp2.json()["name"] == "Hotel One"  # original name

    async def test_register_hotel_requires_auth(self, client):
        resp = await client.post(
            "/admin/register-hotel",
            json={"name": "X", "slug": "x", "contactEmail": "x@x.com"},
        )
        assert resp.status_code == 403

    async def test_register_hotel_non_hotel_user(self, client, cleanup_database):
        user = await create_test_user(user_type="admin")
        resp = await client.post(
            "/admin/register-hotel",
            json={"name": "X", "slug": "x", "contactEmail": "x@x.com"},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 403


# ── Setup Status ──────────────────────────────────────────────────


class TestSetupStatus:
    async def test_setup_status_no_hotel(self, client, cleanup_database):
        """Setup-status auto-registers a hotel from auth profile."""
        user = await create_test_user()
        resp = await client.get(
            "/admin/setup-status",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        # Auto-register creates hotel from auth profile, so registered is True
        assert body["registered"] is True
        assert body["setupComplete"] is False
        assert body["roomCount"] == 0

    async def test_setup_status_registered_no_rooms(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        resp = await client.get(
            "/admin/setup-status",
            headers=get_auth_headers(user["token"]),
        )
        body = resp.json()
        assert body["registered"] is True
        assert body["setupComplete"] is False
        assert body["roomCount"] == 0

    async def test_setup_status_complete(self, client, hotel_with_rooms):
        user = hotel_with_rooms["user"]
        resp = await client.get(
            "/admin/setup-status",
            headers=get_auth_headers(user["token"]),
        )
        body = resp.json()
        assert body["registered"] is True
        assert body["setupComplete"] is True
        assert body["roomCount"] == 1


# ── Admin Room Types ──────────────────────────────────────────────


class TestAdminRoomTypes:
    async def test_list_room_types_empty(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        resp = await client.get(
            "/admin/room-types",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        assert resp.json() == []

    async def test_create_room_type(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        resp = await client.post(
            "/admin/room-types",
            json={
                "name": "Standard Room",
                "description": "A nice room",
                "baseRate": 100.0,
                "maxOccupancy": 2,
                "totalRooms": 10,
                "bedType": "Queen",
                "amenities": ["WiFi", "TV"],
                "features": ["City View"],
            },
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 201
        body = resp.json()
        assert body["name"] == "Standard Room"
        assert body["baseRate"] == 100.0
        assert body["totalRooms"] == 10
        assert body["bedType"] == "Queen"
        assert body["amenities"] == ["WiFi", "TV"]
        assert body["isActive"] is True

    async def test_get_room_type(self, client, hotel_with_rooms):
        user = hotel_with_rooms["user"]
        room = hotel_with_rooms["room"]

        resp = await client.get(
            f"/admin/room-types/{room['id']}",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        assert resp.json()["name"] == "Deluxe Suite"

    async def test_get_room_type_not_found(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        resp = await client.get(
            "/admin/room-types/00000000-0000-0000-0000-000000000000",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 404

    async def test_update_room_type(self, client, hotel_with_rooms):
        user = hotel_with_rooms["user"]
        room = hotel_with_rooms["room"]

        resp = await client.patch(
            f"/admin/room-types/{room['id']}",
            json={"name": "Updated Suite", "baseRate": 200.0},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["name"] == "Updated Suite"
        assert body["baseRate"] == 200.0

    async def test_delete_room_type(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))

        resp = await client.delete(
            f"/admin/room-types/{room['id']}",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 204

        # Verify gone
        resp2 = await client.get(
            f"/admin/room-types/{room['id']}",
            headers=get_auth_headers(user["token"]),
        )
        assert resp2.status_code == 404

    async def test_delete_room_type_with_bookings_fails(self, client, hotel_with_booking):
        user = hotel_with_booking["user"]
        room = hotel_with_booking["room"]

        resp = await client.delete(
            f"/admin/room-types/{room['id']}",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 409

    async def test_list_room_types(self, client, hotel_with_rooms):
        user = hotel_with_rooms["user"]

        resp = await client.get(
            "/admin/room-types",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        rooms = resp.json()
        assert len(rooms) == 1
        assert rooms[0]["name"] == "Deluxe Suite"

    async def test_create_room_type_with_non_refundable_rate(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        resp = await client.post(
            "/admin/room-types",
            json={
                "name": "NR Room",
                "description": "Room with non-refundable rate",
                "baseRate": 200.0,
                "nonRefundableRate": 170.0,
                "maxOccupancy": 2,
                "totalRooms": 5,
                "bedType": "King",
                "amenities": ["WiFi"],
                "features": [],
            },
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 201
        body = resp.json()
        assert body["nonRefundableRate"] == 170.0

    async def test_create_room_type_without_non_refundable_rate(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        resp = await client.post(
            "/admin/room-types",
            json={
                "name": "Flex Only Room",
                "description": "Room without non-refundable rate",
                "baseRate": 100.0,
                "maxOccupancy": 2,
                "totalRooms": 3,
                "bedType": "Queen",
                "amenities": [],
                "features": [],
            },
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 201
        body = resp.json()
        assert body["nonRefundableRate"] is None

    async def test_update_non_refundable_rate(self, client, hotel_with_rooms):
        user = hotel_with_rooms["user"]
        room = hotel_with_rooms["room"]

        resp = await client.patch(
            f"/admin/room-types/{room['id']}",
            json={"nonRefundableRate": 120.0},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        assert resp.json()["nonRefundableRate"] == 120.0

    async def test_clear_non_refundable_rate(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]), non_refundable_rate=130.0)

        # Verify it was set
        resp = await client.get(
            f"/admin/room-types/{room['id']}",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.json()["nonRefundableRate"] == 130.0

        # Clear it by setting to null
        resp2 = await client.patch(
            f"/admin/room-types/{room['id']}",
            json={"nonRefundableRate": None},
            headers=get_auth_headers(user["token"]),
        )
        assert resp2.status_code == 200
        assert resp2.json()["nonRefundableRate"] is None

    async def test_cannot_access_other_hotels_room(self, client, hotel_with_rooms):
        """A second hotel user cannot access the first hotel's rooms."""
        other_user = await create_test_user()
        await create_test_hotel(str(other_user["id"]))

        room = hotel_with_rooms["room"]
        resp = await client.get(
            f"/admin/room-types/{room['id']}",
            headers=get_auth_headers(other_user["token"]),
        )
        assert resp.status_code == 404


# ── Admin Bookings ────────────────────────────────────────────────


class TestAdminBookings:
    async def test_list_bookings_empty(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        resp = await client.get(
            "/admin/bookings",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["bookings"] == []
        assert body["total"] == 0

    async def test_list_bookings(self, client, hotel_with_booking):
        user = hotel_with_booking["user"]

        resp = await client.get(
            "/admin/bookings",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["total"] == 1
        assert len(body["bookings"]) == 1
        assert body["bookings"][0]["guestEmail"] == "guest@example.com"

    async def test_list_bookings_filter_status(self, client, hotel_with_booking):
        user = hotel_with_booking["user"]

        resp = await client.get(
            "/admin/bookings?status=pending",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        assert resp.json()["total"] == 1

        resp2 = await client.get(
            "/admin/bookings?status=confirmed",
            headers=get_auth_headers(user["token"]),
        )
        assert resp2.json()["total"] == 0

    async def test_get_booking(self, client, hotel_with_booking):
        user = hotel_with_booking["user"]
        booking = hotel_with_booking["booking"]

        resp = await client.get(
            f"/admin/bookings/{booking['id']}",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["guestFirstName"] == "John"
        assert body["guestLastName"] == "Doe"
        assert body["status"] == "pending"

    async def test_get_booking_not_found(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        resp = await client.get(
            "/admin/bookings/00000000-0000-0000-0000-000000000000",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 404

    async def test_confirm_booking(self, client, hotel_with_booking):
        user = hotel_with_booking["user"]
        booking = hotel_with_booking["booking"]

        resp = await client.patch(
            f"/admin/bookings/{booking['id']}/status",
            json={"status": "confirmed"},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "confirmed"

    async def test_cancel_booking(self, client, hotel_with_booking):
        user = hotel_with_booking["user"]
        booking = hotel_with_booking["booking"]

        resp = await client.patch(
            f"/admin/bookings/{booking['id']}/status",
            json={"status": "cancelled"},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "cancelled"

    async def test_invalid_booking_status(self, client, hotel_with_booking):
        user = hotel_with_booking["user"]
        booking = hotel_with_booking["booking"]

        resp = await client.patch(
            f"/admin/bookings/{booking['id']}/status",
            json={"status": "invalid_status"},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 400

    async def test_list_bookings_pagination(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))

        # Create 3 bookings
        for i in range(3):
            await create_test_booking(
                str(hotel["id"]),
                str(room["id"]),
                check_in=f"2026-0{i+7}-01",
                check_out=f"2026-0{i+7}-05",
                guest_email=f"guest{i}@example.com",
            )

        resp = await client.get(
            "/admin/bookings?limit=2&offset=0",
            headers=get_auth_headers(user["token"]),
        )
        body = resp.json()
        assert body["total"] == 3
        assert len(body["bookings"]) == 2
        assert body["limit"] == 2
        assert body["offset"] == 0

        resp2 = await client.get(
            "/admin/bookings?limit=2&offset=2",
            headers=get_auth_headers(user["token"]),
        )
        body2 = resp2.json()
        assert len(body2["bookings"]) == 1
