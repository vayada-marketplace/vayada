"""
Tests for room block admin endpoints — POST /admin/room-blocks, DELETE /admin/room-blocks/{id}.
"""
from tests.conftest import (
    create_test_user,
    create_test_hotel,
    create_test_room_type,
    create_test_room_block,
    get_auth_headers,
)


class TestCreateRoomBlock:
    async def test_create_room_block(self, client, hotel_with_rooms):
        """Successfully create a room block."""
        user = hotel_with_rooms["user"]
        room = hotel_with_rooms["room"]

        resp = await client.post(
            "/admin/room-blocks",
            json={
                "roomTypeId": str(room["id"]),
                "startDate": "2026-08-01",
                "endDate": "2026-08-05",
                "blockedCount": 2,
                "reason": "Maintenance",
            },
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 201
        body = resp.json()
        assert body["roomTypeId"] == str(room["id"])
        assert body["startDate"] == "2026-08-01"
        assert body["endDate"] == "2026-08-05"
        assert body["blockedCount"] == 2
        assert body["reason"] == "Maintenance"
        assert "id" in body
        assert "createdAt" in body

    async def test_create_room_block_default_values(self, client, hotel_with_rooms):
        """Room block with default blocked_count=1 and reason=''."""
        user = hotel_with_rooms["user"]
        room = hotel_with_rooms["room"]

        resp = await client.post(
            "/admin/room-blocks",
            json={
                "roomTypeId": str(room["id"]),
                "startDate": "2026-09-01",
                "endDate": "2026-09-03",
            },
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 201
        assert resp.json()["blockedCount"] == 1
        assert resp.json()["reason"] == ""

    async def test_create_room_block_invalid_room(self, client, cleanup_database):
        """Room type that doesn't belong to user → 404."""
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        resp = await client.post(
            "/admin/room-blocks",
            json={
                "roomTypeId": "00000000-0000-0000-0000-000000000000",
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

        resp = await client.post(
            "/admin/room-blocks",
            json={
                "roomTypeId": str(room["id"]),
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

        resp = await client.post(
            "/admin/room-blocks",
            json={
                "roomTypeId": str(room["id"]),
                "startDate": "2026-08-05",
                "endDate": "2026-08-05",
            },
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 400

    async def test_create_room_block_too_many_rooms(self, client, hotel_with_rooms):
        """blocked_count > total_rooms → 400."""
        user = hotel_with_rooms["user"]
        room = hotel_with_rooms["room"]  # total_rooms = 5

        resp = await client.post(
            "/admin/room-blocks",
            json={
                "roomTypeId": str(room["id"]),
                "startDate": "2026-08-01",
                "endDate": "2026-08-05",
                "blockedCount": 10,
            },
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 400

    async def test_create_room_block_zero_rooms(self, client, hotel_with_rooms):
        """blocked_count < 1 → 400."""
        user = hotel_with_rooms["user"]
        room = hotel_with_rooms["room"]

        resp = await client.post(
            "/admin/room-blocks",
            json={
                "roomTypeId": str(room["id"]),
                "startDate": "2026-08-01",
                "endDate": "2026-08-05",
                "blockedCount": 0,
            },
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 400

    async def test_create_room_block_requires_auth(self, client):
        resp = await client.post(
            "/admin/room-blocks",
            json={
                "roomTypeId": "00000000-0000-0000-0000-000000000000",
                "startDate": "2026-08-01",
                "endDate": "2026-08-05",
            },
        )
        assert resp.status_code == 403

    async def test_create_room_block_other_users_room(self, client, hotel_with_rooms):
        """Cannot create block on another user's room type."""
        other_user = await create_test_user()
        await create_test_hotel(str(other_user["id"]))

        room = hotel_with_rooms["room"]
        resp = await client.post(
            "/admin/room-blocks",
            json={
                "roomTypeId": str(room["id"]),
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
