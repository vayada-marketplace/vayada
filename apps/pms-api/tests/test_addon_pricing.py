"""Unit tests for the addon pricing logic in booking_service._compute_addon_total.

Covers VAY-360 — per-person and per-day add-ons must compose correctly so the
Booking Engine and the booking total agree on price = unit × people × days.
"""

from unittest.mock import patch

import pytest
from app.services import booking_service

HOTEL_SLUG = "test-hotel"


def _addon(
    id_: str,
    price: float,
    *,
    per_person: bool = False,
    per_night: bool = False,
    currency: str = "USD",
):
    return {
        "id": id_,
        "name": f"addon-{id_}",
        "price": price,
        "currency": currency,
        "perPerson": per_person,
        "perNight": per_night,
    }


@pytest.fixture
def fetch_addons_mock():
    """Patch _fetch_hotel_addons to return the addons supplied by the test."""

    def _make(addons):
        async def _fake(_slug):
            return addons

        return patch.object(booking_service, "_fetch_hotel_addons", _fake)

    return _make


@pytest.mark.asyncio
async def test_per_booking_addon_uses_quantity(fetch_addons_mock):
    addons = [_addon("a1", 25.0)]
    with fetch_addons_mock(addons):
        total, names = await booking_service._compute_addon_total(
            HOTEL_SLUG,
            ["a1"],
            {"a1": 3},
            "USD",
            adults=2,
            nights=4,
        )
    assert total == 75.0
    assert names == ["addon-a1"]


@pytest.mark.asyncio
async def test_per_person_addon_uses_selected_people(fetch_addons_mock):
    """Per-person price should follow the user-selected qty, not always full occupancy."""
    addons = [_addon("a1", 30.0, per_person=True)]
    with fetch_addons_mock(addons):
        total, _ = await booking_service._compute_addon_total(
            HOTEL_SLUG,
            ["a1"],
            {"a1": 1},  # 1 of 2 guests opting in
            "USD",
            adults=2,
            nights=3,
        )
    assert total == 30.0


@pytest.mark.asyncio
async def test_per_person_clamps_to_adults(fetch_addons_mock):
    addons = [_addon("a1", 30.0, per_person=True)]
    with fetch_addons_mock(addons):
        total, _ = await booking_service._compute_addon_total(
            HOTEL_SLUG,
            ["a1"],
            {"a1": 99},
            "USD",
            adults=2,
            nights=1,
        )
    assert total == 60.0  # clamped to 2 adults


@pytest.mark.asyncio
async def test_per_person_defaults_to_full_occupancy_for_legacy(fetch_addons_mock):
    """Legacy bookings without an explicit qty should still charge for all adults."""
    addons = [_addon("a1", 30.0, per_person=True)]
    with fetch_addons_mock(addons):
        total, _ = await booking_service._compute_addon_total(
            HOTEL_SLUG,
            ["a1"],
            {},
            "USD",
            adults=2,
            nights=1,
        )
    assert total == 60.0


@pytest.mark.asyncio
async def test_per_night_uses_selected_dates(fetch_addons_mock):
    addons = [_addon("a1", 50.0, per_night=True)]
    with fetch_addons_mock(addons):
        total, _ = await booking_service._compute_addon_total(
            HOTEL_SLUG,
            ["a1"],
            {},
            "USD",
            adults=2,
            nights=4,
            addon_dates={"a1": ["2026-06-01", "2026-06-03"]},
        )
    assert total == 100.0  # 2 days × $50


@pytest.mark.asyncio
async def test_per_night_falls_back_to_quantity_then_nights(fetch_addons_mock):
    addons = [_addon("a1", 50.0, per_night=True)]
    with fetch_addons_mock(addons):
        total_qty, _ = await booking_service._compute_addon_total(
            HOTEL_SLUG,
            ["a1"],
            {"a1": 2},
            "USD",
            adults=1,
            nights=4,
        )
        total_legacy, _ = await booking_service._compute_addon_total(
            HOTEL_SLUG,
            ["a1"],
            {},
            "USD",
            adults=1,
            nights=4,
        )
    assert total_qty == 100.0  # 2 days from qty fallback
    assert total_legacy == 200.0  # all 4 nights when nothing supplied


@pytest.mark.asyncio
async def test_per_person_per_day_composes(fetch_addons_mock):
    """The headline VAY-360 case: scooter rental is $20/person/day; 2 guests for 2 days = $80."""
    addons = [_addon("scooter", 20.0, per_person=True, per_night=True)]
    with fetch_addons_mock(addons):
        total, _ = await booking_service._compute_addon_total(
            HOTEL_SLUG,
            ["scooter"],
            {"scooter": 2},
            "USD",
            adults=2,
            nights=2,
            addon_dates={"scooter": ["2026-06-01", "2026-06-02"]},
        )
    assert total == 80.0  # 2 people × 2 days × $20


@pytest.mark.asyncio
async def test_per_person_per_day_partial_selection(fetch_addons_mock):
    """1 person renting on 1 of 2 nights = unit × 1 × 1."""
    addons = [_addon("scooter", 20.0, per_person=True, per_night=True)]
    with fetch_addons_mock(addons):
        total, _ = await booking_service._compute_addon_total(
            HOTEL_SLUG,
            ["scooter"],
            {"scooter": 1},
            "USD",
            adults=2,
            nights=2,
            addon_dates={"scooter": ["2026-06-01"]},
        )
    assert total == 20.0


@pytest.mark.asyncio
async def test_per_night_clamped_to_stay_length(fetch_addons_mock):
    """A guest can't select more days than the stay has nights."""
    addons = [_addon("a1", 10.0, per_night=True)]
    with fetch_addons_mock(addons):
        total, _ = await booking_service._compute_addon_total(
            HOTEL_SLUG,
            ["a1"],
            {},
            "USD",
            adults=1,
            nights=2,
            addon_dates={"a1": ["d1", "d2", "d3", "d4"]},
        )
    assert total == 20.0  # clamped to 2 nights


@pytest.mark.asyncio
async def test_unknown_addon_id_skipped(fetch_addons_mock):
    addons = [_addon("a1", 10.0)]
    with fetch_addons_mock(addons):
        total, names = await booking_service._compute_addon_total(
            HOTEL_SLUG,
            ["a1", "missing"],
            {"a1": 1},
            "USD",
            adults=1,
            nights=1,
        )
    assert total == 10.0
    assert names == ["addon-a1"]
