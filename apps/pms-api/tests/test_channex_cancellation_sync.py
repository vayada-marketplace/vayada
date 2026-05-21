"""Unit tests for Channex cancellation-policy sync (VAY-297)."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from app.services.channex_sync_service import (
    _build_cancellation_policy,
    push_cancellation_policy_for_room_type,
)

# ── _build_cancellation_policy ────────────────────────────────────────


def test_build_cancellation_policy_free():
    room_type = {"flexible_cancellation_type": "free"}
    policies = _build_cancellation_policy(room_type, "direct")
    assert policies == [
        {"days_before_arrival": 0, "penalty_type": "percent", "penalty_value": 0},
    ]


def test_build_cancellation_policy_partial_refund():
    room_type = {
        "flexible_cancellation_type": "partial_refund",
        "partial_refund_cancel_window_days": 14,
        "partial_refund_amount_percent": 75,
    }
    policies = _build_cancellation_policy(room_type, "booking_com")
    # Free up to 14 days, then keep 25% (since refund 75%) inside the window.
    assert policies == [
        {"days_before_arrival": 14, "penalty_type": "percent", "penalty_value": 0},
        {"days_before_arrival": 0, "penalty_type": "percent", "penalty_value": 25},
    ]


def test_build_cancellation_policy_partial_refund_defaults():
    room_type = {"flexible_cancellation_type": "partial_refund"}
    policies = _build_cancellation_policy(room_type, "direct")
    # Defaults: 30-day window, 50% refund -> keep 50%.
    assert policies == [
        {"days_before_arrival": 30, "penalty_type": "percent", "penalty_value": 0},
        {"days_before_arrival": 0, "penalty_type": "percent", "penalty_value": 50},
    ]


def test_build_cancellation_policy_airbnb_skipped():
    room_type = {"flexible_cancellation_type": "partial_refund"}
    assert _build_cancellation_policy(room_type, "airbnb") is None


def test_build_cancellation_policy_missing_field_defaults_to_free():
    # No flexible_cancellation_type set at all -> "free" default.
    assert _build_cancellation_policy({}, "direct") == [
        {"days_before_arrival": 0, "penalty_type": "percent", "penalty_value": 0},
    ]


# ── push_cancellation_policy_for_room_type ────────────────────────────


@pytest.mark.asyncio
async def test_push_skips_when_no_active_connection():
    with (
        patch(
            "app.services.channex_sync_service.ChannexConnectionRepository.get_by_hotel_id",
            new_callable=AsyncMock,
        ) as get_conn,
        patch(
            "app.services.channex_sync_service.channex_service.update_rate_plan_cancellation_policy",
            new_callable=AsyncMock,
        ) as update_rp,
    ):
        get_conn.return_value = None
        await push_cancellation_policy_for_room_type("h1", "rt1")
        update_rp.assert_not_called()


@pytest.mark.asyncio
async def test_push_calls_update_for_standard_plans_only():
    rate_plans = [
        {
            "channex_rate_plan_id": "rp-direct-std",
            "channel": "direct",
            "plan_name": "standard",
        },
        {
            "channex_rate_plan_id": "rp-direct-nr",
            "channel": "direct",
            "plan_name": "non_refundable",
        },
        {
            "channex_rate_plan_id": "rp-bdc-std",
            "channel": "booking_com",
            "plan_name": "standard",
        },
        {
            "channex_rate_plan_id": "rp-airbnb-std",
            "channel": "airbnb",
            "plan_name": "standard",
        },
    ]
    room_type = {
        "flexible_cancellation_type": "partial_refund",
        "partial_refund_cancel_window_days": 7,
        "partial_refund_amount_percent": 60,
    }

    with (
        patch(
            "app.services.channex_sync_service.ChannexConnectionRepository.get_by_hotel_id",
            new_callable=AsyncMock,
        ) as get_conn,
        patch(
            "app.services.channex_sync_service.RoomTypeRepository.get_by_id",
            new_callable=AsyncMock,
        ) as get_rt,
        patch(
            "app.services.channex_sync_service.ChannexRatePlanMappingRepository.list_by_room_type_id",
            new_callable=AsyncMock,
        ) as list_rps,
        patch(
            "app.services.channex_sync_service.channex_service.get_platform_api_key",
            return_value="key",
        ),
        patch(
            "app.services.channex_sync_service.channex_service.update_rate_plan_cancellation_policy",
            new_callable=AsyncMock,
        ) as update_rp,
    ):
        get_conn.return_value = {
            "is_active": True,
            "channex_property_id": "prop-1",
        }
        get_rt.return_value = room_type
        list_rps.return_value = rate_plans

        await push_cancellation_policy_for_room_type("h1", "rt1")

    # Direct + Booking.com standard plans get updated; non_refundable and
    # airbnb are skipped.
    called_plans = sorted(c.args[1] for c in update_rp.await_args_list)
    assert called_plans == ["rp-bdc-std", "rp-direct-std"]

    # Each call should send the partial-refund policy structure.
    for c in update_rp.await_args_list:
        assert c.kwargs["policies"] == [
            {"days_before_arrival": 7, "penalty_type": "percent", "penalty_value": 0},
            {"days_before_arrival": 0, "penalty_type": "percent", "penalty_value": 40},
        ]


@pytest.mark.asyncio
async def test_push_swallows_channex_errors():
    """A failure on one rate plan should not abort the others or raise."""
    rate_plans = [
        {"channex_rate_plan_id": "rp1", "channel": "direct", "plan_name": "standard"},
        {"channex_rate_plan_id": "rp2", "channel": "booking_com", "plan_name": "standard"},
    ]
    with (
        patch(
            "app.services.channex_sync_service.ChannexConnectionRepository.get_by_hotel_id",
            new_callable=AsyncMock,
            return_value={"is_active": True, "channex_property_id": "p"},
        ),
        patch(
            "app.services.channex_sync_service.RoomTypeRepository.get_by_id",
            new_callable=AsyncMock,
            return_value={"flexible_cancellation_type": "free"},
        ),
        patch(
            "app.services.channex_sync_service.ChannexRatePlanMappingRepository.list_by_room_type_id",
            new_callable=AsyncMock,
            return_value=rate_plans,
        ),
        patch(
            "app.services.channex_sync_service.channex_service.get_platform_api_key",
            return_value="key",
        ),
        patch(
            "app.services.channex_sync_service.channex_service.update_rate_plan_cancellation_policy",
            new_callable=AsyncMock,
            side_effect=[Exception("boom"), {"id": "rp2"}],
        ) as update_rp,
    ):
        # Should not raise.
        await push_cancellation_policy_for_room_type("h1", "rt1")
        assert update_rp.await_count == 2
