"""
Regression tests for `_compute_cancellation_refund` covering the three
rate-type / cancellation paths:

  1. nonrefundable  → always 0 refund (VAY-298)
  2. flexible (hotel-wide policy, ≥ free_days) → 100% refund
  3. flexible (hotel-wide policy, < free_days, partial_pct set) → partial
"""
from datetime import date, timedelta
from unittest.mock import AsyncMock, patch

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
    with patch(
        "app.services.booking_service.CancellationPolicyRepository.get_by_hotel_id",
        new=AsyncMock(return_value=policy),
    ), patch(
        "app.services.booking_service.RoomTypeRepository.get_by_id",
        new=AsyncMock(return_value={"flexible_cancellation_type": "free_cancellation"}),
    ):
        amount, pct, free_days = await _compute_cancellation_refund(
            _booking("flexible", days_to_checkin=30, total=200.0)
        )
    assert amount == 200.0
    assert pct == 100.0
    assert free_days == 7


async def test_flexible_partial_refund_when_inside_free_window():
    policy = {"free_cancellation_days": 7, "partial_refund_pct": 50}
    with patch(
        "app.services.booking_service.CancellationPolicyRepository.get_by_hotel_id",
        new=AsyncMock(return_value=policy),
    ), patch(
        "app.services.booking_service.RoomTypeRepository.get_by_id",
        new=AsyncMock(return_value={"flexible_cancellation_type": "free_cancellation"}),
    ):
        amount, pct, free_days = await _compute_cancellation_refund(
            _booking("flexible", days_to_checkin=1, total=200.0)
        )
    assert amount == 100.0
    assert pct == 50.0
    assert free_days == 7
