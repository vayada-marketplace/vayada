"""Daily price override regression coverage (VAY-380).

The bug: overrides set in the PMS Live Rate Preview were registered in the
DB but the Booking Engine and OTAs kept serving the season rate. Server-side
``resolve_rate`` already prefers ``daily_rates`` over seasons; the missing
piece on the backend was a Channex ARI push when ``daily_rates`` changed —
without it OTAs only saw the new rate the next time something else
triggered a sync. These tests pin the resolver behavior so the override
contract stays load-bearing across both sales channels.
"""
from datetime import date
from decimal import Decimal

from app.repositories.room_type_repo import RoomTypeRepository
from app.services.channex.ari_push import _build_restriction_entry


def _make_room(**overrides):
    base = {
        "id": "rt-1",
        "base_rate": 1_400_000,
        "non_refundable_rate": None,
        "non_refundable_discount": 5,
        "currency": "IDR",
        "operating_periods": [],
        "seasons": [
            {"name": "Jan-Jun", "tier": "Mid", "from": "01-01", "to": "06-30", "rate": "1600000"},
        ],
        "daily_rates": {},
        "weekend_surcharge": "+0%",
        "min_stay": 1,
        "max_stay": 0,
        "meal_plans": [],
    }
    base.update(overrides)
    return base


def test_daily_override_beats_season_rate():
    room = _make_room(daily_rates={"2026-05-07": 1_100_000})
    base, _ = RoomTypeRepository.resolve_rate(room, date(2026, 5, 7))
    assert base == 1_100_000


def test_resolver_falls_back_to_season_when_no_override_for_date():
    room = _make_room(daily_rates={"2026-05-07": 1_100_000})
    base, _ = RoomTypeRepository.resolve_rate(room, date(2026, 5, 8))
    assert base == 1_600_000


def test_daily_override_ignores_weekend_surcharge():
    # May 8 2026 is a Friday — would normally get +20% on top of the season
    # rate. An explicit override is the user's intent, so no surcharge.
    room = _make_room(
        daily_rates={"2026-05-08": 1_100_000},
        weekend_surcharge="+20%",
    )
    base, _ = RoomTypeRepository.resolve_rate(room, date(2026, 5, 8))
    assert base == 1_100_000


def test_daily_override_handles_jsonb_string():
    # asyncpg returns JSONB columns as strings until parse_jsonb decodes
    # them; resolve_rate is called from code paths that don't always go
    # through parse_jsonb (e.g. the Channex push), so the resolver needs
    # to cope with a raw JSON string itself.
    room = _make_room(daily_rates='{"2026-05-07": 1100000}')
    base, _ = RoomTypeRepository.resolve_rate(room, date(2026, 5, 7))
    assert base == 1_100_000


def test_channex_push_uses_daily_override():
    # End-to-end for the Channex side: the rate that goes out to OTAs must
    # come from the override, not the season rate, with channel markup
    # applied on top per the VAY-380 contract.
    room = _make_room(daily_rates={"2026-05-07": 1_100_000})
    entry = _build_restriction_entry(
        room, date(2026, 5, 7),
        plan_name="standard",
        markup_pct=Decimal(10),
        meal_plan_code=0,
    )
    assert entry["rate"] == 1_210_000


def test_patch_room_types_triggers_channex_push_when_daily_rates_change():
    """The bug surfaced because admin_room_types.update_room_type only
    scheduled an ARI push for cancellation/meal-plan fields. Updating
    only daily_rates must also enqueue a push so OTAs see the new rate
    without waiting for an unrelated change to trigger sync.
    """
    import asyncio
    from unittest.mock import AsyncMock, patch

    from app.routers import admin_room_types

    existing = {
        "id": "rt-1",
        "hotel_id": "h-1",
        "name": "Studio with Private Pool",
    }
    updated_room = {**existing, "daily_rates": {"2026-05-07": 1_100_000}}

    pushed = []

    async def fake_push_ari(hotel_id):
        pushed.append(hotel_id)

    async def run():
        with (
            patch.object(admin_room_types, "get_hotel_id", AsyncMock(return_value="h-1")),
            patch.object(
                admin_room_types.RoomTypeRepository,
                "get_by_id",
                AsyncMock(return_value=existing),
            ),
            patch.object(
                admin_room_types.RoomTypeRepository,
                "update",
                AsyncMock(return_value=updated_room),
            ),
            patch.object(
                admin_room_types.RoomRepository,
                "rename_auto_named",
                AsyncMock(return_value=None),
            ),
            patch.object(
                admin_room_types.RoomRepository,
                "heal_stale_room_names",
                AsyncMock(return_value=None),
            ),
            patch.object(admin_room_types, "_room_to_admin", lambda r: r),
            patch.object(admin_room_types, "push_ari_for_hotel", fake_push_ari),
        ):
            payload = admin_room_types.RoomTypeUpdate(daily_rates={"2026-05-07": 1_100_000})
            await admin_room_types.update_room_type(
                room_type_id="rt-1",
                data=payload,
                user_id="u-1",
            )
            # _push_ari_for_daily_rate_change is fired via asyncio.create_task,
            # so yield once for the loop to drain it before assertion.
            await asyncio.sleep(0)

    asyncio.run(run())

    assert pushed == ["h-1"]
