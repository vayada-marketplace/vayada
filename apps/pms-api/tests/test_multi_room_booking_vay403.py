"""Multi-room booking integrity (VAY-403).

A multi-room reservation ("2× Two-Bedroom Pool Villa") must persist its
quantity, block one physical room per booked room, count its full footprint
against inventory, and surface every assigned room downstream. Before the
fix only the first room was blocked — the rest stayed open for sale.
"""

from datetime import date

from app.database import Database
from app.repositories.booking_repo import BookingRepository
from app.repositories.booking_room_repo import BookingRoomRepository
from app.repositories.room_type_repo import RoomTypeRepository
from app.services.availability_service import remaining_for_stay
from app.services.room_assignment import resolve_room_assignments

from tests.conftest import get_auth_headers


def _booking_payload(hotel_id, room_type_id, rooms, **over):
    base = {
        "hotel_id": hotel_id,
        "room_type_id": room_type_id,
        "guest_first_name": "Group",
        "guest_last_name": "Booker",
        "guest_email": "pmstest-multiroom@example.com",
        "guest_phone": "+1234567890",
        "check_in": date(2026, 6, 17),
        "check_out": date(2026, 6, 20),
        "adults": 4,
        "children": 2,
        "nightly_rate": 213.0,
        "total_amount": 213.0 * 3 * 2,
        "currency": "EUR",
        "status": "confirmed",
        "number_of_rooms": 2,
        "room_id": rooms[0]["id"],
        "extra_room_ids": [str(rooms[1]["id"])],
    }
    base.update(over)
    return base


class TestPersistence:
    async def test_create_persists_quantity_and_extra_rooms(self, hotel_with_rooms):
        hotel = hotel_with_rooms["hotel"]
        rt = hotel_with_rooms["room"]
        rooms = hotel_with_rooms["rooms"]

        booking = await BookingRepository.create(
            _booking_payload(str(hotel["id"]), str(rt["id"]), rooms)
        )

        # Quantity must survive the INSERT (previously dropped -> always 1).
        fresh = await BookingRepository.get_by_id(str(booking["id"]))
        assert fresh["number_of_rooms"] == 2

        # The second room is recorded as an extra slot, not lost.
        extras = await BookingRoomRepository.list_extra_rooms(str(booking["id"]))
        assert [str(e["room_id"]) for e in extras] == [str(rooms[1]["id"])]
        assert extras[0]["position"] == 1

    async def test_single_room_booking_writes_no_extras(self, hotel_with_rooms):
        hotel = hotel_with_rooms["hotel"]
        rt = hotel_with_rooms["room"]
        rooms = hotel_with_rooms["rooms"]

        booking = await BookingRepository.create(
            _booking_payload(
                str(hotel["id"]),
                str(rt["id"]),
                rooms,
                number_of_rooms=1,
                extra_room_ids=[],
            )
        )
        extras = await BookingRoomRepository.list_extra_rooms(str(booking["id"]))
        assert extras == []


class TestInventoryMath:
    async def test_count_booked_sums_quantity(self, hotel_with_rooms):
        hotel = hotel_with_rooms["hotel"]
        rt = hotel_with_rooms["room"]
        rooms = hotel_with_rooms["rooms"]

        await BookingRepository.create(_booking_payload(str(hotel["id"]), str(rt["id"]), rooms))

        # Two physical rooms consumed by one 2-room booking — not one row.
        booked = await RoomTypeRepository.count_booked(
            str(rt["id"]), date(2026, 6, 18), date(2026, 6, 19)
        )
        assert booked == 2

        # total_rooms is 5, so a 2-room booking leaves 3 sellable.
        remaining = await remaining_for_stay(
            str(rt["id"]), rt["total_rooms"], date(2026, 6, 18), date(2026, 6, 19)
        )
        assert remaining == 3

    async def test_cancellation_releases_every_room(self, hotel_with_rooms):
        hotel = hotel_with_rooms["hotel"]
        rt = hotel_with_rooms["room"]
        rooms = hotel_with_rooms["rooms"]

        booking = await BookingRepository.create(
            _booking_payload(str(hotel["id"]), str(rt["id"]), rooms)
        )
        await BookingRepository.update_status(str(booking["id"]), "cancelled")

        booked = await RoomTypeRepository.count_booked(
            str(rt["id"]), date(2026, 6, 18), date(2026, 6, 19)
        )
        assert booked == 0


