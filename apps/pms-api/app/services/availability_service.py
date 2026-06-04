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

from app.repositories.booking_draft_repo import BookingDraftRepository
from app.repositories.room_type_repo import RoomTypeRepository


@dataclass
class StayPricing:
    nightly_rates: list[float]
    room_total: float
    average_nightly_rate: float


def compute_non_refundable_rate(
    room_type: dict, base_rate: float, explicit_rate: float | None
) -> float:
    """Resolve the non-refundable rate for one night from the room config."""
    if not room_type.get("flexible_rate_enabled", True):
        return round(float(base_rate), 2)

    discount = room_type.get("non_refundable_discount")
    if discount is not None and discount > 0:
        return round(float(base_rate) * (1 - float(discount) / 100), 2)

    if explicit_rate is not None and explicit_rate > 0:
        return round(float(explicit_rate), 2)

    return round(float(base_rate), 2)


async def _direct_physical_units_for_stay(
    room_type_id: str,
    check_in: date,
    check_out: date,
) -> int | None:
    from app.repositories.booking_room_repo import BookingRoomRepository
    from app.repositories.room_block_repo import RoomBlockRepository
    from app.repositories.room_repo import RoomRepository

    rooms = await RoomRepository.list_for_room_type(room_type_id)
    if not rooms:
        return None

    room_ids = {str(room["id"]) for room in rooms}
    occupied = await BookingRoomRepository.occupied_room_ids_for_room_type(
        room_type_id, check_in, check_out
    )
    room_blocks = await RoomBlockRepository.list_blocked_rooms_for_room_type(
        room_type_id, check_in, check_out
    )
    blocked_room_ids = {str(block["room_id"]) for block in room_blocks}
    free_units = room_ids - occupied - blocked_room_ids

    return len(free_units)


async def _aggregate_remaining_for_stay(
    room_type_id: str,
    total_rooms: int,
    check_in: date,
    check_out: date,
) -> int:
    remaining = total_rooms
    current = check_in
    while current < check_out:
        next_day = current + timedelta(days=1)
        booked = await RoomTypeRepository.count_booked(room_type_id, current, next_day)
        blocked = await RoomTypeRepository.count_blocked(room_type_id, current, next_day)
        soft_held = await BookingDraftRepository.count_active_for_stay(
            room_type_id, current, next_day
        )
        remaining = min(remaining, total_rooms - booked - blocked - soft_held)
        current = next_day

    return max(0, remaining)


async def remaining_for_stay(
    room_type_id: str,
    total_rooms: int,
    check_in: date,
    check_out: date,
    *,
    hotel_id: str | None = None,
    allow_rearrange: bool = False,
) -> int:
    """Rooms of this type still bookable across the given stay.

    Returns the minimum free inventory across each occupied night, where
    active card-payment drafts (VAY-388) count as soft holds. A room type
    with staggered bookings/blocks across different nights should remain
    bookable as long as every night still has a free unit.
    """
    if check_in >= check_out:
        return 0

    aggregate_remaining = await _aggregate_remaining_for_stay(
        room_type_id, total_rooms, check_in, check_out
    )
    if aggregate_remaining <= 0:
        return 0

    direct_physical_remaining = await _direct_physical_units_for_stay(
        room_type_id, check_in, check_out
    )
    if direct_physical_remaining is None:
        return aggregate_remaining
    if direct_physical_remaining > 0:
        return min(direct_physical_remaining, aggregate_remaining)

    if not allow_rearrange or not hotel_id:
        return 0

    from app.services.room_assignment import find_assignment_for_window

    result = await find_assignment_for_window(
        hotel_id,
        room_type_id,
        check_in,
        check_out,
        auto_rearrange_enabled=True,
    )
    return min(1, aggregate_remaining) if result else 0


def compute_stay_pricing(
    room_type: dict,
    check_in: date,
    check_out: date,
    adults: int | None = None,
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
        resolved_base, resolved_nr = RoomTypeRepository.resolve_rate(room_type, night_date, adults)
        if rate_type == "nonrefundable":
            night_rate = compute_non_refundable_rate(room_type, resolved_base, resolved_nr)
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
