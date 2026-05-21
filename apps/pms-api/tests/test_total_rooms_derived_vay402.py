"""
VAY-402: room_types.total_rooms is a derived mirror of COUNT(rooms).

Regression coverage for the bug where total_rooms could be set higher than
the number of physical room instances — inflating availability everywhere
and letting a guest complete checkout for a room that can't be assigned,
only to fail at the payment step.
"""

import pytest
from app.database import Database

from tests.conftest import (
    create_test_hotel,
    create_test_room,
    create_test_room_block,
    create_test_room_type,
    create_test_user,
    get_auth_headers,
)


async def _total_rooms(room_type_id: str) -> int:
    return await Database.fetchval("SELECT total_rooms FROM room_types WHERE id = $1", room_type_id)


class TestTotalRoomsDerived:
    async def test_trigger_tracks_room_inserts_and_deletes(self, client, cleanup_database):
        """The migration-074 trigger keeps total_rooms == COUNT(rooms)
        regardless of the stale value the row was created with."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        # Deliberately stale starting value — no physical rooms exist yet.
        room = await create_test_room_type(str(hotel["id"]), total_rooms=99)

        r1 = await create_test_room(str(hotel["id"]), str(room["id"]), room_number="A1")
        await create_test_room(str(hotel["id"]), str(room["id"]), room_number="A2")
        await create_test_room(str(hotel["id"]), str(room["id"]), room_number="A3")
        assert await _total_rooms(str(room["id"])) == 3

        await Database.execute("DELETE FROM rooms WHERE id = $1", str(r1["id"]))
        assert await _total_rooms(str(room["id"])) == 2

    async def test_patch_cannot_inflate_total_rooms(self, client, cleanup_database):
        """The Rooms & Rates edit form can no longer push total_rooms above
        the real room count — the field is stripped server-side."""
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))
        headers = get_auth_headers(user["token"])

        create_resp = await client.post(
            "/admin/room-types",
            json={
                "name": "Pool Villa",
                "baseRate": 200.0,
                "maxOccupancy": 4,
                "totalRooms": 6,
            },
            headers=headers,
        )
        assert create_resp.status_code == 201
        rt_id = create_resp.json()["id"]
        assert create_resp.json()["totalRooms"] == 6  # 6 rooms auto-created

        patch_resp = await client.patch(
            f"/admin/room-types/{rt_id}",
            json={"totalRooms": 7},
            headers=headers,
        )
        assert patch_resp.status_code == 200
        # The inflate attempt is ignored — value stays the real room count.
        assert patch_resp.json()["totalRooms"] == 6
        assert await _total_rooms(rt_id) == 6

    @pytest.mark.parametrize("payment_method", ["card", "pay_at_property"])
    async def test_all_rooms_blocked_is_sold_out_and_rejects_booking(
        self, client, cleanup_database, payment_method
    ):
        """The reported repro: every physical room blocked. The room type
        must read Sold Out (remainingRooms == 0, no phantom extra room) and
        the booking POST must fail cleanly with a 400 before any charge —
        never a silent oversell or an unhandled 422 at payment."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        # Stale value (1) — trigger raises it to the real count once the
        # six physical rooms are inserted below.
        room = await create_test_room_type(str(hotel["id"]), total_rooms=1)
        for i in range(6):
            await create_test_room(str(hotel["id"]), str(room["id"]), room_number=f"PV{i}")
        assert await _total_rooms(str(room["id"])) == 6

        # Every physical room blocked across the stay window.
        await create_test_room_block(
            str(hotel["id"]),
            str(room["id"]),
            start_date="2026-09-01",
            end_date="2026-09-05",
            blocked_count=6,
        )

        rooms_resp = await client.get(
            f"/api/hotels/{hotel['slug']}/rooms",
            params={"check_in": "2026-09-02", "check_out": "2026-09-04"},
        )
        assert rooms_resp.status_code == 200
        assert rooms_resp.json()[0]["remainingRooms"] == 0

        booking_resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings",
            json={
                "roomTypeId": str(room["id"]),
                "guestFirstName": "Jane",
                "guestLastName": "Smith",
                "guestEmail": "jane@example.com",
                "guestPhone": "+9876543210",
                "checkIn": "2026-09-02",
                "checkOut": "2026-09-04",
                "adults": 2,
                "paymentMethod": payment_method,
            },
        )
        assert booking_resp.status_code == 400
        assert "available" in booking_resp.json()["detail"].lower()
