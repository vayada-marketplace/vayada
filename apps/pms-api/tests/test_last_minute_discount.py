"""Unit tests for resolve_last_minute_discount.

Pins the contract that the hotel-level ``enabled`` flag is the master switch
(VAY-316: per-room configs were bypassing the hotel toggle).
"""

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
