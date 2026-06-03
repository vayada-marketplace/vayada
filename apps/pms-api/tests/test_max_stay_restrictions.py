from datetime import date

from app.repositories.room_type_repo import RoomTypeRepository
from app.services.channex.ari_push import _build_restriction_entry, _restriction_to_value
from app.services.channex.inbound import _append_import_warning, _max_stay_warning


def _room(seasons: list[dict]) -> dict:
    return {
        "id": "rt-max-stay",
        "base_rate": 150,
        "non_refundable_rate": None,
        "non_refundable_discount": 5,
        "currency": "EUR",
        "operating_periods": [],
        "seasons": seasons,
        "daily_rates": {},
        "weekend_surcharge": "+0%",
        "min_stay": 1,
        "max_stay": 0,
        "meal_plans": [],
    }


def test_stay_max_stay_uses_most_restrictive_spanned_season():
    seasons = [
        {
            "name": "July",
            "from": "07-01",
            "to": "07-31",
            "rate": "100",
            "minStay": 1,
            "maxStay": 14,
        },
        {
            "name": "August",
            "from": "08-01",
            "to": "08-31",
            "rate": "100",
            "minStay": 1,
            "maxStay": 21,
        },
    ]

    assert (
        RoomTypeRepository._find_stay_max_stay(
            seasons,
            date(2026, 7, 20),
            date(2026, 8, 15),
        )
        == 14
    )


def test_arrival_max_stay_allows_checkout_before_future_restricted_season():
    seasons = [
        {
            "name": "Open start",
            "from": "01-01",
            "to": "01-10",
            "rate": "100",
            "minStay": 1,
            "maxStay": None,
        },
        {
            "name": "Short stay only",
            "from": "01-11",
            "to": "12-31",
            "rate": "100",
            "minStay": 1,
            "maxStay": 3,
        },
    ]

    assert RoomTypeRepository._find_arrival_max_stay(seasons, date(2026, 1, 1)) == 10


def test_season_stay_helpers_accept_snake_case_keys():
    seasons = [
        {
            "name": "Legacy keys",
            "from": "01-01",
            "to": "12-31",
            "rate": "100",
            "min_stay": 2,
            "max_stay": 5,
        }
    ]

    assert RoomTypeRepository._find_season_min_stay(seasons, date(2026, 6, 1)) == 2
    assert (
        RoomTypeRepository._find_stay_max_stay(
            seasons,
            date(2026, 6, 1),
            date(2026, 6, 4),
        )
        == 5
    )


def test_channex_restriction_entry_uses_season_max_stay():
    room = _room(
        [
            {
                "name": "July",
                "from": "07-01",
                "to": "07-31",
                "rate": "200",
                "minStay": 1,
                "maxStay": 14,
            }
        ]
    )

    entry = _build_restriction_entry(room, date(2026, 7, 10))

    assert entry["max_stay"] == 14


def test_channex_restriction_payload_includes_zero_max_stay():
    value = _restriction_to_value(
        {
            "rate": 100,
            "min_stay_arrival": 1,
            "max_stay": 0,
            "stop_sell": False,
            "closed_to_arrival": False,
            "closed_to_departure": False,
        },
        channex_property_id="prop-1",
        channex_rate_plan_id="rate-1",
        date_from=date(2026, 7, 1),
        date_to=date(2026, 7, 31),
    )

    assert value["max_stay"] == 0


def test_channex_inbound_over_max_stay_warning_is_host_visible():
    room = _room(
        [
            {
                "name": "Short stay",
                "from": "01-01",
                "to": "12-31",
                "rate": "200",
                "minStay": 1,
                "maxStay": 3,
            }
        ]
    )

    warning = _max_stay_warning(room, date(2026, 7, 1), date(2026, 7, 6))

    assert warning == (
        "Exceeds max stay restriction: 5 nights selected, "
        "maximum is 3 nights for the selected dates."
    )
    assert _append_import_warning("Late arrival", warning) == f"Late arrival\n\n{warning}"
