from datetime import datetime
from zoneinfo import ZoneInfo

from app.services.same_day_booking import is_same_day_booking_closed, property_today


def test_property_today_uses_property_timezone():
    now = datetime(2026, 5, 25, 17, 30, tzinfo=ZoneInfo("UTC"))

    assert property_today("Asia/Makassar", now=now).isoformat() == "2026-05-26"


def test_same_day_bookings_disabled_blocks_today_only():
    now = datetime(2026, 5, 25, 10, 0, tzinfo=ZoneInfo("Europe/Berlin"))

    assert is_same_day_booking_closed(
        now.date(),
        same_day_bookings_enabled=False,
        same_day_booking_cutoff_time="18:00",
        timezone="Europe/Berlin",
        now=now,
    )
    assert not is_same_day_booking_closed(
        now.date().replace(day=26),
        same_day_bookings_enabled=False,
        same_day_booking_cutoff_time="18:00",
        timezone="Europe/Berlin",
        now=now,
    )


def test_same_day_cutoff_blocks_after_selected_time():
    now = datetime(2026, 5, 25, 18, 1, tzinfo=ZoneInfo("Europe/Berlin"))

    assert is_same_day_booking_closed(
        now.date(),
        same_day_bookings_enabled=True,
        same_day_booking_cutoff_time="18:00",
        timezone="Europe/Berlin",
        now=now,
    )


def test_same_day_cutoff_blocks_after_boundary_second():
    now = datetime(2026, 5, 25, 18, 0, 1, tzinfo=ZoneInfo("Europe/Berlin"))

    assert is_same_day_booking_closed(
        now.date(),
        same_day_bookings_enabled=True,
        same_day_booking_cutoff_time="18:00",
        timezone="Europe/Berlin",
        now=now,
    )


def test_same_day_cutoff_allows_at_boundary():
    now = datetime(2026, 5, 25, 18, 0, tzinfo=ZoneInfo("Europe/Berlin"))

    assert not is_same_day_booking_closed(
        now.date(),
        same_day_bookings_enabled=True,
        same_day_booking_cutoff_time="18:00",
        timezone="Europe/Berlin",
        now=now,
    )
