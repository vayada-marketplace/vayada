"""Direct unit tests for ``room_allows_guest_mix``.

The integration coverage in ``test_rooms_public.py`` exercises the search
endpoint; this file pins the multi-unit math itself (VAY-492) so future
regressions surface as a clear, fast-failing unit test instead of a
mysterious empty room list."""

from app.services.occupancy import room_allows_guest_mix

ROOM = {"max_occupancy": 4, "max_adults": 2, "max_children": 2}


def test_returns_true_when_no_guest_count_provided():
    assert room_allows_guest_mix(ROOM, None, None) is True


def test_single_unit_default():
    assert room_allows_guest_mix(ROOM, 2, 2) is True
    assert room_allows_guest_mix(ROOM, 3, 0) is False  # max_adults=2


def test_multi_unit_scales_total_occupancy():
    # 6 guests across 2 units of cap 4 → 6 <= 8
    assert room_allows_guest_mix(ROOM, 4, 2, units=2) is True
    # 9 guests across 2 units → 9 > 8
    assert room_allows_guest_mix(ROOM, 5, 4, units=2) is False


def test_multi_unit_scales_adult_limit():
    assert room_allows_guest_mix(ROOM, 4, 0, units=2) is True  # 4 <= 2*2
    assert room_allows_guest_mix(ROOM, 5, 0, units=2) is False  # 5 > 2*2


def test_multi_unit_scales_child_limit():
    assert room_allows_guest_mix(ROOM, 0, 4, units=2) is True
    assert room_allows_guest_mix(ROOM, 0, 5, units=2) is False


def test_units_zero_falls_back_to_one():
    # Inventory of zero must not let a hypothetical "0 * cap" admit every
    # party — clamp to 1 so the per-unit limits still apply.
    assert room_allows_guest_mix(ROOM, 4, 0, units=0) is False
    assert room_allows_guest_mix(ROOM, 2, 2, units=0) is True


def test_unconfigured_adult_child_limits_fall_back_to_max_occupancy():
    legacy = {"max_occupancy": 3}
    assert room_allows_guest_mix(legacy, 3, 0) is True
    assert room_allows_guest_mix(legacy, 4, 0) is False
    # And the legacy room still scales across units.
    assert room_allows_guest_mix(legacy, 6, 0, units=2) is True
    assert room_allows_guest_mix(legacy, 7, 0, units=2) is False
