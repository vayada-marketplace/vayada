from datetime import date

from app.services.calendar_auto_open_service import (
    add_months,
    month_end,
    rolling_open_through,
)


def test_rolling_open_through_snaps_to_full_month_boundary():
    assert rolling_open_through(date(2026, 5, 25), 18) == date(2027, 11, 30)


def test_rolling_open_through_handles_year_end():
    assert rolling_open_through(date(2026, 12, 1), 12) == date(2027, 12, 31)


def test_month_helpers_handle_february_leap_year():
    february = add_months(date(2023, 12, 1), 2)
    assert february == date(2024, 2, 1)
    assert month_end(february) == date(2024, 2, 29)
