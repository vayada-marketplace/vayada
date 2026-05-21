"""Pre-flight validation + payload hardening for Channex provisioning — VAY-386.

Before VAY-386 a hotel that hadn't set its currency would get a useless 422
from Channex. Pre-flight catches the gap up front; the currency fallback +
title cap also harden the payload we send.
"""
import asyncio
from unittest.mock import patch

import pytest

from app.services.channex import provisioning


# ── _preflight_check ──────────────────────────────────────────────────


def test_preflight_rejects_missing_hotel_currency():
    async def run():
        await provisioning._preflight_check("h1", currency=None, room_types=[{"name": "X"}])

    with pytest.raises(ValueError, match="hotel currency isn't set"):
        asyncio.run(run())


def test_preflight_rejects_no_active_room_types():
    async def run():
        await provisioning._preflight_check("h1", currency="IDR", room_types=[])

    with pytest.raises(ValueError, match="no active room types"):
        asyncio.run(run())


def test_preflight_rejects_room_type_with_zero_total_rooms():
    rooms = [{"name": "Suite", "total_rooms": 0, "max_occupancy": 2}]

    async def run():
        await provisioning._preflight_check("h1", currency="IDR", room_types=rooms)

    with pytest.raises(ValueError, match="'Suite' has no rooms"):
        asyncio.run(run())


def test_preflight_rejects_room_type_with_zero_max_occupancy():
    rooms = [{"name": "Suite", "total_rooms": 3, "max_occupancy": 0}]

    async def run():
        await provisioning._preflight_check("h1", currency="IDR", room_types=rooms)

    with pytest.raises(ValueError, match="'Suite' has no occupancy"):
        asyncio.run(run())


def test_preflight_passes_with_valid_data():
    rooms = [{"name": "Suite", "total_rooms": 3, "max_occupancy": 2}]

    async def run():
        await provisioning._preflight_check("h1", currency="IDR", room_types=rooms)

    asyncio.run(run())  # must not raise


# ── currency fallback + title cap in provision_property ───────────────


def _make_fakes(*, room_currency, room_name="Suite"):
    """Build the patch mocks needed to drive provision_property() without DB
    or network access. Returns (run, captured_kwargs)."""
    captured: list[dict] = []

    class FakeConnRepo:
        @staticmethod
        async def get_by_hotel_id(_):
            return {
                "is_active": True,
                "channex_property_id": "prop-1",
                "messaging_app_installed": True,
            }

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
        async def create(**_kwargs):
            return None

    async def fake_create_rate_plan(_api_key, **kwargs):
        captured.append(kwargs)
        return {"id": f"rp-{len(captured)}"}

    class FakeDatabase:
        @staticmethod
        async def fetchrow(_query, *_args):
            return {"id": "h1", "name": "Demo Hotel"}

        @staticmethod
        async def fetch(_query, *_args):
            return [{
                "id": "rt-1",
                "name": room_name,
                "total_rooms": 5,
                "max_occupancy": 2,
                "currency": room_currency,
                "non_refundable_enabled": False,
                "meal_plans": [],
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

    return run, captured


def test_room_type_with_null_currency_falls_back_to_property_currency():
    """The Lumansa-shaped case: room_type.currency is null, but the booking-db
    hotel has a currency. The rate plan payload must include the property
    currency rather than null (Channex 422'd on null currency)."""
    run, captured = _make_fakes(room_currency=None)
    asyncio.run(run())

    assert captured, "expected at least one create_rate_plan call"
    for kwargs in captured:
        assert kwargs["currency"] == "IDR", (
            "rate plan must use property currency when room currency is null"
        )


def test_room_type_currency_takes_precedence_over_property_currency():
    """If the room_type has its own currency set, that wins — the fallback
    only kicks in when room currency is null/empty."""
    run, captured = _make_fakes(room_currency="USD")
    asyncio.run(run())

    assert captured
    for kwargs in captured:
        assert kwargs["currency"] == "USD"


def test_rate_plan_title_capped_at_channex_max():
    """Long room-type names + channel + meal-plan suffix can blow past Channex's
    255-char title column. Cap defensively."""
    long_name = "A" * 300
    run, captured = _make_fakes(room_currency="IDR", room_name=long_name)
    asyncio.run(run())

    assert captured
    for kwargs in captured:
        assert len(kwargs["title"]) <= provisioning.RATE_PLAN_TITLE_MAX_LENGTH
