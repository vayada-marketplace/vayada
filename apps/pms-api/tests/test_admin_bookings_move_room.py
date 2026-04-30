"""
Tests for PATCH /admin/bookings/{id}/move-room — move a booking to another
room of the same type.
"""
import pytest

from app.database import Database
from tests.conftest import (
    create_test_user,
    create_test_hotel,
    create_test_room_type,
    create_test_booking,
    create_test_room,
    get_auth_headers,
)


async def _move(client, token: str, booking_id: str, room_id: str):
    return await client.patch(
        f"/admin/bookings/{booking_id}/move-room",
        json={"roomId": room_id},
        headers=get_auth_headers(token),
    )


class TestMoveBookingToRoom:
    async def test_move_room_success(self, client, hotel_with_rooms):
        """Booking with assigned room can be moved to another room of same type."""
        user = hotel_with_rooms["user"]
        hotel = hotel_with_rooms["hotel"]
        room_type = hotel_with_rooms["room"]
        rooms = hotel_with_rooms["rooms"]

        booking = await create_test_booking(
            str(hotel["id"]),
            str(room_type["id"]),
            check_in="2026-06-01",
            check_out="2026-06-05",
            status="confirmed",
        )
        # Pre-assign to first room
        await Database.execute(
            "UPDATE bookings SET room_id = $1 WHERE id = $2",
            rooms[0]["id"], booking["id"],
        )

        resp = await _move(client, user["token"], str(booking["id"]), str(rooms[1]["id"]))
        assert resp.status_code == 200, resp.text
        assert resp.json()["roomId"] == str(rooms[1]["id"])

        # Audit row written
        ev = await Database.fetchrow(
            "SELECT event_type, payload, actor_user_id FROM booking_events "
            "WHERE booking_id = $1",
            booking["id"],
        )
        assert ev is not None
        assert ev["event_type"] == "room_moved"
        assert str(ev["actor_user_id"]) == str(user["id"])
        import json as _json
        payload = ev["payload"] if isinstance(ev["payload"], dict) else _json.loads(ev["payload"])
        assert payload["from_room_id"] == str(rooms[0]["id"])
        assert payload["to_room_id"] == str(rooms[1]["id"])

    async def test_move_room_unassigned_booking(self, client, hotel_with_rooms):
        """A booking with no room yet can be 'moved' — from_room_id is null in audit."""
        user = hotel_with_rooms["user"]
        hotel = hotel_with_rooms["hotel"]
        room_type = hotel_with_rooms["room"]
        rooms = hotel_with_rooms["rooms"]

        booking = await create_test_booking(
            str(hotel["id"]), str(room_type["id"]),
            check_in="2026-06-10", check_out="2026-06-12",
            status="confirmed",
        )
        # leave room_id NULL

        resp = await _move(client, user["token"], str(booking["id"]), str(rooms[0]["id"]))
        assert resp.status_code == 200
        assert resp.json()["roomId"] == str(rooms[0]["id"])

    async def test_move_room_same_room_rejected(self, client, hotel_with_rooms):
        user = hotel_with_rooms["user"]
        hotel = hotel_with_rooms["hotel"]
        room_type = hotel_with_rooms["room"]
        rooms = hotel_with_rooms["rooms"]

        booking = await create_test_booking(
            str(hotel["id"]), str(room_type["id"]),
            check_in="2026-06-01", check_out="2026-06-05",
            status="confirmed",
        )
        await Database.execute(
            "UPDATE bookings SET room_id = $1 WHERE id = $2",
            rooms[0]["id"], booking["id"],
        )

        resp = await _move(client, user["token"], str(booking["id"]), str(rooms[0]["id"]))
        assert resp.status_code == 400
        assert "already" in resp.json()["detail"].lower()

    async def test_move_room_cancelled_booking_rejected(self, client, hotel_with_rooms):
        user = hotel_with_rooms["user"]
        hotel = hotel_with_rooms["hotel"]
        room_type = hotel_with_rooms["room"]
        rooms = hotel_with_rooms["rooms"]

        booking = await create_test_booking(
            str(hotel["id"]), str(room_type["id"]),
            check_in="2026-06-01", check_out="2026-06-05",
            status="cancelled",
        )

        resp = await _move(client, user["token"], str(booking["id"]), str(rooms[0]["id"]))
        assert resp.status_code == 400
        assert "cancelled" in resp.json()["detail"].lower()

    async def test_move_room_unavailable_target(self, client, hotel_with_rooms):
        """Target room blocked by another overlapping booking → 409."""
        user = hotel_with_rooms["user"]
        hotel = hotel_with_rooms["hotel"]
        room_type = hotel_with_rooms["room"]
        rooms = hotel_with_rooms["rooms"]

        booking_a = await create_test_booking(
            str(hotel["id"]), str(room_type["id"]),
            check_in="2026-06-01", check_out="2026-06-05",
            status="confirmed", guest_email="a@example.com",
        )
        booking_b = await create_test_booking(
            str(hotel["id"]), str(room_type["id"]),
            check_in="2026-06-03", check_out="2026-06-07",
            status="confirmed", guest_email="b@example.com",
        )
        # A in room 0, B in room 1 — try to move A into room 1 (overlap)
        await Database.execute(
            "UPDATE bookings SET room_id = $1 WHERE id = $2",
            rooms[0]["id"], booking_a["id"],
        )
        await Database.execute(
            "UPDATE bookings SET room_id = $1 WHERE id = $2",
            rooms[1]["id"], booking_b["id"],
        )

        resp = await _move(client, user["token"], str(booking_a["id"]), str(rooms[1]["id"]))
        assert resp.status_code == 409

    async def test_move_room_self_overlap_excluded(self, client, hotel_with_rooms):
        """Moving to a free room must not be blocked by the booking's own current assignment."""
        user = hotel_with_rooms["user"]
        hotel = hotel_with_rooms["hotel"]
        room_type = hotel_with_rooms["room"]
        rooms = hotel_with_rooms["rooms"]

        booking = await create_test_booking(
            str(hotel["id"]), str(room_type["id"]),
            check_in="2026-06-01", check_out="2026-06-05",
            status="confirmed",
        )
        await Database.execute(
            "UPDATE bookings SET room_id = $1 WHERE id = $2",
            rooms[0]["id"], booking["id"],
        )
        # Target room is empty for these dates → success.
        resp = await _move(client, user["token"], str(booking["id"]), str(rooms[2]["id"]))
        assert resp.status_code == 200, resp.text

    async def test_move_room_cross_room_type_rejected(self, client, hotel_with_rooms):
        """Cannot move to a room belonging to a different room type."""
        user = hotel_with_rooms["user"]
        hotel = hotel_with_rooms["hotel"]
        room_type = hotel_with_rooms["room"]

        # Second room type + a room under it
        other_type = await create_test_room_type(
            str(hotel["id"]), name="Standard Double", base_rate=80.0, total_rooms=1,
        )
        other_room = await create_test_room(
            str(hotel["id"]), str(other_type["id"]), room_number="201",
        )

        booking = await create_test_booking(
            str(hotel["id"]), str(room_type["id"]),
            check_in="2026-06-01", check_out="2026-06-05",
            status="confirmed",
        )

        resp = await _move(client, user["token"], str(booking["id"]), str(other_room["id"]))
        assert resp.status_code == 400
        assert "same room type" in resp.json()["detail"].lower()

    async def test_move_room_foreign_hotel_rejected(self, client, hotel_with_rooms):
        """A user from another hotel cannot move someone else's booking."""
        hotel_a = hotel_with_rooms["hotel"]
        room_type_a = hotel_with_rooms["room"]
        rooms_a = hotel_with_rooms["rooms"]

        booking = await create_test_booking(
            str(hotel_a["id"]), str(room_type_a["id"]),
            check_in="2026-06-01", check_out="2026-06-05",
            status="confirmed",
        )

        # Different user/hotel
        other_user = await create_test_user()
        await create_test_hotel(str(other_user["id"]))

        resp = await _move(client, other_user["token"], str(booking["id"]), str(rooms_a[0]["id"]))
        assert resp.status_code == 404

    async def test_move_room_unauthenticated(self, client, hotel_with_rooms):
        rooms = hotel_with_rooms["rooms"]
        resp = await client.patch(
            "/admin/bookings/00000000-0000-0000-0000-000000000000/move-room",
            json={"roomId": str(rooms[0]["id"])},
        )
        assert resp.status_code == 401
