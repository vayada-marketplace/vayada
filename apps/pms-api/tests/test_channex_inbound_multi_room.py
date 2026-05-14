"""Tests for multi-room Channex booking import (VAY-392).

A Booking.com (or other OTA) reservation that contains multiple rooms is
delivered by Channex as a single revision with a ``rooms[]`` array of N
entries. The import must materialize one PMS booking row per room — taking
only ``rooms[0]`` would leave the other rooms unblocked and open the
property to silent double-bookings.
"""
import pytest
from unittest.mock import AsyncMock, patch

from app.services.channex.inbound import process_inbound_booking


def _multi_room_revision(
    *,
    channex_booking_id: str = "ch-bk-multi",
    rooms: list[dict] | None = None,
    status: str = "new",
    arrival: str = "2026-07-10",
    departure: str = "2026-07-12",
):
    return {
        "id": "rev-multi-1",
        "attributes": {
            "booking_id": channex_booking_id,
            "status": status,
            "ota_name": "booking.com",
            "arrival_date": arrival,
            "departure_date": departure,
            "rooms": rooms or [],
            "customer": {"name": "Kim", "surname": "Van Gestel"},
        },
    }


def _room(room_type_id: str, amount: str = "200.00", adults: int = 2) -> dict:
    return {
        "room_type_id": room_type_id,
        "amount": amount,
        "occupancy": {"adults": adults, "children": 0},
    }


@pytest.mark.asyncio
async def test_two_rooms_same_type_create_two_bookings():
    """The headline bug: a Booking.com reservation with 2 rooms of the same
    type must produce 2 PMS bookings, each mapped to a distinct slot index."""
    rev = _multi_room_revision(rooms=[_room("crt-1"), _room("crt-1")])
    created = []
    mappings = []
    booking_counter = {"n": 0}

    async def fake_create(data):
        booking_counter["n"] += 1
        booking = {"id": f"booking-{booking_counter['n']}", **data}
        created.append(booking)
        return booking

    async def fake_create_mapping(**kwargs):
        mappings.append(kwargs)
        return kwargs

    with patch(
        "app.services.channex.inbound.ChannexBookingMappingRepository.list_by_channex_id",
        new_callable=AsyncMock,
        return_value=[],
    ), patch(
        "app.services.channex.inbound.ChannexRoomTypeMappingRepository.get_by_channex_room_type_id",
        new_callable=AsyncMock,
        return_value={"room_type_id": "rt-1"},
    ), patch(
        "app.services.channex.inbound.RoomTypeRepository.get_by_id",
        new_callable=AsyncMock,
        return_value={"id": "rt-1", "hotel_id": "hotel-A", "currency": "IDR"},
    ), patch(
        # No available physical room and no rearrange possible — skip room_id
        # assignment. The legacy stub was `Database.fetchrow=None`; the new
        # auto-rearrange path goes through `resolve_assignment` instead.
        "app.services.channex.inbound.resolve_assignment",
        new_callable=AsyncMock,
        return_value=(None, []),
    ), patch(
        "app.services.channex.inbound.BookingRepository.create",
        new=fake_create,
    ), patch(
        "app.services.channex.inbound.ChannexBookingMappingRepository.create",
        new=fake_create_mapping,
    ), patch(
        "app.services.channex.inbound.push_availability_for_room_type",
        new_callable=AsyncMock,
    ):
        await process_inbound_booking(rev, "hotel-A")

    # Two PMS booking rows created.
    assert len(created) == 2
    assert all(b["room_type_id"] == "rt-1" for b in created)
    assert all(b["hotel_id"] == "hotel-A" for b in created)

    # Two mapping rows, one per slot index, all under the same Channex ID.
    assert len(mappings) == 2
    assert {m["channex_room_index"] for m in mappings} == {0, 1}
    assert {m["channex_booking_id"] for m in mappings} == {"ch-bk-multi"}


