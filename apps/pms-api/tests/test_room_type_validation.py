"""Pydantic-only unit tests for RoomTypeCreate / RoomTypeUpdate gap detection.

Covers VAY-352: gap detection must only flag dates inside operating periods,
not the whole calendar year.
"""

import pytest
from app.models.room_type import RoomTypeCreate, RoomTypeUpdate
from pydantic import ValidationError


def _season(name: str, frm: str, to: str, rate: float = 100.0) -> dict:
    return {"name": name, "tier": "Mid", "from": frm, "to": to, "rate": rate, "minStay": 1}


def _build_create(operating_periods: list[dict], seasons: list[dict]) -> RoomTypeCreate:
    return RoomTypeCreate(
        name="Test Room",
        operating_periods=operating_periods,
        seasons=seasons,
    )


# Closed October scenario from the bug report — must not raise.
def test_closed_october_with_full_open_coverage_is_not_a_gap():
    operating = [
        {"from": "01-01", "to": "09-30"},
        {"from": "11-01", "to": "12-31"},
    ]
    seasons = [
        _season("Jan-Apr", "01-01", "04-30"),
        _season("May-Sep", "05-01", "09-30"),
        _season("Nov-Dec", "11-01", "12-31"),
    ]
    # Should not raise
    _build_create(operating, seasons)


# Real gap inside an operating period must still be flagged.
def test_in_period_gap_is_flagged():
    operating = [{"from": "01-01", "to": "09-30"}]
    seasons = [
        _season("Jan-Aug", "01-01", "08-31"),
        # Sep is uncovered
    ]
    with pytest.raises(ValidationError) as exc:
        _build_create(operating, seasons)
    assert "gaps" in str(exc.value).lower()
    assert "09-01" in str(exc.value)


# Season spanning a closed period: only the open portion needs coverage.
def test_season_spanning_closed_period_is_not_a_gap():
    # October is closed; season covers Aug-Sep AND Nov.
    operating = [
        {"from": "01-01", "to": "09-30"},
        {"from": "11-01", "to": "12-31"},
    ]
    seasons = [
        _season("Spring", "01-01", "07-31"),
        _season("Aug-Nov span", "08-01", "11-30"),
        _season("Dec", "12-01", "12-31"),
    ]
    # Should not raise — even though season range crosses closed Oct.
    _build_create(operating, seasons)


# Property fully closed year-round: no operating periods, no seasons → no error.
def test_no_operating_periods_no_seasons_is_valid():
    _build_create([], [])


# No operating periods → property is fully closed; partial seasons are still
# valid (they just sit on closed days that get ignored). No gap flagged.
def test_no_operating_periods_treats_year_as_closed():
    seasons = [
        _season("Jan-Jun", "01-01", "06-30"),
    ]
    _build_create([], seasons)


# Two operating periods, gap inside the second one.
def test_gap_inside_second_operating_period_is_flagged():
    operating = [
        {"from": "01-01", "to": "06-30"},
        {"from": "08-01", "to": "12-31"},
    ]
    seasons = [
        _season("H1", "01-01", "06-30"),
        _season("Aug-Oct", "08-01", "10-31"),
        # Nov-Dec uncovered inside an operating period
    ]
    with pytest.raises(ValidationError) as exc:
        _build_create(operating, seasons)
    msg = str(exc.value)
    assert "11-01" in msg
    assert "12-31" in msg


# Single operating period fully covered by a single season → no error.
def test_single_period_single_season_full_coverage():
    _build_create(
        [{"from": "06-01", "to": "08-31"}],
        [_season("Summer", "06-01", "08-31")],
    )


# RoomTypeUpdate: same closed-October scenario must not raise.
def test_update_closed_october_with_full_open_coverage_is_not_a_gap():
    RoomTypeUpdate(
        operating_periods=[
            {"from": "01-01", "to": "09-30"},
            {"from": "11-01", "to": "12-31"},
        ],
        seasons=[
            _season("Jan-Sep", "01-01", "09-30"),
            _season("Nov-Dec", "11-01", "12-31"),
        ],
    )


# RoomTypeUpdate: in-period gap must still be flagged.
def test_update_in_period_gap_is_flagged():
    with pytest.raises(ValidationError):
        RoomTypeUpdate(
            operating_periods=[{"from": "01-01", "to": "09-30"}],
            seasons=[_season("Jan-Aug", "01-01", "08-31")],
        )


# RoomTypeUpdate: omitting seasons skips gap validation entirely.
def test_update_without_seasons_skips_gap_validation():
    RoomTypeUpdate(operating_periods=[{"from": "01-01", "to": "06-30"}])


def test_season_max_stay_must_not_be_less_than_min_stay():
    with pytest.raises(ValidationError) as exc:
        _build_create(
            [{"from": "01-01", "to": "12-31"}],
            [_season("All year", "01-01", "12-31") | {"minStay": 5, "maxStay": 3}],
        )
    assert "Max stay cannot be less than min stay" in str(exc.value)


def test_season_blank_or_zero_max_stay_means_no_limit():
    room = _build_create(
        [{"from": "01-01", "to": "12-31"}],
        [
            _season("H1", "01-01", "06-30") | {"maxStay": ""},
            _season("H2", "07-01", "12-31") | {"maxStay": 0},
        ],
    )
    assert room.seasons[0]["maxStay"] is None
    assert room.seasons[1]["maxStay"] is None


# Cross-year operating-period support exists in the gap helper for parity
# with the frontend, even though the existing operating-period field validator
# rejects to < from at the model boundary. Test the helper directly.
def test_helper_handles_cross_year_operating_period_full_coverage():
    from app.models.room_type import _validate_no_season_gaps

    _validate_no_season_gaps(
        [
            _season("Winter early", "11-01", "12-31"),
            _season("Winter late", "01-01", "04-30"),
        ],
        [{"from": "11-01", "to": "04-30"}],
    )


def test_helper_handles_cross_year_operating_period_with_gap():
    from app.models.room_type import _validate_no_season_gaps

    with pytest.raises(ValueError) as exc:
        _validate_no_season_gaps(
            [_season("Winter early", "11-01", "12-31")],
            [{"from": "11-01", "to": "04-30"}],
        )
    msg = str(exc.value)
    assert "01-01" in msg
    assert "04-30" in msg
