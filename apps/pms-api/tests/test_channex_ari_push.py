"""Regression coverage for Channex ARI sync edge cases."""

from datetime import UTC, date, datetime
from decimal import Decimal
from unittest.mock import AsyncMock, patch

import pytest
from app.services.channex.ari_push import _restriction_to_value
from app.services.channex.orchestrator import push_ari_for_room_type


def test_restriction_payload_explicitly_clears_false_closure_flags():
    """Channex treats omitted restriction fields as unchanged.

    When Vayada reopens a date, false stop-sell / CTA / CTD values must be
    sent explicitly so stale closed flags do not survive on OTA channels.
    """

    value = _restriction_to_value(
        {
            "rate": 1_200_000,
            "min_stay_arrival": 1,
            "max_stay": 0,
            "stop_sell": False,
            "closed_to_arrival": False,
            "closed_to_departure": False,
        },
        "channex-property-id",
        "channex-rate-plan-id",
        date(2026, 11, 1),
        date(2026, 12, 31),
    )

    assert value["stop_sell"] == 0
    assert value["closed_to_arrival"] == 0
    assert value["closed_to_departure"] == 0


@pytest.mark.asyncio
async def test_targeted_room_type_ari_sync_pushes_all_rate_plans_for_range():
    start = date(2026, 11, 1)
    end = date(2026, 12, 31)

    rate_plans = [
        {
            "channex_rate_plan_id": "rp-direct-std",
            "channel": "direct",
            "plan_name": "standard",
            "meal_plan_code": 0,
        },
        {
            "channex_rate_plan_id": "rp-bdc-std",
            "channel": "booking_com",
            "plan_name": "standard",
            "meal_plan_code": 1,
        },
        {
            "channex_rate_plan_id": "rp-airbnb-std",
            "channel": "airbnb",
            "plan_name": "standard",
            "meal_plan_code": 0,
        },
    ]

    with (
        patch(
            "app.services.channex.orchestrator.ChannexChannelMarkupRepository.get_markup_map",
            new=AsyncMock(
                return_value={
                    "direct": Decimal(0),
                    "booking_com": Decimal(12),
                    "airbnb": Decimal(8),
                }
            ),
        ),
        patch(
            "app.services.channex.orchestrator.push_availability_for_room_type",
            new=AsyncMock(return_value=True),
        ) as availability,
        patch(
            "app.services.channex.orchestrator.ChannexRatePlanMappingRepository.list_by_room_type_id",
            new=AsyncMock(return_value=rate_plans),
        ),
        patch(
            "app.services.channex.orchestrator.push_restrictions_for_rate_plan",
            new=AsyncMock(return_value=True),
        ) as restrictions,
        patch(
            "app.services.channex.orchestrator.ChannexConnectionRepository.update_last_ari_sync",
            new=AsyncMock(),
        ) as mark_success,
        patch(
            "app.services.channex.orchestrator.ChannexConnectionRepository.record_ari_sync_error",
            new=AsyncMock(),
        ) as mark_failure,
        patch(
            "app.services.channex.orchestrator.datetime",
            autospec=True,
        ) as mock_datetime,
    ):
        mock_datetime.now.return_value = datetime(2026, 1, 1, tzinfo=UTC)

        ok = await push_ari_for_room_type("hotel-1", "room-type-1", start, end)

    assert ok is True
    availability.assert_awaited_once_with(
        "hotel-1",
        "room-type-1",
        start_date=start,
        end_date=end,
    )
    assert restrictions.await_count == 3
    restrictions.assert_any_await(
        "hotel-1",
        "room-type-1",
        "rp-direct-std",
        plan_name="standard",
        channel="direct",
        markup_pct=Decimal(0),
        start_date=start,
        end_date=end,
        meal_plan_code=0,
    )
    restrictions.assert_any_await(
        "hotel-1",
        "room-type-1",
        "rp-bdc-std",
        plan_name="standard",
        channel="booking_com",
        markup_pct=Decimal(12),
        start_date=start,
        end_date=end,
        meal_plan_code=1,
    )
    restrictions.assert_any_await(
        "hotel-1",
        "room-type-1",
        "rp-airbnb-std",
        plan_name="standard",
        channel="airbnb",
        markup_pct=Decimal(8),
        start_date=start,
        end_date=end,
        meal_plan_code=0,
    )
    mark_success.assert_awaited_once_with("hotel-1", datetime(2026, 1, 1, tzinfo=UTC))
    mark_failure.assert_not_awaited()
