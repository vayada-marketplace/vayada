"""Tests guarding against the bug where Channex bookings for one hotel
landed in another (VAY: stranded Sue Puls / Cornelius Kaufmann incident).

The three invariants under test:
1. A connection without channex_property_id must not be polled.
2. The Channex room-type mapping lookup is hotel-scoped (does not return
   another hotel's mapping just because the channex_room_type_id matches).
3. The booking dedupe lookup is hotel-scoped, and the import path refuses
   to insert a booking when the resolved room_type belongs to a different
   hotel than the polling hotel.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from app.services.channex.inbound import (
    poll_bookings_for_hotel,
    process_inbound_booking,
)

# ── 1. Polling guard ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_poll_skips_when_property_id_is_null():
    """No channex_property_id => no Channex API call (otherwise the feed
    returns revisions for every property in the shared account)."""
    with (
        patch(
            "app.services.channex.inbound.ChannexConnectionRepository.get_by_hotel_id",
            new_callable=AsyncMock,
            return_value={"is_active": True, "channex_property_id": None},
        ),
        patch(
            "app.services.channex.inbound.channex_service.get_booking_revisions_feed",
            new_callable=AsyncMock,
        ) as feed,
    ):
        await poll_bookings_for_hotel("hotel-A")
        feed.assert_not_called()


@pytest.mark.asyncio
async def test_poll_passes_property_id_filter_when_present():
    with (
        patch(
            "app.services.channex.inbound.ChannexConnectionRepository.get_by_hotel_id",
            new_callable=AsyncMock,
            return_value={"is_active": True, "channex_property_id": "prop-A"},
        ),
        patch(
            "app.services.channex.inbound.channex_service.get_platform_api_key",
            return_value="key",
        ),
        patch(
            "app.services.channex.inbound.channex_service.get_booking_revisions_feed",
            new_callable=AsyncMock,
            return_value=[],
        ) as feed,
        patch(
            "app.services.channex.inbound.ChannexConnectionRepository.update_last_booking_sync",
            new_callable=AsyncMock,
        ),
    ):
        await poll_bookings_for_hotel("hotel-A")
        feed.assert_awaited_once()
        # property_id must be propagated so Channex returns only this hotel's revisions
        assert feed.await_args.kwargs.get("property_id") == "prop-A"


# ── 2 & 3. Import path hotel-scope guards ─────────────────────────────


def _revision(channex_room_type_id: str, channex_booking_id: str = "ch-bk-1"):
    return {
        "id": "rev-1",
        "attributes": {
            "booking_id": channex_booking_id,
            "status": "new",
            "ota_name": "airbnb",
            "arrival_date": "2026-10-08",
            "departure_date": "2026-10-12",
            "rooms": [{"room_type_id": channex_room_type_id, "amount": "400"}],
            "customer": {"name": "Sue", "surname": "Puls"},
        },
    }


@pytest.mark.asyncio
async def test_dedupe_lookup_is_hotel_scoped():
    """If hotel A already imported channex_booking_id X, hotel B must still
    be able to query its own namespace and not see it as 'already exists'."""
    rev = _revision("crt-1", channex_booking_id="ch-bk-99")
    with (
        patch(
            "app.services.channex.inbound.ChannexBookingMappingRepository.list_by_channex_id",
            new_callable=AsyncMock,
            return_value=[],
        ) as dedupe,
        patch(
            "app.services.channex.inbound.ChannexRoomTypeMappingRepository.get_by_channex_room_type_id",
            new_callable=AsyncMock,
            return_value=None,  # short-circuit before booking insert
        ),
    ):
        await process_inbound_booking(rev, "hotel-B")
        dedupe.assert_awaited_once_with("hotel-B", "ch-bk-99")


@pytest.mark.asyncio
async def test_room_mapping_lookup_is_hotel_scoped():
    """The mapping lookup must be queried with (hotel_id, channex_room_type_id),
    not channex_room_type_id alone — otherwise it would return another hotel's
    mapping."""
    rev = _revision("crt-shared")
    with (
        patch(
            "app.services.channex.inbound.ChannexBookingMappingRepository.list_by_channex_id",
            new_callable=AsyncMock,
            return_value=[],
        ),
        patch(
            "app.services.channex.inbound.ChannexRoomTypeMappingRepository.get_by_channex_room_type_id",
            new_callable=AsyncMock,
            return_value=None,
        ) as get_mapping,
    ):
        await process_inbound_booking(rev, "hotel-B")
        get_mapping.assert_awaited_once_with("hotel-B", "crt-shared")


@pytest.mark.asyncio
async def test_import_refuses_when_room_type_belongs_to_other_hotel():
    """Belt-and-suspenders: even if a stale mapping somehow points at a
    foreign room_type, the import must refuse to insert a misattributed
    booking."""
    rev = _revision("crt-1")
    with (
        patch(
            "app.services.channex.inbound.ChannexBookingMappingRepository.list_by_channex_id",
            new_callable=AsyncMock,
            return_value=[],
        ),
        patch(
            "app.services.channex.inbound.ChannexRoomTypeMappingRepository.get_by_channex_room_type_id",
            new_callable=AsyncMock,
            return_value={"room_type_id": "rt-1"},
        ),
        patch(
            "app.services.channex.inbound.RoomTypeRepository.get_by_id",
            new_callable=AsyncMock,
            return_value={"id": "rt-1", "hotel_id": "hotel-VillaSava", "currency": "IDR"},
        ),
        patch(
            "app.services.channex.inbound.BookingRepository.create",
            new_callable=AsyncMock,
        ) as create,
    ):
        # Polling hotel is Kalima, but the resolved room_type belongs to Villa Sava.
        await process_inbound_booking(rev, "hotel-Kalima")
        # No booking row may be inserted.
        create.assert_not_called()


@pytest.mark.asyncio
async def test_import_proceeds_when_hotels_match():
    """Sanity: when room_type.hotel_id == polling hotel_id, the booking is
    created normally."""
    rev = _revision("crt-1")
    create_mock = AsyncMock(return_value={"id": "booking-1"})
    with (
        patch(
            "app.services.channex.inbound.ChannexBookingMappingRepository.list_by_channex_id",
            new_callable=AsyncMock,
            return_value=[],
        ),
        patch(
            "app.services.channex.inbound.ChannexRoomTypeMappingRepository.get_by_channex_room_type_id",
            new_callable=AsyncMock,
            return_value={"room_type_id": "rt-1"},
        ),
        patch(
            "app.services.channex.inbound.RoomTypeRepository.get_by_id",
            new_callable=AsyncMock,
            return_value={"id": "rt-1", "hotel_id": "hotel-A", "currency": "IDR"},
        ),
        patch(
            # Auto-rearrange path: stub to "no fit, no moves" so we land on the
            # same behavior the legacy `Database.fetchrow=None` stub produced.
            "app.services.channex.inbound.resolve_assignment",
            new_callable=AsyncMock,
            return_value=(None, []),
        ),
        patch(
            "app.services.channex.inbound.BookingRepository.create",
            new=create_mock,
        ),
        patch(
            "app.services.channex.inbound.ChannexBookingMappingRepository.create",
            new_callable=AsyncMock,
        ),
        patch(
            "app.services.channex.inbound.push_availability_for_room_type",
            new_callable=AsyncMock,
        ),
    ):
        await process_inbound_booking(rev, "hotel-A")
        create_mock.assert_awaited_once()
        booking_data = create_mock.await_args.args[0]
        assert booking_data["hotel_id"] == "hotel-A"
        assert booking_data["room_type_id"] == "rt-1"
