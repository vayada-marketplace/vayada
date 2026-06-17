"""Unit tests for resolve_last_minute_discount.

Pins the contract that the hotel-level ``enabled`` flag is the master switch
(VAY-316: per-room configs were bypassing the hotel toggle).
"""

from datetime import date

import pytest
from app.routers.admin import _normalize_last_minute_discount
from app.services import room_type_service
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


def test_normalize_last_minute_discount_clears_disabled_tiers():
    assert _normalize_last_minute_discount(
        {
            "enabled": False,
            "stackWithPromo": True,
            "tiers": [{"daysBeforeMin": 0, "daysBeforeMax": 2, "discountPercent": 30}],
        }
    ) == {"enabled": False, "stackWithPromo": False, "tiers": []}


def test_normalize_last_minute_discount_keeps_enabled_valid_tiers():
    assert _normalize_last_minute_discount(
        {
            "enabled": True,
            "stackWithPromo": True,
            "tiers": [
                {"daysBeforeMin": "0", "daysBeforeMax": "2", "discountPercent": "30"},
                {"daysBeforeMin": 7, "daysBeforeMax": None, "discountPercent": 0},
                {"daysBeforeMin": 14, "daysBeforeMax": None, "discountPercent": 99},
            ],
        }
    ) == {
        "enabled": True,
        "stackWithPromo": True,
        "tiers": [
            {"daysBeforeMin": 0, "daysBeforeMax": 2, "discountPercent": 30},
            {"daysBeforeMin": 14, "daysBeforeMax": None, "discountPercent": 90},
        ],
    }


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

    async def get_auto_rearrange_enabled(*args, **kwargs):
        return False

    async def remaining_for_stay(*args, **kwargs):
        return 3

    monkeypatch.setattr(room_type_service.Database, "fetchrow", fetchrow)
    monkeypatch.setattr(room_type_service.RoomTypeRepository, "list_by_hotel_id", list_by_hotel_id)
    monkeypatch.setattr(
        room_type_service.HotelRepository, "get_calendar_settings", get_calendar_settings
    )
    monkeypatch.setattr(
        room_type_service.HotelRepository,
        "get_auto_rearrange_enabled",
        get_auto_rearrange_enabled,
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
