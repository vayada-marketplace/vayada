"""
VAY-406: editing "Total Rooms" on the Room Type form reconciles the
generated room units to match.

Before this, total_rooms was read-only post-VAY-402 — duplicating a
21-room type into a 2-room one meant hand-deleting 19 rooms. The PATCH
endpoint now treats totalRooms as a desired count: it appends new rooms
when raised and trims the tail when lowered, while blocking the
reduction if any of the rooms being dropped still has a non-cancelled
reservation.
"""

from app.database import Database

from tests.conftest import (
    create_test_booking,
    create_test_hotel,
    create_test_user,
    get_auth_headers,
)


async def _room_numbers(room_type_id: str) -> list[str]:
    rows = await Database.fetch(
        """
        SELECT room_number
        FROM rooms
        WHERE room_type_id = $1
        ORDER BY (COALESCE(NULLIF(regexp_replace(room_number, '.*[^0-9]', '', 'g'), ''), '0'))::int,
                 sort_order,
                 created_at,
                 room_number
        """,
        room_type_id,
    )
    return [r["room_number"] for r in rows]


async def _total_rooms(room_type_id: str) -> int:
    return await Database.fetchval("SELECT total_rooms FROM room_types WHERE id = $1", room_type_id)


async def _create_room_type(client, headers, **overrides) -> dict:
    payload = {
        "name": "Deluxe",
        "baseRate": 150.0,
        "maxOccupancy": 2,
        "totalRooms": 3,
    }
    payload.update(overrides)
    resp = await client.post("/admin/room-types", json=payload, headers=headers)
    assert resp.status_code == 201, resp.text
    return resp.json()


class TestTotalRoomsSync:
    async def test_raising_total_rooms_appends_sequential_units(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))
        headers = get_auth_headers(user["token"])
        rt = await _create_room_type(client, headers, totalRooms=2)

        resp = await client.patch(
            f"/admin/room-types/{rt['id']}",
            json={"totalRooms": 5},
            headers=headers,
        )
        assert resp.status_code == 200
        assert resp.json()["totalRooms"] == 5
        assert await _total_rooms(rt["id"]) == 5
        assert await _room_numbers(rt["id"]) == [
            "Deluxe 1",
            "Deluxe 2",
            "Deluxe 3",
            "Deluxe 4",
            "Deluxe 5",
        ]

    async def test_lowering_total_rooms_drops_the_tail(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))
        headers = get_auth_headers(user["token"])
        rt = await _create_room_type(client, headers, totalRooms=5)

        resp = await client.patch(
            f"/admin/room-types/{rt['id']}",
            json={"totalRooms": 2},
            headers=headers,
        )
        assert resp.status_code == 200
        assert resp.json()["totalRooms"] == 2
        # The reported repro: keep "Deluxe 1" + "Deluxe 2", drop "Deluxe 3"–5.
        assert await _room_numbers(rt["id"]) == ["Deluxe 1", "Deluxe 2"]

    async def test_lowering_is_blocked_by_active_reservation(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        headers = get_auth_headers(user["token"])
        rt = await _create_room_type(client, headers, totalRooms=3)

        # Pin the 3rd room ("Deluxe 3") to a confirmed booking — that's
        # the one a "lower to 2" reduction would otherwise silently drop.
        deluxe_3_id = await Database.fetchval(
            "SELECT id FROM rooms WHERE room_type_id = $1 AND room_number = 'Deluxe 3'",
            rt["id"],
        )
        booking = await create_test_booking(str(hotel["id"]), rt["id"], status="confirmed")
        await Database.execute(
            "UPDATE bookings SET room_id = $1 WHERE id = $2",
            deluxe_3_id,
            booking["id"],
        )

        resp = await client.patch(
            f"/admin/room-types/{rt['id']}",
            json={"totalRooms": 2},
            headers=headers,
        )
        assert resp.status_code == 409
        body = resp.json()
        assert body["detail"]["code"] == "rooms_have_bookings"
        assert str(deluxe_3_id) in body["detail"]["blockingRoomIds"]
        # Atomic — no rooms removed; total_rooms still 3.
        assert await _total_rooms(rt["id"]) == 3
        assert await _room_numbers(rt["id"]) == ["Deluxe 1", "Deluxe 2", "Deluxe 3"]

    async def test_lowering_skips_cancelled_bookings(self, client, cleanup_database):
        """A cancelled booking on a room shouldn't block the reduction —
        the room is no longer load-bearing."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        headers = get_auth_headers(user["token"])
        rt = await _create_room_type(client, headers, totalRooms=3)

        deluxe_3_id = await Database.fetchval(
            "SELECT id FROM rooms WHERE room_type_id = $1 AND room_number = 'Deluxe 3'",
            rt["id"],
        )
        booking = await create_test_booking(str(hotel["id"]), rt["id"], status="cancelled")
        await Database.execute(
            "UPDATE bookings SET room_id = $1 WHERE id = $2",
            deluxe_3_id,
            booking["id"],
        )

        resp = await client.patch(
            f"/admin/room-types/{rt['id']}",
            json={"totalRooms": 2},
            headers=headers,
        )
        assert resp.status_code == 200
        assert await _total_rooms(rt["id"]) == 2

    async def test_equal_total_rooms_is_a_noop(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))
        headers = get_auth_headers(user["token"])
        rt = await _create_room_type(client, headers, totalRooms=3)
        rooms_before = await _room_numbers(rt["id"])

        resp = await client.patch(
            f"/admin/room-types/{rt['id']}",
            json={"totalRooms": 3},
            headers=headers,
        )
        assert resp.status_code == 200
        assert await _room_numbers(rt["id"]) == rooms_before

    async def test_lowering_preserves_manually_renamed_unit(self, client, cleanup_database):
        """Manually-renamed rooms sort to the front of the kept list, so
        the user's customization survives a reduction."""
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))
        headers = get_auth_headers(user["token"])
        rt = await _create_room_type(client, headers, totalRooms=3)

        # User renames Deluxe 2 to "Penthouse Suite". Its sort-key now
        # extracts as "" → 0, ahead of the numeric siblings.
        await Database.execute(
            "UPDATE rooms SET room_number = 'Penthouse Suite' WHERE room_type_id = $1 AND room_number = 'Deluxe 2'",
            rt["id"],
        )

        resp = await client.patch(
            f"/admin/room-types/{rt['id']}",
            json={"totalRooms": 2},
            headers=headers,
        )
        assert resp.status_code == 200
        kept = await _room_numbers(rt["id"])
        assert "Penthouse Suite" in kept
        assert "Deluxe 1" in kept
        assert "Deluxe 3" not in kept
