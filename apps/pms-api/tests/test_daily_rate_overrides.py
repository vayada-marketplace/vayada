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
        room,
        date(2026, 5, 7),
        plan_name="standard",
        markup_pct=Decimal(10),
        meal_plan_code=0,
    )
    assert entry["rate"] == 1_210_000


def test_channex_push_uses_season_stay_restrictions():
    room = _make_room(
        seasons=[
            {
                "name": "May",
                "tier": "Mid",
                "from": "05-01",
                "to": "05-31",
                "rate": "1600000",
                "minStay": 2,
                "maxStay": 14,
            }
        ]
    )
    entry = _build_restriction_entry(room, date(2026, 5, 7))
    assert entry["min_stay_arrival"] == 2
    assert entry["max_stay"] == 14


def _run_update_room_type_capture_pushes(
    payload_kwargs: dict,
    *,
    connection_active: bool = True,
):
    """Drive admin_room_types.update_room_type with the given update payload
    and report which hotel_ids ended up in push_ari_for_hotel. Used by the
    auto-sync trigger tests below.
    """
    import asyncio
    from unittest.mock import AsyncMock, patch

    from app.routers import admin_room_types

    existing = {
        "id": "rt-1",
        "hotel_id": "h-1",
        "name": "Studio with Private Pool",
    }
    updated_room = {**existing, **{k: v for k, v in payload_kwargs.items()}}

    pushed: list[str] = []

    async def fake_push_ari(hotel_id):
        pushed.append(hotel_id)

    conn = {"is_active": connection_active} if connection_active is not None else None

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
            patch.object(
                admin_room_types.ChannexConnectionRepository,
                "get_by_hotel_id",
                AsyncMock(return_value=conn),
            ),
        ):
            payload = admin_room_types.RoomTypeUpdate(**payload_kwargs)
            await admin_room_types.update_room_type(
                room_type_id="rt-1",
                data=payload,
                user_id="u-1",
            )
            # The push is fired via asyncio.create_task; yield to the loop
            # so the task drains before the test reads `pushed`.
            await asyncio.sleep(0)
            await asyncio.sleep(0)

    asyncio.run(run())
    return pushed


def test_patch_room_types_triggers_channex_push_when_daily_rates_change():
    """The bug surfaced because admin_room_types.update_room_type only
    scheduled an ARI push for cancellation/meal-plan fields. Updating
    only daily_rates must also enqueue a push so OTAs see the new rate
    without waiting for an unrelated change to trigger sync.
    """
    pushed = _run_update_room_type_capture_pushes(
        {"daily_rates": {"2026-05-07": 1_100_000}},
    )
    assert pushed == ["h-1"]


def test_patch_room_types_triggers_channex_push_for_seasons():
    # VAY-391: editing season rates must also flow to OTAs without the
    # user having to click "Sync Availability & Rates" manually.
    pushed = _run_update_room_type_capture_pushes(
        {"seasons": [{"name": "High", "from": "07-01", "to": "08-31", "rate": "2000000"}]},
    )
    assert pushed == ["h-1"]


def test_patch_room_types_triggers_channex_push_for_operating_periods():
    pushed = _run_update_room_type_capture_pushes(
        {"operating_periods": [{"from": "2026-06-01", "to": "2026-09-30"}]},
    )
    assert pushed == ["h-1"]


def test_patch_room_types_triggers_channex_push_for_weekend_surcharge():
    pushed = _run_update_room_type_capture_pushes({"weekend_surcharge": "+15%"})
    assert pushed == ["h-1"]


def test_patch_room_types_skips_channex_push_for_cosmetic_fields():
    # Renaming the room type or rewriting its description must NOT fire an
    # ARI push — OTAs don't need a re-send for those.
    pushed = _run_update_room_type_capture_pushes(
        {"name": "Garden Suite Renamed", "description": "Updated copy."},
    )
    assert pushed == []


def test_patch_room_types_silent_skip_when_channex_disconnected():
    # Hotels without an active Channex connection must save without a
    # push attempt and without surfacing any error (VAY-391 edge case).
    pushed = _run_update_room_type_capture_pushes(
        {"daily_rates": {"2026-05-07": 1_100_000}},
        connection_active=False,
    )
    assert pushed == []
