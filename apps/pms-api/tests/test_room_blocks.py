"""
Tests for room block admin endpoints — POST /admin/room-blocks, DELETE /admin/room-blocks/{id}.
"""
from tests.conftest import (
    create_test_user,
    create_test_hotel,
    create_test_room_type,
    create_test_room,
    create_test_room_block,
    get_auth_headers,
)


class TestCreateRoomBlock:
    async def test_create_room_block(self, client, hotel_with_rooms):
        """Successfully create a room block for two specific rooms."""
        user = hotel_with_rooms["user"]
        room = hotel_with_rooms["room"]
        rooms = hotel_with_rooms["rooms"]

        resp = await client.post(
            "/admin/room-blocks",
            json={
                "roomTypeId": str(room["id"]),
                "roomIds": [str(rooms[0]["id"]), str(rooms[1]["id"])],
                "startDate": "2026-08-01",
                "endDate": "2026-08-05",
                "reason": "Maintenance",
            },
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 201
        body = resp.json()
        assert isinstance(body, list)
        assert len(body) == 2
        for b in body:
            assert b["roomTypeId"] == str(room["id"])
            assert b["startDate"] == "2026-08-01"
            assert b["endDate"] == "2026-08-05"
            assert b["blockedCount"] == 1
            assert b["reason"] == "Maintenance"
            assert b["roomId"] in {str(rooms[0]["id"]), str(rooms[1]["id"])}
            assert b["roomNumber"] is not None
            assert "id" in b
            assert "createdAt" in b

    async def test_create_room_block_single_room(self, client, hotel_with_rooms):
        """Block a single room; default reason is empty."""
        user = hotel_with_rooms["user"]
        room = hotel_with_rooms["room"]
        rooms = hotel_with_rooms["rooms"]

        resp = await client.post(
            "/admin/room-blocks",
            json={
                "roomTypeId": str(room["id"]),
                "roomIds": [str(rooms[0]["id"])],
                "startDate": "2026-09-01",
                "endDate": "2026-09-03",
            },
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 201
        body = resp.json()
        assert len(body) == 1
        assert body[0]["blockedCount"] == 1
        assert body[0]["reason"] == ""

    async def test_create_room_block_invalid_room_type(self, client, cleanup_database):
        """Room type that doesn't belong to user → 404."""
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        resp = await client.post(
            "/admin/room-blocks",
            json={
                "roomTypeId": "00000000-0000-0000-0000-000000000000",
                "roomIds": ["00000000-0000-0000-0000-000000000000"],
                "startDate": "2026-08-01",
                "endDate": "2026-08-05",
            },
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 404

    async def test_create_room_block_end_before_start(self, client, hotel_with_rooms):
        """end_date <= start_date → 400."""
        user = hotel_with_rooms["user"]
        room = hotel_with_rooms["room"]
        rooms = hotel_with_rooms["rooms"]

        resp = await client.post(
            "/admin/room-blocks",
            json={
                "roomTypeId": str(room["id"]),
                "roomIds": [str(rooms[0]["id"])],
                "startDate": "2026-08-05",
                "endDate": "2026-08-01",
            },
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 400

    async def test_create_room_block_same_dates(self, client, hotel_with_rooms):
        """end_date == start_date → 400."""
        user = hotel_with_rooms["user"]
        room = hotel_with_rooms["room"]
        rooms = hotel_with_rooms["rooms"]

        resp = await client.post(
            "/admin/room-blocks",
            json={
                "roomTypeId": str(room["id"]),
                "roomIds": [str(rooms[0]["id"])],
                "startDate": "2026-08-05",
                "endDate": "2026-08-05",
            },
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 400

    async def test_create_room_block_empty_room_ids(self, client, hotel_with_rooms):
        """Empty roomIds list → 422 (pydantic min_length)."""
        user = hotel_with_rooms["user"]
        room = hotel_with_rooms["room"]

        resp = await client.post(
            "/admin/room-blocks",
            json={
                "roomTypeId": str(room["id"]),
                "roomIds": [],
                "startDate": "2026-08-01",
                "endDate": "2026-08-05",
            },
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 422

    async def test_create_room_block_wrong_room_type(self, client, hotel_with_rooms):
        """A room_id that doesn't belong to the given room type → 400."""
        user = hotel_with_rooms["user"]
        hotel = hotel_with_rooms["hotel"]
        room = hotel_with_rooms["room"]

        other_type = await create_test_room_type(
            str(hotel["id"]), name="Standard Room", total_rooms=2
        )
        other_room = await create_test_room(
            str(hotel["id"]), str(other_type["id"]), room_number="999"
        )

        resp = await client.post(
            "/admin/room-blocks",
            json={
                "roomTypeId": str(room["id"]),
                "roomIds": [str(other_room["id"])],
                "startDate": "2026-08-01",
                "endDate": "2026-08-05",
            },
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 400

    async def test_create_room_block_per_room_conflict(self, client, hotel_with_rooms):
        """Blocking a room that already has an overlapping block → 400."""
        user = hotel_with_rooms["user"]
        hotel = hotel_with_rooms["hotel"]
        room = hotel_with_rooms["room"]
        rooms = hotel_with_rooms["rooms"]

        await create_test_room_block(
            str(hotel["id"]),
            str(room["id"]),
            start_date="2026-08-01",
            end_date="2026-08-05",
            room_id=str(rooms[0]["id"]),
        )

        resp = await client.post(
            "/admin/room-blocks",
            json={
                "roomTypeId": str(room["id"]),
                "roomIds": [str(rooms[0]["id"])],
                "startDate": "2026-08-03",
                "endDate": "2026-08-07",
            },
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 400

    async def test_create_room_block_requires_auth(self, client):
        resp = await client.post(
            "/admin/room-blocks",
            json={
                "roomTypeId": "00000000-0000-0000-0000-000000000000",
                "roomIds": ["00000000-0000-0000-0000-000000000000"],
                "startDate": "2026-08-01",
                "endDate": "2026-08-05",
            },
        )
        assert resp.status_code == 401

    async def test_create_room_block_other_users_room(self, client, hotel_with_rooms):
        """Cannot create block on another user's room type."""
        other_user = await create_test_user()
        await create_test_hotel(str(other_user["id"]))

        room = hotel_with_rooms["room"]
        rooms = hotel_with_rooms["rooms"]
        resp = await client.post(
            "/admin/room-blocks",
            json={
                "roomTypeId": str(room["id"]),
                "roomIds": [str(rooms[0]["id"])],
                "startDate": "2026-08-01",
                "endDate": "2026-08-05",
            },
            headers=get_auth_headers(other_user["token"]),
        )
        assert resp.status_code == 404


class TestDeleteRoomBlock:
    async def test_delete_room_block(self, client, cleanup_database):
        """Successfully delete a room block."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        block = await create_test_room_block(str(hotel["id"]), str(room["id"]))

        resp = await client.delete(
            f"/admin/room-blocks/{block['id']}",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 204

    async def test_delete_room_block_not_found(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        resp = await client.delete(
            "/admin/room-blocks/00000000-0000-0000-0000-000000000000",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 404

    async def test_delete_room_block_other_user(self, client, cleanup_database):
        """Cannot delete another user's room block."""
        user_a = await create_test_user()
        hotel_a = await create_test_hotel(str(user_a["id"]))
        room_a = await create_test_room_type(str(hotel_a["id"]))
        block = await create_test_room_block(str(hotel_a["id"]), str(room_a["id"]))

        user_b = await create_test_user()
        await create_test_hotel(str(user_b["id"]))

        resp = await client.delete(
            f"/admin/room-blocks/{block['id']}",
            headers=get_auth_headers(user_b["token"]),
        )
        assert resp.status_code == 404
