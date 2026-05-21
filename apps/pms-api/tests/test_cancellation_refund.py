"""
Regression tests for `_compute_cancellation_refund` covering the three
rate-type / cancellation paths:

  1. nonrefundable  → always 0 refund (VAY-298)
  2. flexible (hotel-wide policy, ≥ free_days) → 100% refund
  3. flexible (hotel-wide policy, < free_days, partial_pct set) → partial
  4. flexible (room-level tiered partial_refund schedule, VAY-324)
"""

from datetime import date, timedelta
from unittest.mock import AsyncMock, patch

import pytest
from app.models.room_type import _validate_partial_refund_tiers
from app.services.booking_service import _compute_cancellation_refund


def _booking(rate_type: str, days_to_checkin: int = 30, total: float = 200.0) -> dict:
    return {
        "hotel_id": "00000000-0000-0000-0000-000000000001",
        "room_type_id": "00000000-0000-0000-0000-000000000002",
        "check_in": date.today() + timedelta(days=days_to_checkin),
        "total_amount": total,
        "rate_type": rate_type,
    }


async def test_nonrefundable_returns_zero_refund_well_outside_free_window():
    """VAY-298: non-refundable rate must always yield 0 refund, even 30 days out."""
    policy = {"free_cancellation_days": 7, "partial_refund_pct": 50}
    with patch(
        "app.services.booking_service.CancellationPolicyRepository.get_by_hotel_id",
        new=AsyncMock(return_value=policy),
    ):
        amount, pct, free_days = await _compute_cancellation_refund(
            _booking("nonrefundable", days_to_checkin=30)
        )
    assert amount == 0.0
    assert pct == 0.0
    assert free_days == 7


async def test_flexible_full_refund_when_outside_free_window():
    policy = {"free_cancellation_days": 7, "partial_refund_pct": 50}
    with (
        patch(
            "app.services.booking_service.CancellationPolicyRepository.get_by_hotel_id",
            new=AsyncMock(return_value=policy),
        ),
        patch(
            "app.services.booking_service.RoomTypeRepository.get_by_id",
            new=AsyncMock(return_value={"flexible_cancellation_type": "free_cancellation"}),
        ),
    ):
        amount, pct, free_days = await _compute_cancellation_refund(
            _booking("flexible", days_to_checkin=30, total=200.0)
        )
    assert amount == 200.0
    assert pct == 100.0
    assert free_days == 7


async def test_flexible_partial_refund_when_inside_free_window():
    policy = {"free_cancellation_days": 7, "partial_refund_pct": 50}
    with (
        patch(
            "app.services.booking_service.CancellationPolicyRepository.get_by_hotel_id",
            new=AsyncMock(return_value=policy),
        ),
        patch(
            "app.services.booking_service.RoomTypeRepository.get_by_id",
            new=AsyncMock(return_value={"flexible_cancellation_type": "free_cancellation"}),
        ),
    ):
        amount, pct, free_days = await _compute_cancellation_refund(
            _booking("flexible", days_to_checkin=1, total=200.0)
        )
    assert amount == 100.0
    assert pct == 50.0
    assert free_days == 7


# ── Tiered partial-refund schedule (VAY-324) ─────────────────────────────


_TIERED_ROOM = {
    "flexible_cancellation_type": "partial_refund",
    # Sorted descending by min_days_before_check_in (the validator + the
    # migration both enforce this ordering).
    "partial_refund_tiers": [
        {"min_days_before_check_in": 30, "refund_percent": 100},
        {"min_days_before_check_in": 14, "refund_percent": 50},
        {"min_days_before_check_in": 7, "refund_percent": 25},
    ],
}


@pytest.mark.parametrize(
    "days_to_checkin, expected_amount, expected_pct, expected_threshold",
    [
        (45, 200.0, 100.0, 30),  # well outside top tier → full refund
        (30, 200.0, 100.0, 30),  # exactly meets top tier
        (20, 100.0, 50.0, 14),  # falls into mid tier
        (14, 100.0, 50.0, 14),  # exact mid-tier boundary
        (10, 50.0, 25.0, 7),  # falls into bottom tier
        (7, 50.0, 25.0, 7),  # exact bottom-tier boundary
        (3, 0.0, 0.0, 0),  # below all tiers → no refund
    ],
)
async def test_flexible_partial_refund_uses_tier_schedule(
    days_to_checkin,
    expected_amount,
    expected_pct,
    expected_threshold,
):
    policy = {"free_cancellation_days": 7, "partial_refund_pct": 0}
    with (
        patch(
            "app.services.booking_service.CancellationPolicyRepository.get_by_hotel_id",
            new=AsyncMock(return_value=policy),
        ),
        patch(
            "app.services.booking_service.RoomTypeRepository.get_by_id",
            new=AsyncMock(return_value=_TIERED_ROOM),
        ),
    ):
        amount, pct, threshold = await _compute_cancellation_refund(
            _booking("flexible", days_to_checkin=days_to_checkin, total=200.0)
        )
    assert amount == expected_amount
    assert pct == expected_pct
    assert threshold == expected_threshold


async def test_flexible_partial_refund_falls_back_to_legacy_single_tier_when_tiers_empty():
    """Rooms migrated before VAY-324 have an empty tiers list — the legacy
    single (window, percent) pair must keep working until the hotelier opens
    the room editor."""
    policy = {"free_cancellation_days": 7, "partial_refund_pct": 0}
    legacy_room = {
        "flexible_cancellation_type": "partial_refund",
        "partial_refund_tiers": [],
        "partial_refund_cancel_window_days": 30,
        "partial_refund_amount_percent": 50,
    }
    with (
        patch(
            "app.services.booking_service.CancellationPolicyRepository.get_by_hotel_id",
            new=AsyncMock(return_value=policy),
        ),
        patch(
            "app.services.booking_service.RoomTypeRepository.get_by_id",
            new=AsyncMock(return_value=legacy_room),
        ),
    ):
        amount, pct, threshold = await _compute_cancellation_refund(
            _booking("flexible", days_to_checkin=45, total=200.0)
        )
    assert amount == 100.0
    assert pct == 50.0
    assert threshold == 30


def test_partial_refund_tiers_validator_rejects_duplicate_days():
    with pytest.raises(ValueError, match="duplicate"):
        _validate_partial_refund_tiers(
            [
                {"min_days_before_check_in": 7, "refund_percent": 25},
                {"min_days_before_check_in": 7, "refund_percent": 50},
            ]
        )


def test_partial_refund_tiers_validator_rejects_out_of_range():
    with pytest.raises(ValueError, match="0 and 365"):
        _validate_partial_refund_tiers(
            [
                {"min_days_before_check_in": 400, "refund_percent": 50},
            ]
        )
    with pytest.raises(ValueError, match="0 and 100"):
        _validate_partial_refund_tiers(
            [
                {"min_days_before_check_in": 30, "refund_percent": 150},
            ]
        )


def test_partial_refund_tiers_validator_sorts_descending_and_accepts_camel_case():
    out = _validate_partial_refund_tiers(
        [
            {"minDaysBeforeCheckIn": 7, "refundPercent": 25},
            {"minDaysBeforeCheckIn": 30, "refundPercent": 100},
            {"minDaysBeforeCheckIn": 14, "refundPercent": 50},
        ]
    )
    assert out == [
        {"min_days_before_check_in": 30, "refund_percent": 100},
        {"min_days_before_check_in": 14, "refund_percent": 50},
        {"min_days_before_check_in": 7, "refund_percent": 25},
    ]
