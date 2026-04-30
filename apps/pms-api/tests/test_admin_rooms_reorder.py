"""
Tests for PATCH /admin/rooms/reorder — VAY-307 Calendar reorder mode.
"""
from app.database import Database
from tests.conftest import (
    create_test_user,
    create_test_hotel,
    create_test_room_type,
    create_test_room,
    get_auth_headers,
)


async def _make_hotel_with_rooms(num_rooms: int = 4):
    user = await create_test_user()
    hotel = await create_test_hotel(str(user["id"]))
    room_type = await create_test_room_type(str(hotel["id"]))
    rooms = []
    for i in range(num_rooms):
        rooms.append(
            await create_test_room(
                str(hotel["id"]),
                str(room_type["id"]),
                room_number=f"{200 + i}",
            )
        )
    return user, hotel, rooms


class TestReorderRooms:
    async def test_reorder_persists_new_order(self, client, cleanup_database):
        user, _, rooms = await _make_hotel_with_rooms(4)

        # Reverse order
        new_order = [str(r["id"]) for r in reversed(rooms)]
        resp = await client.patch(
            "/admin/rooms/reorder",
            json={"orderedRoomIds": new_order},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 204

        list_resp = await client.get(
            "/admin/rooms",
            headers=get_auth_headers(user["token"]),
        )
        assert list_resp.status_code == 200
        ids_in_order = [r["id"] for r in list_resp.json()]
        assert ids_in_order == new_order

    async def test_reorder_is_idempotent_on_repeated_save(
        self, client, cleanup_database
    ):
        user, _, rooms = await _make_hotel_with_rooms(3)
        ordered = [str(r["id"]) for r in rooms]

        for _ in range(2):
            resp = await client.patch(
                "/admin/rooms/reorder",
                json={"orderedRoomIds": ordered},
                headers=get_auth_headers(user["token"]),
            )
            assert resp.status_code == 204

        rows = await Database.fetch(
            "SELECT id, sort_order FROM rooms WHERE id = ANY($1::uuid[])",
            ordered,
        )
        sort_orders = sorted(r["sort_order"] for r in rows)
        assert sort_orders == [1, 2, 3]

    async def test_reorder_rejects_partial_list(self, client, cleanup_database):
        user, _, rooms = await _make_hotel_with_rooms(3)

        # Drop the last room from the list
        partial = [str(r["id"]) for r in rooms[:-1]]
        resp = await client.patch(
            "/admin/rooms/reorder",
            json={"orderedRoomIds": partial},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 400

    async def test_reorder_rejects_duplicates(self, client, cleanup_database):
        user, _, rooms = await _make_hotel_with_rooms(3)
        ids = [str(r["id"]) for r in rooms]
        dup = [ids[0], ids[0], ids[1]]

        resp = await client.patch(
            "/admin/rooms/reorder",
            json={"orderedRoomIds": dup},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 400

    async def test_reorder_rejects_foreign_room_id(self, client, cleanup_database):
        user_a, _, rooms_a = await _make_hotel_with_rooms(2)
        _, _, rooms_b = await _make_hotel_with_rooms(1)

        # Caller A tries to slip in a room that belongs to hotel B.
        spoofed = [str(rooms_a[0]["id"]), str(rooms_b[0]["id"])]
        resp = await client.patch(
            "/admin/rooms/reorder",
            json={"orderedRoomIds": spoofed},
            headers=get_auth_headers(user_a["token"]),
        )
        assert resp.status_code == 400

    async def test_reorder_requires_auth(self, client, cleanup_database):
        _, _, rooms = await _make_hotel_with_rooms(2)
        resp = await client.patch(
            "/admin/rooms/reorder",
            json={"orderedRoomIds": [str(r["id"]) for r in rooms]},
        )
        assert resp.status_code in (401, 403)

    async def test_create_room_appends_to_bottom(self, client, cleanup_database):
        user, hotel, rooms = await _make_hotel_with_rooms(3)
        room_type_id = str(rooms[0]["room_type_id"])

        # Save a custom order first.
        ordered = [str(r["id"]) for r in rooms]
        await client.patch(
            "/admin/rooms/reorder",
            json={"orderedRoomIds": ordered},
            headers=get_auth_headers(user["token"]),
        )

        # New room should land at the bottom of the list.
        resp = await client.post(
            "/admin/rooms",
            json={
                "roomTypeId": room_type_id,
                "roomNumber": "999",
            },
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 201

        list_resp = await client.get(
            "/admin/rooms",
            headers=get_auth_headers(user["token"]),
        )
        assert list_resp.status_code == 200
        ids_in_order = [r["id"] for r in list_resp.json()]
        assert ids_in_order[-1] == resp.json()["id"]
