"""Unit tests for meal-plan rate variants pushed to Channex (VAY-306)."""
from datetime import date
from decimal import Decimal
from unittest.mock import patch

from app.services.channex.ari_push import (
    _build_restriction_entry,
    _meal_surcharge_for_code,
)
from app.services.channex_service import meal_plan_code_to_channex_meal_type


# ── meal_plan_code mapping ─────────────────────────────────────────────


def test_meal_plan_code_to_channex_meal_type_known_codes():
    assert meal_plan_code_to_channex_meal_type(0) == "nomeal"
    assert meal_plan_code_to_channex_meal_type(1) == "breakfast"
    assert meal_plan_code_to_channex_meal_type(3) == "halfboard"
    assert meal_plan_code_to_channex_meal_type(4) == "fullboard"
    assert meal_plan_code_to_channex_meal_type(9) == "allinclusive"


def test_meal_plan_code_to_channex_meal_type_unknown_falls_back_to_nomeal():
    # Defends against a stale row sneaking in via a code we don't recognize.
    assert meal_plan_code_to_channex_meal_type(7) == "nomeal"


# ── _meal_surcharge_for_code ───────────────────────────────────────────


def test_meal_surcharge_returns_zero_when_code_is_zero():
    room_type = {"meal_plans": [{"code": 1, "surcharge": 300000}]}
    assert _meal_surcharge_for_code(room_type, 0) == Decimal(0)


def test_meal_surcharge_returns_matching_entry():
    room_type = {
        "meal_plans": [
            {"code": 1, "surcharge": 300000},
            {"code": 3, "surcharge": 600000},
        ]
    }
    assert _meal_surcharge_for_code(room_type, 1) == Decimal("300000")
    assert _meal_surcharge_for_code(room_type, 3) == Decimal("600000")


def test_meal_surcharge_zero_when_code_not_configured():
    room_type = {"meal_plans": [{"code": 1, "surcharge": 300000}]}
    # Code 9 is not enabled on the room — no extra charge.
    assert _meal_surcharge_for_code(room_type, 9) == Decimal(0)


def test_meal_surcharge_handles_jsonb_string():
    # asyncpg returns JSONB columns as strings; parse_jsonb decodes them.
    room_type = {"meal_plans": '[{"code": 1, "surcharge": 250}]'}
    assert _meal_surcharge_for_code(room_type, 1) == Decimal("250")


def test_meal_surcharge_per_room_not_multiplied():
    room_type = {
        "max_occupancy": 4,
        "meal_plans": [{"code": 1, "surcharge": 300000, "charge_per": "room"}],
    }
    assert _meal_surcharge_for_code(room_type, 1) == Decimal("300000")


def test_meal_surcharge_per_person_multiplied_by_occupancy():
    room_type = {
        "max_occupancy": 3,
        "meal_plans": [{"code": 1, "surcharge": 100000, "charge_per": "person"}],
    }
    assert _meal_surcharge_for_code(room_type, 1) == Decimal("300000")


def test_meal_surcharge_accepts_camel_case_charge_per():
    # Frontend may send chargePer; the row hasn't been re-validated since.
    room_type = {
        "max_occupancy": 2,
        "meal_plans": [{"code": 1, "surcharge": 150, "chargePer": "person"}],
    }
    assert _meal_surcharge_for_code(room_type, 1) == Decimal("300")


def test_meal_surcharge_legacy_rows_default_to_per_room():
    # Older rows without charge_per must keep the existing flat-per-room behavior.
    room_type = {
        "max_occupancy": 4,
        "meal_plans": [{"code": 1, "surcharge": 250}],
    }
    assert _meal_surcharge_for_code(room_type, 1) == Decimal("250")


# ── _build_restriction_entry with meal surcharge ──────────────────────


def _make_room_type(**overrides):
    base = {
        "id": "rt-1",
        "base_rate": 1_400_000,
        "non_refundable_rate": None,
        "non_refundable_discount": 5,
        "currency": "IDR",
        "operating_periods": [],
        "seasons": [],
        "daily_rates": {},
        "weekend_surcharge": "+0%",
        "min_stay": 1,
        "max_stay": 0,
        "meal_plans": [],
    }
    base.update(overrides)
    return base


def test_restriction_entry_no_surcharge_for_room_only():
    room = _make_room_type(meal_plans=[{"code": 1, "surcharge": 300_000}])
    entry = _build_restriction_entry(room, date(2026, 5, 1), meal_plan_code=0)
    assert entry["rate"] == 1_400_000


def test_restriction_entry_direct_channel_is_one_to_one_with_base_rate():
    """VAY-349: with markup=0, no surcharge, no NR discount, the rate sent
    to Channex must equal the input base_rate exactly. Locks in 1:1 rate
    parity between the price set in the system and the price pushed to
    OTAs via the direct rate plan.
    """
    room = _make_room_type(base_rate=3_000_000)
    entry = _build_restriction_entry(
        room, date(2026, 5, 1),
        plan_name="standard",
        markup_pct=Decimal(0),
        meal_plan_code=0,
    )
    assert entry["rate"] == 3_000_000