@pytest.mark.asyncio
async def test_two_rooms_different_types_resolve_each_independently():
    """Mixed-type multi-room booking: each room slot resolves its own
    room_type and creates a booking for it."""
    rev = _multi_room_revision(rooms=[_room("crt-A"), _room("crt-B")])

    async def fake_get_mapping(hotel_id, channex_room_type_id):
        return {
            "crt-A": {"room_type_id": "rt-A"},
            "crt-B": {"room_type_id": "rt-B"},
        }[channex_room_type_id]

    async def fake_get_room_type(room_type_id):
        return {
            "rt-A": {"id": "rt-A", "hotel_id": "hotel-A", "currency": "IDR"},
            "rt-B": {"id": "rt-B", "hotel_id": "hotel-A", "currency": "IDR"},
        }[room_type_id]

    created = []

    async def fake_create(data):
        created.append(data)
        return {"id": f"booking-{len(created)}", **data}

    with patch(
        "app.services.channex.inbound.ChannexBookingMappingRepository.list_by_channex_id",
        new_callable=AsyncMock,
        return_value=[],
    ), patch(
        "app.services.channex.inbound.ChannexRoomTypeMappingRepository.get_by_channex_room_type_id",
        new=fake_get_mapping,
    ), patch(
        "app.services.channex.inbound.RoomTypeRepository.get_by_id",
        new=fake_get_room_type,
    ), patch(
        "app.services.channex.inbound.resolve_assignment",
        new_callable=AsyncMock,
        return_value=(None, []),
    ), patch(
        "app.services.channex.inbound.BookingRepository.create",
        new=fake_create,
    ), patch(
        "app.services.channex.inbound.ChannexBookingMappingRepository.create",
        new_callable=AsyncMock,
    ), patch(
        "app.services.channex.inbound.push_availability_for_room_type",
        new_callable=AsyncMock,
    ):
        await process_inbound_booking(rev, "hotel-A")

    assert len(created) == 2
    assert {b["room_type_id"] for b in created} == {"rt-A", "rt-B"}


@pytest.mark.asyncio
async def test_single_room_booking_unchanged_regression_guard():
    """Backwards-compatibility: a single-room revision still produces exactly
    one PMS booking — no behavioural drift for the common case."""
    rev = _multi_room_revision(rooms=[_room("crt-1")])
    create_mock = AsyncMock(return_value={"id": "booking-1"})

    with patch(
        "app.services.channex.inbound.ChannexBookingMappingRepository.list_by_channex_id",
        new_callable=AsyncMock,
        return_value=[],
    ), patch(
        "app.services.channex.inbound.ChannexRoomTypeMappingRepository.get_by_channex_room_type_id",
        new_callable=AsyncMock,
        return_value={"room_type_id": "rt-1"},
    ), patch(
        "app.services.channex.inbound.RoomTypeRepository.get_by_id",
        new_callable=AsyncMock,
        return_value={"id": "rt-1", "hotel_id": "hotel-A", "currency": "IDR"},
    ), patch(
        "app.services.channex.inbound.resolve_assignment",
        new_callable=AsyncMock,
        return_value=(None, []),
    ), patch(
        "app.services.channex.inbound.BookingRepository.create",
        new=create_mock,
    ), patch(
        "app.services.channex.inbound.ChannexBookingMappingRepository.create",
        new_callable=AsyncMock,
    ) as mapping_create, patch(
        "app.services.channex.inbound.push_availability_for_room_type",
        new_callable=AsyncMock,
    ):
        await process_inbound_booking(rev, "hotel-A")

    create_mock.assert_awaited_once()
    mapping_create.assert_awaited_once()
    assert mapping_create.await_args.kwargs["channex_room_index"] == 0


@pytest.mark.asyncio
async def test_cancellation_cancels_every_linked_pms_booking():
    """When the OTA reservation is cancelled, every linked PMS booking row
    must be flipped to ``cancelled`` — not just the first one."""
    rev = _multi_room_revision(
        rooms=[_room("crt-1"), _room("crt-1")], status="cancelled"
    )
    existing = [
        {"booking_id": "b-1", "channex_room_index": 0,
         "hotel_id": "hotel-A", "channex_booking_id": "ch-bk-multi"},
        {"booking_id": "b-2", "channex_room_index": 1,
         "hotel_id": "hotel-A", "channex_booking_id": "ch-bk-multi"},
    ]

    async def fake_get_by_id(booking_id):
        return {
            "id": booking_id, "status": "confirmed", "room_type_id": "rt-1",
            "check_in": "2026-07-10", "check_out": "2026-07-12",
        }

    cancelled = []

    async def fake_update_status(booking_id, new_status):
        cancelled.append((booking_id, new_status))
        return {}

    with patch(
        "app.services.channex.inbound.ChannexBookingMappingRepository.list_by_channex_id",
        new_callable=AsyncMock,
        return_value=existing,
    ), patch(
        "app.services.channex.inbound.BookingRepository.get_by_id",
        new=fake_get_by_id,
    ), patch(
        "app.services.channex.inbound.BookingRepository.update_status",
        new=fake_update_status,
    ), patch(
        "app.services.channex.inbound.ChannexBookingMappingRepository.update_sync_time",
        new_callable=AsyncMock,
    ), patch(
        "app.services.channex.inbound.push_availability_for_room_type",
        new_callable=AsyncMock,
    ), patch(
        "app.services.channex.inbound._maybe_notify_ota_booking",
        new_callable=AsyncMock,
    ):
        await process_inbound_booking(rev, "hotel-A")

    assert sorted(cancelled) == [("b-1", "cancelled"), ("b-2", "cancelled")]


