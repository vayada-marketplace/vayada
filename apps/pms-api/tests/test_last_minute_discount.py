"""Unit tests for resolve_last_minute_discount.

Pins the contract that the hotel-level ``enabled`` flag is the master switch
(VAY-316: per-room configs were bypassing the hotel toggle).
"""

import math
from datetime import date

import pytest
from app.models.booking import BookingCreate
from app.services import booking_service, room_type_service
from app.services.availability_service import compute_non_refundable_rate, compute_stay_pricing
from app.services.room_type_service import resolve_last_minute_discount

HOTEL_ON = {
    "enabled": True,
    "tiers": [
        {"daysBeforeMin": 0, "daysBeforeMax": 2, "discountPercent": 30},
        {"daysBeforeMin": 3, "daysBeforeMax": 6, "discountPercent": 20},
        {"daysBeforeMin": 7, "daysBeforeMax": 13, "discountPercent": 10},
    ],
}
HOTEL_OFF = {**HOTEL_ON, "enabled": False}


class TestResolveLastMinuteDiscount:
    def test_hotel_off_no_room_returns_none(self):
        assert resolve_last_minute_discount(HOTEL_OFF, None, days_before=1) is None

    def test_hotel_missing_returns_none(self):
        assert resolve_last_minute_discount(None, None, days_before=1) is None

    def test_hotel_off_room_enabled_true_returns_none(self):
        # Regression for VAY-316: a stale per-room enabled=true must not
        # bypass the hotel-level master toggle.
        room_cfg = {
            "enabled": True,
            "tiers": [{"daysBeforeMin": 0, "daysBeforeMax": 2, "discountPercent": 30}],
        }
        assert resolve_last_minute_discount(HOTEL_OFF, room_cfg, days_before=1) is None

    def test_hotel_on_room_disabled_returns_none(self):
        room_cfg = {"enabled": False, "tiers": []}
        assert resolve_last_minute_discount(HOTEL_ON, room_cfg, days_before=1) is None

    def test_hotel_on_matching_tier_returns_percent(self):
        assert resolve_last_minute_discount(HOTEL_ON, None, days_before=1) == 30
        assert resolve_last_minute_discount(HOTEL_ON, None, days_before=5) == 20
        assert resolve_last_minute_discount(HOTEL_ON, None, days_before=10) == 10

    def test_hotel_on_outside_window_returns_none(self):
        assert resolve_last_minute_discount(HOTEL_ON, None, days_before=30) is None

    def test_room_tiers_override_hotel_tiers(self):
        room_cfg = {
            "enabled": True,
            "tiers": [{"daysBeforeMin": 0, "daysBeforeMax": 14, "discountPercent": 50}],
        }
        assert resolve_last_minute_discount(HOTEL_ON, room_cfg, days_before=1) == 50
        assert resolve_last_minute_discount(HOTEL_ON, room_cfg, days_before=10) == 50

    def test_room_empty_tiers_falls_back_to_hotel(self):
        room_cfg = {"enabled": True, "tiers": []}
        assert resolve_last_minute_discount(HOTEL_ON, room_cfg, days_before=1) == 30

    def test_zero_or_negative_pct_skipped(self):
        cfg = {
            "enabled": True,
            "tiers": [
                {"daysBeforeMin": 0, "daysBeforeMax": 2, "discountPercent": 0},
                {"daysBeforeMin": 0, "daysBeforeMax": 2, "discountPercent": 15},
            ],
        }
        assert resolve_last_minute_discount(cfg, None, days_before=1) == 15

    def test_open_ended_tier(self):
        cfg = {
            "enabled": True,
            "tiers": [{"daysBeforeMin": 7, "daysBeforeMax": None, "discountPercent": 5}],
        }
        assert resolve_last_minute_discount(cfg, None, days_before=100) == 5
        assert resolve_last_minute_discount(cfg, None, days_before=6) is None


def test_non_refundable_zero_discount_does_not_use_fallback_discount():
    room = {"flexible_rate_enabled": True, "non_refundable_discount": 0}

    assert compute_non_refundable_rate(room, 100.0, None) == 100.0


