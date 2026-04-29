"""Stay-level availability + pricing primitives.

These wrap ``RoomTypeRepository.count_booked`` / ``count_blocked`` /
``resolve_rate`` so the same rules apply consistently in booking creation
and the guest-facing rooms endpoint. Per-day scans (room blocks,
unavailable-dates, channex availability push) keep their own loops because
each one needs distinct loop-body logic (operating periods, exclude-block,
local-only blocks).
"""
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Optional

from app.repositories.room_type_repo import RoomTypeRepository


@dataclass
class StayPricing:
    nightly_rates: list[float]
    room_total: float
    average_nightly_rate: float


async def remaining_for_stay(
    room_type_id: str,
    total_rooms: int,
    check_in: date,
    check_out: date,
) -> int:
    """Rooms of this type still bookable across the given stay.

    Returns ``max(0, total - booked - blocked)`` using the repository's
    range-aware counters.
    """
    booked = await RoomTypeRepository.count_booked(room_type_id, check_in, check_out)
    blocked = await RoomTypeRepository.count_blocked(room_type_id, check_in, check_out)
    return max(0, total_rooms - booked - blocked)


def compute_stay_pricing(
    room_type: dict,
    check_in: date,
    check_out: date,
    adults: Optional[int] = None,
    rate_type: str = "flexible",
) -> StayPricing:
    """Resolve nightly rates for a stay (seasons, weekend, occupancy,
    daily-rate overrides) and sum into a per-room total.

    Does not apply promo / addon / last-minute discounts — those layer on
    top at the booking level.
    """
    nights = (check_out - check_in).days
    if nights <= 0:
        return StayPricing(nightly_rates=[], room_total=0.0, average_nightly_rate=0.0)

    nightly_rates: list[float] = []
    for i in range(nights):
        night_date = check_in + timedelta(days=i)
        resolved_base, resolved_nr = RoomTypeRepository.resolve_rate(
            room_type, night_date, adults
        )
        if rate_type == "nonrefundable":
            night_rate = resolved_nr if resolved_nr else round(resolved_base * 0.85, 2)
        else:
            night_rate = resolved_base
        nightly_rates.append(night_rate)

    room_total = round(sum(nightly_rates), 2)
    average = round(room_total / nights, 2)
    return StayPricing(
        nightly_rates=nightly_rates,
        room_total=room_total,
        average_nightly_rate=average,
    )