@pytest.mark.asyncio
async def test_modification_with_reduced_room_count_cancels_trailing_slot():
    """Guest reduces from 2 rooms to 1 → the slot-0 booking is updated, and
    the slot-1 booking is cancelled. Sibling slots are not silently dropped."""
    rev = _multi_room_revision(
        rooms=[_room("crt-1", amount="220.00")], status="modified"
    )
    existing = [
        {"booking_id": "b-1", "channex_room_index": 0,
         "hotel_id": "hotel-A", "channex_booking_id": "ch-bk-multi"},
        {"booking_id": "b-2", "channex_room_index": 1,
         "hotel_id": "hotel-A", "channex_booking_id": "ch-bk-multi"},
    ]

    from datetime import date as _date

    async def fake_get_by_id(booking_id):
        return {
            "id": booking_id, "status": "confirmed", "room_type_id": "rt-1",
            "check_in": _date(2026, 7, 10), "check_out": _date(2026, 7, 12),
        }

    update_calls = []
    status_calls = []

    async def fake_execute(sql, *args):
        update_calls.append((sql, args))

    async def fake_update_status(booking_id, new_status):
        status_calls.append((booking_id, new_status))
        return {}

    with patch(
        "app.services.channex.inbound.ChannexBookingMappingRepository.list_by_channex_id",
        new_callable=AsyncMock,
        return_value=existing,
    ), patch(
        "app.services.channex.inbound.BookingRepository.get_by_id",
        new=fake_get_by_id,
    ), patch(
        "app.services.channex.inbound.BookingRepository.update_status",
        new=fake_update_status,
    ), patch(
        "app.services.channex.inbound.Database.execute",
        new=fake_execute,
    ), patch(
        "app.services.channex.inbound.ChannexBookingMappingRepository.update_sync_time",
        new_callable=AsyncMock,
    ), patch(
        "app.services.channex.inbound.push_availability_for_room_type",
        new_callable=AsyncMock,
    ), patch(
        "app.services.channex.inbound._maybe_notify_ota_booking",
        new_callable=AsyncMock,
    ):
        await process_inbound_booking(rev, "hotel-A")

    # Slot 0 received an UPDATE (modification applied).
    assert any("UPDATE bookings" in sql for sql, _ in update_calls)
    # Slot 1 was cancelled because it no longer exists in the revision.
    assert status_calls == [("b-2", "cancelled")]


@pytest.mark.asyncio
async def test_per_room_amount_used_when_present():
    """Channex usually puts the price per room on each ``rooms[]`` entry;
    each PMS booking should reflect its own slot's amount, not the booking
    total split evenly."""
    rev = _multi_room_revision(
        rooms=[_room("crt-1", amount="300.00"), _room("crt-1", amount="500.00")],
    )
    created = []

    async def fake_create(data):
        created.append(data)
        return {"id": f"booking-{len(created)}", **data}

    with patch(
        "app.services.channex.inbound.ChannexBookingMappingRepository.list_by_channex_id",
        new_callable=AsyncMock,
        return_value=[],
    ), patch(
        "app.services.channex.inbound.ChannexRoomTypeMappingRepository.get_by_channex_room_type_id",
        new_callable=AsyncMock,
        return_value={"room_type_id": "rt-1"},
    ), patch(
        "app.services.channex.inbound.RoomTypeRepository.get_by_id",
        new_callable=AsyncMock,
        return_value={"id": "rt-1", "hotel_id": "hotel-A", "currency": "IDR"},
    ), patch(
        "app.services.channex.inbound.resolve_assignment",
        new_callable=AsyncMock,
        return_value=(None, []),
    ), patch(
        "app.services.channex.inbound.BookingRepository.create",
        new=fake_create,
    ), patch(
        "app.services.channex.inbound.ChannexBookingMappingRepository.create",
        new_callable=AsyncMock,
    ), patch(
        "app.services.channex.inbound.push_availability_for_room_type",
        new_callable=AsyncMock,
    ):
        await process_inbound_booking(rev, "hotel-A")

    assert [b["total_amount"] for b in created] == [300.0, 500.0]