def test_non_refundable_percentage_discount_takes_precedence_over_static_rate():
    room = {"flexible_rate_enabled": True, "non_refundable_discount": 10}

    assert compute_non_refundable_rate(room, 200.0, 190.0) == 180.0


@pytest.mark.asyncio
async def test_guest_rooms_do_not_discount_when_hotel_toggle_is_off(monkeypatch):
    hotel_id = "hotel-1"
    hotel_config = {
        "enabled": False,
        "stackWithPromo": False,
        "tiers": [{"daysBeforeMin": 0, "daysBeforeMax": 2, "discountPercent": 30}],
    }
    stale_room_config = {
        "enabled": True,
        "tiers": [{"daysBeforeMin": 0, "daysBeforeMax": 2, "discountPercent": 30}],
    }
    room = {
        "id": "room-1",
        "name": "Deluxe Twin Room",
        "category": "",
        "description": "Room",
        "short_description": "Room",
        "max_occupancy": 2,
        "max_adults": 2,
        "max_children": 0,
        "bedrooms": 1,
        "bathrooms": 1,
        "size": 24,
        "base_rate": 100.0,
        "non_refundable_rate": None,
        "currency": "IDR",
        "amenities": [],
        "images": [],
        "bed_type": "Twin",
        "features": [],
        "total_rooms": 3,
        "non_refundable_enabled": False,
        "flexible_rate_enabled": True,
        "last_minute_discount": stale_room_config,
        "minimum_advance_days": 0,
    }

    async def fetchrow(sql, *args):
        if "SELECT id FROM hotels" in sql:
            return {"id": hotel_id}
        return {
            "benefits": [],
            "last_minute_discount": hotel_config,
            "timezone": "UTC",
            "same_day_bookings_enabled": True,
            "same_day_booking_cutoff_time": None,
        }

    async def list_by_hotel_id(*args, **kwargs):
        return [room]

    async def get_calendar_settings(*args, **kwargs):
        return {}

    async def remaining_for_stay(*args, **kwargs):
        return 3

    monkeypatch.setattr(room_type_service.Database, "fetchrow", fetchrow)
    monkeypatch.setattr(room_type_service.RoomTypeRepository, "list_by_hotel_id", list_by_hotel_id)
    monkeypatch.setattr(
        room_type_service.HotelRepository, "get_calendar_settings", get_calendar_settings
    )
    monkeypatch.setattr(room_type_service, "remaining_for_stay", remaining_for_stay)
    monkeypatch.setattr(room_type_service, "property_today", lambda timezone: date(2026, 5, 27))
    monkeypatch.setattr(room_type_service, "is_stay_sellable", lambda *args, **kwargs: True)
    monkeypatch.setattr(
        room_type_service.RoomTypeRepository,
        "is_date_in_operating_periods",
        lambda *args, **kwargs: True,
    )
    monkeypatch.setattr(
        room_type_service.RoomTypeRepository,
        "resolve_rate",
        lambda *args, **kwargs: (100.0, None),
    )

    rooms = await room_type_service.get_rooms_for_guest(
        "nirvana",
        check_in=date(2026, 5, 28),
        check_out=date(2026, 5, 29),
        adults=2,
        children=0,
    )

    assert len(rooms) == 1
    assert rooms[0].base_rate == 100.0
    assert rooms[0].original_rate is None
    assert rooms[0].last_minute_discount_percent is None