class TestAssignment:
    async def test_resolve_picks_distinct_free_rooms(self, hotel_with_rooms):
        hotel = hotel_with_rooms["hotel"]
        rt = hotel_with_rooms["room"]
        rooms = hotel_with_rooms["rooms"]

        # rooms[0] is taken across the window; the picker must skip it and
        # return two *different* free rooms for a 2-room booking.
        await BookingRepository.create(
            _booking_payload(
                str(hotel["id"]),
                str(rt["id"]),
                rooms,
                number_of_rooms=1,
                extra_room_ids=[],
                guest_email="pmstest-occupant@example.com",
            )
        )

        primary, extras, moves = await resolve_room_assignments(
            str(hotel["id"]),
            str(rt["id"]),
            date(2026, 6, 17),
            date(2026, 6, 20),
            2,
        )
        assert moves == []
        chosen = [primary, *extras]
        assert len(chosen) == 2
        assert len(set(chosen)) == 2
        assert str(rooms[0]["id"]) not in chosen

    async def test_single_room_path_unchanged(self, hotel_with_rooms):
        hotel = hotel_with_rooms["hotel"]
        rt = hotel_with_rooms["room"]

        primary, extras, _ = await resolve_room_assignments(
            str(hotel["id"]),
            str(rt["id"]),
            date(2026, 6, 17),
            date(2026, 6, 20),
            1,
        )
        assert primary is not None
        assert extras == []


class TestReadSurfaces:
    async def test_calendar_blocks_every_assigned_room(self, hotel_with_rooms):
        data = hotel_with_rooms
        hotel, rt, rooms, user = (data["hotel"], data["room"], data["rooms"], data["user"])
        booking = await BookingRepository.create(
            _booking_payload(str(hotel["id"]), str(rt["id"]), rooms)
        )

        resp = await _calendar(user)
        entries = [
            b for b in resp["bookings"] if b["bookingReference"] == booking["booking_reference"]
        ]
        # One calendar entry per physical room, both linked by reference.
        assert len(entries) == 2
        assert {e["roomId"] for e in entries} == {str(rooms[0]["id"]), str(rooms[1]["id"])}
        assert all(e["numberOfRooms"] == 2 for e in entries)
        assert {e["roomPosition"] for e in entries} == {0, 1}

    async def test_booking_detail_lists_all_rooms(self, client, hotel_with_rooms):
        data = hotel_with_rooms
        hotel, rt, rooms, user = (data["hotel"], data["room"], data["rooms"], data["user"])
        booking = await BookingRepository.create(
            _booking_payload(str(hotel["id"]), str(rt["id"]), rooms)
        )

        resp = await client.get(
            f"/admin/bookings/{booking['id']}",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["numberOfRooms"] == 2
        positions = sorted(r["position"] for r in body["assignedRooms"])
        assert positions == [0, 1]
        room_ids = {r["roomId"] for r in body["assignedRooms"]}
        assert room_ids == {str(rooms[0]["id"]), str(rooms[1]["id"])}


async def _calendar(user):
    """Hit GET /admin/calendar through the ASGI app for `user`."""
    from app.main import app
    from httpx import ASGITransport, AsyncClient

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.get(
            "/admin/calendar?start=2026-06-01&end=2026-07-01",
            headers=get_auth_headers(user["token"]),
        )
    assert resp.status_code == 200
    return resp.json()
