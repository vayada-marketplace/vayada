"""
Tests for PATCH /admin/bookings/{id}/swap-room — atomically exchange two
reservations' room assignments (or assign an unassigned booking by displacing
the occupier into a free room).
"""

import json as _json

from app.database import Database

from tests.conftest import (
    create_test_booking,
    create_test_hotel,
    create_test_room,
    create_test_room_type,
    create_test_user,
    get_auth_headers,
)


async def _swap(
    client,
    token: str,
    booking_id: str,
    partner_booking_id: str,
    partner_destination_room_id: str | None = None,
):
    body: dict = {"partnerBookingId": partner_booking_id}
    if partner_destination_room_id is not None:
        body["partnerDestinationRoomId"] = partner_destination_room_id
    return await client.patch(
        f"/admin/bookings/{booking_id}/swap-room",
        json=body,
        headers=get_auth_headers(token),
    )


async def _set_room(booking_id, room_id):
    await Database.execute(
        "UPDATE bookings SET room_id = $1 WHERE id = $2",
        room_id,
        booking_id,
    )


class TestSwapRooms:
    async def test_swap_two_assigned_bookings(self, client, hotel_with_rooms):
        """A↔B: dates overlap, both assigned, simple two-way swap."""
        user = hotel_with_rooms["user"]
        hotel = hotel_with_rooms["hotel"]
        rt = hotel_with_rooms["room"]
        rooms = hotel_with_rooms["rooms"]

        a = await create_test_booking(
            str(hotel["id"]),
            str(rt["id"]),
            check_in="2026-06-01",
            check_out="2026-06-05",
            status="confirmed",
            guest_email="a@example.com",
        )
        b = await create_test_booking(
            str(hotel["id"]),
            str(rt["id"]),
            check_in="2026-06-02",
            check_out="2026-06-06",
            status="confirmed",
            guest_email="b@example.com",
        )
        await _set_room(a["id"], rooms[0]["id"])
        await _set_room(b["id"], rooms[1]["id"])

        resp = await _swap(client, user["token"], str(a["id"]), str(b["id"]))
        assert resp.status_code == 200, resp.text
        assert resp.json()["roomId"] == str(rooms[1]["id"])

        # Partner row also swapped.
        b_after = await Database.fetchrow(
            "SELECT room_id FROM bookings WHERE id = $1",
            b["id"],
        )
        assert str(b_after["room_id"]) == str(rooms[0]["id"])

        # Two audit rows, one per booking, each pointing at the other.
        events = await Database.fetch(
            "SELECT booking_id, event_type, payload FROM booking_events "
            "WHERE booking_id IN ($1, $2) ORDER BY created_at",
            a["id"],
            b["id"],
        )
        assert len(events) == 2
        by_booking = {str(e["booking_id"]): e for e in events}
        ev_a = by_booking[str(a["id"])]
        ev_b = by_booking[str(b["id"])]
        assert ev_a["event_type"] == "room_swapped"
        pa = ev_a["payload"] if isinstance(ev_a["payload"], dict) else _json.loads(ev_a["payload"])
        pb = ev_b["payload"] if isinstance(ev_b["payload"], dict) else _json.loads(ev_b["payload"])
        assert pa["from_room_id"] == str(rooms[0]["id"])
        assert pa["to_room_id"] == str(rooms[1]["id"])
        assert pa["paired_booking_id"] == str(b["id"])
        assert pb["from_room_id"] == str(rooms[1]["id"])
        assert pb["to_room_id"] == str(rooms[0]["id"])
        assert pb["paired_booking_id"] == str(a["id"])

    async def test_swap_unassigned_source_with_free_destination(self, client, hotel_with_rooms):
        """Unassigned source takes partner's room; partner moves to free room."""
        user = hotel_with_rooms["user"]
        hotel = hotel_with_rooms["hotel"]
        rt = hotel_with_rooms["room"]
        rooms = hotel_with_rooms["rooms"]

        # Source: unassigned, June 19–22.
        source = await create_test_booking(
            str(hotel["id"]),
            str(rt["id"]),
            check_in="2026-06-19",
            check_out="2026-06-22",
            status="confirmed",
            guest_email="victoria@example.com",
        )
        # Partner: assigned to room[0], dates overlap source.
        partner = await create_test_booking(
            str(hotel["id"]),
            str(rt["id"]),
            check_in="2026-06-18",
            check_out="2026-06-23",
            status="confirmed",
            guest_email="partner@example.com",
        )
        await _set_room(partner["id"], rooms[0]["id"])
        # rooms[1] is free for the whole window.

        resp = await _swap(
            client,
            user["token"],
            str(source["id"]),
            str(partner["id"]),
            partner_destination_room_id=str(rooms[1]["id"]),
        )
        assert resp.status_code == 200, resp.text
        # Source now in partner's old room.
        assert resp.json()["roomId"] == str(rooms[0]["id"])
        # Partner moved to the free room.
        partner_after = await Database.fetchrow(
            "SELECT room_id FROM bookings WHERE id = $1",
            partner["id"],
        )
        assert str(partner_after["room_id"]) == str(rooms[1]["id"])

    async def test_swap_rejects_self_swap(self, client, hotel_with_rooms):
        user = hotel_with_rooms["user"]
        hotel = hotel_with_rooms["hotel"]
        rt = hotel_with_rooms["room"]
        rooms = hotel_with_rooms["rooms"]

        a = await create_test_booking(
            str(hotel["id"]),
            str(rt["id"]),
            check_in="2026-06-01",
            check_out="2026-06-05",
            status="confirmed",
        )
        await _set_room(a["id"], rooms[0]["id"])

        resp = await _swap(client, user["token"], str(a["id"]), str(a["id"]))
        assert resp.status_code == 400
        assert "itself" in resp.json()["detail"].lower()

    async def test_swap_rejects_cancelled_partner(self, client, hotel_with_rooms):
        user = hotel_with_rooms["user"]
        hotel = hotel_with_rooms["hotel"]
        rt = hotel_with_rooms["room"]
        rooms = hotel_with_rooms["rooms"]

        a = await create_test_booking(
            str(hotel["id"]),
            str(rt["id"]),
            check_in="2026-06-01",
            check_out="2026-06-05",
            status="confirmed",
            guest_email="a@example.com",
        )
        b = await create_test_booking(
            str(hotel["id"]),
            str(rt["id"]),
            check_in="2026-06-01",
            check_out="2026-06-05",
            status="cancelled",
            guest_email="b@example.com",
        )
        await _set_room(a["id"], rooms[0]["id"])
        await _set_room(b["id"], rooms[1]["id"])

        resp = await _swap(client, user["token"], str(a["id"]), str(b["id"]))
        assert resp.status_code == 400
        assert "swappable" in resp.json()["detail"].lower()

    async def test_swap_rejects_cross_room_type(self, client, hotel_with_rooms):
        user = hotel_with_rooms["user"]
        hotel = hotel_with_rooms["hotel"]
        rt = hotel_with_rooms["room"]
        rooms = hotel_with_rooms["rooms"]

        other_type = await create_test_room_type(
            str(hotel["id"]),
            name="Standard Double",
            base_rate=80.0,
            total_rooms=1,
        )
        other_room = await create_test_room(
            str(hotel["id"]),
            str(other_type["id"]),
            room_number="201",
        )

        a = await create_test_booking(
            str(hotel["id"]),
            str(rt["id"]),
            check_in="2026-06-01",
            check_out="2026-06-05",
            status="confirmed",
            guest_email="a@example.com",
        )
        b = await create_test_booking(
            str(hotel["id"]),
            str(other_type["id"]),
            check_in="2026-06-01",
            check_out="2026-06-05",
            status="confirmed",
            guest_email="b@example.com",
        )
        await _set_room(a["id"], rooms[0]["id"])
        await _set_room(b["id"], other_room["id"])

        resp = await _swap(client, user["token"], str(a["id"]), str(b["id"]))
        assert resp.status_code == 400
        assert "same room type" in resp.json()["detail"].lower()

    async def test_swap_rejects_when_target_room_has_third_party_conflict(
        self, client, hotel_with_rooms
    ):
        """A wants B's room, but a third booking already overlaps in B's room."""
        user = hotel_with_rooms["user"]
        hotel = hotel_with_rooms["hotel"]
        rt = hotel_with_rooms["room"]
        rooms = hotel_with_rooms["rooms"]

        # A in room 0 for the full window. B in room 1 only for the tail half.
        # A 8-day stay vs B 4-day stay, so when B moves out of room 1 there is
        # still C overlapping A's dates in room 1 → swap creates a conflict.
        a = await create_test_booking(
            str(hotel["id"]),
            str(rt["id"]),
            check_in="2026-06-01",
            check_out="2026-06-09",
            status="confirmed",
            guest_email="a@example.com",
        )
        b = await create_test_booking(
            str(hotel["id"]),
            str(rt["id"]),
            check_in="2026-06-05",
            check_out="2026-06-09",
            status="confirmed",
            guest_email="b@example.com",
        )
        c = await create_test_booking(
            str(hotel["id"]),
            str(rt["id"]),
            check_in="2026-06-01",
            check_out="2026-06-04",
            status="confirmed",
            guest_email="c@example.com",
        )
        await _set_room(a["id"], rooms[0]["id"])
        await _set_room(b["id"], rooms[1]["id"])
        await _set_room(c["id"], rooms[1]["id"])

        resp = await _swap(client, user["token"], str(a["id"]), str(b["id"]))
        assert resp.status_code == 409

    async def test_swap_rejects_when_partner_destination_wrong_type(self, client, hotel_with_rooms):
        user = hotel_with_rooms["user"]
        hotel = hotel_with_rooms["hotel"]
        rt = hotel_with_rooms["room"]
        rooms = hotel_with_rooms["rooms"]

        other_type = await create_test_room_type(
            str(hotel["id"]),
            name="Standard Double",
            base_rate=80.0,
            total_rooms=1,
        )
        other_room = await create_test_room(
            str(hotel["id"]),
            str(other_type["id"]),
            room_number="201",
        )

        source = await create_test_booking(
            str(hotel["id"]),
            str(rt["id"]),
            check_in="2026-06-19",
            check_out="2026-06-22",
            status="confirmed",
            guest_email="src@example.com",
        )
        partner = await create_test_booking(
            str(hotel["id"]),
            str(rt["id"]),
            check_in="2026-06-18",
            check_out="2026-06-23",
            status="confirmed",
            guest_email="ptr@example.com",
        )
        await _set_room(partner["id"], rooms[0]["id"])

        resp = await _swap(
            client,
            user["token"],
            str(source["id"]),
            str(partner["id"]),
            partner_destination_room_id=str(other_room["id"]),
        )
        assert resp.status_code == 400
        assert "same room type" in resp.json()["detail"].lower()

    async def test_swap_rejects_unassigned_source_without_destination(
        self, client, hotel_with_rooms
    ):
        user = hotel_with_rooms["user"]
        hotel = hotel_with_rooms["hotel"]
        rt = hotel_with_rooms["room"]
        rooms = hotel_with_rooms["rooms"]

        source = await create_test_booking(
            str(hotel["id"]),
            str(rt["id"]),
            check_in="2026-06-19",
            check_out="2026-06-22",
            status="confirmed",
            guest_email="src@example.com",
        )
        partner = await create_test_booking(
            str(hotel["id"]),
            str(rt["id"]),
            check_in="2026-06-18",
            check_out="2026-06-23",
            status="confirmed",
            guest_email="ptr@example.com",
        )
        await _set_room(partner["id"], rooms[0]["id"])

        resp = await _swap(client, user["token"], str(source["id"]), str(partner["id"]))
        assert resp.status_code == 400
        assert "partnerdestinationroomid" in resp.json()["detail"].lower()

    async def test_swap_rejects_partner_with_no_room(self, client, hotel_with_rooms):
        user = hotel_with_rooms["user"]
        hotel = hotel_with_rooms["hotel"]
        rt = hotel_with_rooms["room"]
        rooms = hotel_with_rooms["rooms"]

        a = await create_test_booking(
            str(hotel["id"]),
            str(rt["id"]),
            check_in="2026-06-01",
            check_out="2026-06-05",
            status="confirmed",
            guest_email="a@example.com",
        )
        b = await create_test_booking(
            str(hotel["id"]),
            str(rt["id"]),
            check_in="2026-06-01",
            check_out="2026-06-05",
            status="confirmed",
            guest_email="b@example.com",
        )
        await _set_room(a["id"], rooms[0]["id"])
        # b is unassigned

        resp = await _swap(client, user["token"], str(a["id"]), str(b["id"]))
        assert resp.status_code == 400
        assert "no room assigned" in resp.json()["detail"].lower()

    async def test_swap_rejects_foreign_hotel(self, client, hotel_with_rooms):
        hotel = hotel_with_rooms["hotel"]
        rt = hotel_with_rooms["room"]
        rooms = hotel_with_rooms["rooms"]

        a = await create_test_booking(
            str(hotel["id"]),
            str(rt["id"]),
            check_in="2026-06-01",
            check_out="2026-06-05",
            status="confirmed",
            guest_email="a@example.com",
        )
        b = await create_test_booking(
            str(hotel["id"]),
            str(rt["id"]),
            check_in="2026-06-01",
            check_out="2026-06-05",
            status="confirmed",
            guest_email="b@example.com",
        )
        await _set_room(a["id"], rooms[0]["id"])
        await _set_room(b["id"], rooms[1]["id"])

        other_user = await create_test_user()
        await create_test_hotel(str(other_user["id"]))

        resp = await _swap(client, other_user["token"], str(a["id"]), str(b["id"]))
        assert resp.status_code == 404

    async def test_swap_unauthenticated(self, client, hotel_with_rooms):
        resp = await client.patch(
            "/admin/bookings/00000000-0000-0000-0000-000000000000/swap-room",
            json={"partnerBookingId": "00000000-0000-0000-0000-000000000001"},
        )
        assert resp.status_code == 401
