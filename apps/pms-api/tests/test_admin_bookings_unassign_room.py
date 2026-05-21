"""
Tests for PATCH /admin/bookings/{id}/unassign-room — push an assigned booking
back to the Unassigned row by clearing its room_id.
"""
import json as _json

from app.database import Database
from tests.conftest import (
    create_test_user,
    create_test_hotel,
    create_test_booking,
    get_auth_headers,
)


async def _unassign(client, token: str, booking_id: str):
    return await client.patch(
        f"/admin/bookings/{booking_id}/unassign-room",
        headers=get_auth_headers(token),
    )


async def _set_room(booking_id, room_id):
    await Database.execute(
        "UPDATE bookings SET room_id = $1 WHERE id = $2", room_id, booking_id,
    )


class TestUnassignRoom:
    async def test_unassign_assigned_booking(self, client, hotel_with_rooms):
        """Assigned booking → room_id cleared, audit event written."""
        user = hotel_with_rooms["user"]
        hotel = hotel_with_rooms["hotel"]
        rt = hotel_with_rooms["room"]
        rooms = hotel_with_rooms["rooms"]

        booking = await create_test_booking(
            str(hotel["id"]), str(rt["id"]),
            check_in="2026-06-01", check_out="2026-06-05",
            status="confirmed",
        )
        await _set_room(booking["id"], rooms[0]["id"])

        resp = await _unassign(client, user["token"], str(booking["id"]))
        assert resp.status_code == 200, resp.text
        assert resp.json()["roomId"] is None

        # DB row also cleared.
        row = await Database.fetchrow(
            "SELECT room_id FROM bookings WHERE id = $1", booking["id"],
        )
        assert row["room_id"] is None

        # Audit row written with from_room_id pointing at the prior assignment.
        ev = await Database.fetchrow(
            "SELECT event_type, payload, actor_user_id FROM booking_events "
            "WHERE booking_id = $1",
            booking["id"],
        )
        assert ev is not None
        assert ev["event_type"] == "room_unassigned"
        assert str(ev["actor_user_id"]) == str(user["id"])
        payload = ev["payload"] if isinstance(ev["payload"], dict) else _json.loads(ev["payload"])
        assert payload["from_room_id"] == str(rooms[0]["id"])

    async def test_unassign_already_unassigned_rejected(
        self, client, hotel_with_rooms,
    ):
        user = hotel_with_rooms["user"]
        hotel = hotel_with_rooms["hotel"]
        rt = hotel_with_rooms["room"]

        booking = await create_test_booking(
            str(hotel["id"]), str(rt["id"]),
            check_in="2026-06-01", check_out="2026-06-05",
            status="confirmed",
        )
        # leave room_id NULL

        resp = await _unassign(client, user["token"], str(booking["id"]))
        assert resp.status_code == 400
        assert "already unassigned" in resp.json()["detail"].lower()

    async def test_unassign_cancelled_rejected(self, client, hotel_with_rooms):
        user = hotel_with_rooms["user"]
        hotel = hotel_with_rooms["hotel"]
        rt = hotel_with_rooms["room"]
        rooms = hotel_with_rooms["rooms"]

        booking = await create_test_booking(
            str(hotel["id"]), str(rt["id"]),
            check_in="2026-06-01", check_out="2026-06-05",
            status="cancelled",
        )
        await _set_room(booking["id"], rooms[0]["id"])

        resp = await _unassign(client, user["token"], str(booking["id"]))
        assert resp.status_code == 400
        assert "pending or confirmed" in resp.json()["detail"].lower()

    async def test_unassign_foreign_hotel_rejected(self, client, hotel_with_rooms):
        hotel = hotel_with_rooms["hotel"]
        rt = hotel_with_rooms["room"]
        rooms = hotel_with_rooms["rooms"]

        booking = await create_test_booking(
            str(hotel["id"]), str(rt["id"]),
            check_in="2026-06-01", check_out="2026-06-05",
            status="confirmed",
        )
        await _set_room(booking["id"], rooms[0]["id"])

        other_user = await create_test_user()
        await create_test_hotel(str(other_user["id"]))

        resp = await _unassign(client, other_user["token"], str(booking["id"]))
        assert resp.status_code == 404

    async def test_unassign_unauthenticated(self, client, hotel_with_rooms):
        resp = await client.patch(
            "/admin/bookings/00000000-0000-0000-0000-000000000000/unassign-room",
        )
        assert resp.status_code == 401