@pytest.mark.asyncio
async def test_guest_rooms_use_full_stay_pricing_that_matches_checkout_quote(monkeypatch):
    hotel_id = "hotel-1"
    hotel_config = {
        "enabled": True,
        "stackWithPromo": False,
        "tiers": [{"daysBeforeMin": 0, "daysBeforeMax": 7, "discountPercent": 10}],
    }
    room = {
        "id": "room-1",
        "hotel_id": hotel_id,
        "name": "Variable Rate Room",
        "category": "",
        "description": "Room",
        "short_description": "Room",
        "max_occupancy": 2,
        "max_adults": 2,
        "max_children": 0,
        "bedrooms": 1,
        "bathrooms": 1,
        "size": 24,
        "base_rate": 100.0,
        "non_refundable_rate": None,
        "non_refundable_discount": 10,
        "currency": "EUR",
        "amenities": [],
        "images": [],
        "bed_type": "King",
        "features": [],
        "total_rooms": 3,
        "non_refundable_enabled": True,
        "flexible_rate_enabled": True,
        "last_minute_discount": None,
        "minimum_advance_days": 0,
        "daily_rates": {
            "2026-05-28": 100.0,
            "2026-05-29": 100.0,
            "2026-05-30": 101.0,
        },
        "seasons": [],
        "operating_periods": [],
        "weekend_surcharge": "+0%",
    }
    check_in = date(2026, 5, 28)
    check_out = date(2026, 5, 31)

    async def fetchrow(sql, *args):
        if "SELECT id FROM hotels" in sql:
            return {"id": hotel_id}
        return {
            "benefits": [],
            "last_minute_discount": hotel_config,
            "timezone": "UTC",
            "same_day_bookings_enabled": True,
            "same_day_booking_cutoff_time": None,
        }

    async def list_by_hotel_id(*args, **kwargs):
        return [room]

    async def get_calendar_settings(*args, **kwargs):
        return {}

    async def remaining_for_stay(*args, **kwargs):
        return 3

    monkeypatch.setattr(room_type_service.Database, "fetchrow", fetchrow)
    monkeypatch.setattr(room_type_service.RoomTypeRepository, "list_by_hotel_id", list_by_hotel_id)
    monkeypatch.setattr(
        room_type_service.HotelRepository, "get_calendar_settings", get_calendar_settings
    )
    monkeypatch.setattr(room_type_service, "remaining_for_stay", remaining_for_stay)
    monkeypatch.setattr(room_type_service, "property_today", lambda timezone: date(2026, 5, 25))
    monkeypatch.setattr(booking_service, "property_today", lambda timezone: date(2026, 5, 25))
    monkeypatch.setattr(room_type_service, "is_stay_sellable", lambda *args, **kwargs: True)
    monkeypatch.setattr(
        room_type_service.RoomTypeRepository,
        "is_date_in_operating_periods",
        lambda *args, **kwargs: True,
    )

    rooms = await room_type_service.get_rooms_for_guest(
        "nirvana",
        check_in=check_in,
        check_out=check_out,
        adults=2,
        children=0,
    )

    assert len(rooms) == 1
    display_room = rooms[0]
    assert display_room.original_nightly_rates == [100.0, 100.0, 101.0]
    assert display_room.nightly_rates == [90.0, 90.0, 90.9]
    assert display_room.non_refundable_nightly_rates == [81.0, 81.0, 81.81]
    assert display_room.base_rate == 90.3
    assert display_room.non_refundable_rate == 81.27

    quote_pricing = await booking_service._compute_booking_pricing(
        "nirvana",
        BookingCreate(
            room_type_id="room-1",
            guest_first_name="Guest",
            guest_last_name="Example",
            guest_email="guest@example.com",
            guest_phone="+1234567890",
            check_in=check_in,
            check_out=check_out,
            adults=2,
            children=0,
            payment_method="pay_at_property",
            rate_type="flexible",
        ),
        {
            "id": hotel_id,
            "last_minute_discount": hotel_config,
            "timezone": "UTC",
        },
        room,
        3,
    )
    assert math.isclose(sum(display_room.nightly_rates), quote_pricing.room_total, abs_tol=0.01)

    nonref_quote_base = compute_stay_pricing(room, check_in, check_out, 2, "nonrefundable")
    expected_nonref_room_total = round(nonref_quote_base.room_total * 0.9, 2)
    assert math.isclose(
        sum(display_room.non_refundable_nightly_rates),
        expected_nonref_room_total,
        abs_tol=0.01,
    )