def test_restriction_entry_negative_markup_no_longer_reachable_via_model():
    """VAY-349 guard: ChannelMarkup model rejects negative markup_pct.

    A negative value here would silently discount the OTA rate (the
    original bug — 3,000,000 IDR became ~2,626,500 IDR with a -12.45
    markup). Validation lives at the model boundary; this test makes the
    invariant explicit so a future widening of the bound triggers a CI
    failure here, not a revenue-impacting silent discount in production.
    """
    from decimal import Decimal as _D

    from pydantic import ValidationError

    from app.models.channex import ChannelMarkup

    # Zero and positive values are accepted.
    ChannelMarkup(channel="booking_com", markup_pct=_D(0))
    ChannelMarkup(channel="booking_com", markup_pct=_D("12.45"))

    # Negative values are rejected.
    try:
        ChannelMarkup(channel="booking_com", markup_pct=_D("-12.45"))
    except ValidationError:
        return
    raise AssertionError("Negative markup_pct should be rejected by the model")


def test_restriction_entry_adds_surcharge_for_breakfast():
    room = _make_room_type(meal_plans=[{"code": 1, "surcharge": 300_000}])
    entry = _build_restriction_entry(room, date(2026, 5, 1), meal_plan_code=1)
    assert entry["rate"] == 1_700_000


def test_restriction_entry_surcharge_is_marked_up_with_channel():
    # A 10% Booking.com markup applies to the meal-inclusive rate, mirroring
    # how OTAs commission the full guest-paid amount.
    room = _make_room_type(meal_plans=[{"code": 1, "surcharge": 300_000}])
    entry = _build_restriction_entry(
        room, date(2026, 5, 1),
        plan_name="standard",
        markup_pct=Decimal(10),
        meal_plan_code=1,
    )
    assert entry["rate"] == 1_870_000


def test_restriction_entry_non_refundable_with_meal_surcharge():
    # Non-refundable applies to the room rate, then surcharge is added on top.
    room = _make_room_type(
        non_refundable_discount=10,
        meal_plans=[{"code": 1, "surcharge": 200_000}],
    )
    entry = _build_restriction_entry(
        room, date(2026, 5, 1),
        plan_name="non_refundable",
        meal_plan_code=1,
    )
    # 1_400_000 * 0.9 = 1_260_000  +  200_000 = 1_460_000
    assert entry["rate"] == 1_460_000


# ── provisioning meal-plan matrix ─────────────────────────────────────


def test_provisioning_creates_meal_plan_variants_for_booking_com_only():
    """
    Hotel with breakfast enabled should get:
      - direct standard (room only)
      - booking_com standard (room only)
      - booking_com standard (breakfast)
      - airbnb standard (room only)

    Direct stays don't surface meal plans (handled separately on direct
    flow); Airbnb only allows one rate plan per listing.
    """
    import asyncio
    from app.services.channex import provisioning

    created_titles: list[str] = []
    created_meal_codes: list[int] = []
    mapping_combos: list[tuple] = []

    class FakeConnRepo:
        @staticmethod
        async def get_by_hotel_id(_):
            return {"is_active": True, "channex_property_id": "prop-1"}

        @staticmethod
        async def set_property_id(*_args, **_kwargs):
            return None

    class FakeRoomMappingRepo:
        @staticmethod
        async def get_by_room_type_id(_):
            return {"channex_room_type_id": "crt-1"}

        @staticmethod
        async def create(*_args, **_kwargs):
            return None

    class FakeRatePlanMappingRepo:
        @staticmethod
        async def list_by_room_type_id(_):
            return []

        @staticmethod
        async def create(**kwargs):
            mapping_combos.append((
                kwargs["channel"],
                kwargs["plan_name"],
                kwargs["meal_plan_code"],
            ))
            return None

    async def fake_create_rate_plan(_api_key, *, title, meal_plan_code, **_kwargs):
        created_titles.append(title)
        created_meal_codes.append(meal_plan_code)
        return {"id": f"rp-{len(created_titles)}"}

    class FakeDatabase:
        @staticmethod
        async def fetchrow(_query, *_args):
            return {"id": "h1", "name": "Demo Hotel"}

        @staticmethod
        async def fetch(_query, *_args):
            return [{
                "id": "rt-1",
                "name": "Suite",
                "total_rooms": 5,
                "max_occupancy": 2,
                "currency": "IDR",
                "non_refundable_enabled": False,
                "meal_plans": [{"code": 1, "surcharge": 300_000}],
            }]

    async def fake_get_currency(_):
        return "IDR"

    async def run():
        with (
            patch.object(provisioning, "ChannexConnectionRepository", FakeConnRepo),
            patch.object(provisioning, "ChannexRoomTypeMappingRepository", FakeRoomMappingRepo),
            patch.object(provisioning, "ChannexRatePlanMappingRepository", FakeRatePlanMappingRepo),
            patch.object(provisioning, "Database", FakeDatabase),
            patch.object(provisioning, "get_be_currency", fake_get_currency),
            patch.object(
                provisioning.channex_service, "create_rate_plan", fake_create_rate_plan
            ),
            patch.object(
                provisioning.channex_service, "get_platform_api_key", lambda: "key"
            ),
        ):
            await provisioning.provision_property("h1")

    asyncio.run(run())

    assert ("direct", "standard", 0) in mapping_combos
    assert ("booking_com", "standard", 0) in mapping_combos
    assert ("booking_com", "standard", 1) in mapping_combos
    assert ("airbnb", "standard", 0) in mapping_combos
    # Direct and airbnb must NOT spawn breakfast variants.
    assert ("direct", "standard", 1) not in mapping_combos
    assert ("airbnb", "standard", 1) not in mapping_combos
