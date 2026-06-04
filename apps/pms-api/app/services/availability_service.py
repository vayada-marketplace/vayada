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

from app.database import Database
from app.repositories.booking_draft_repo import BookingDraftRepository
from app.repositories.room_type_repo import RoomTypeRepository


@dataclass
class StayPricing:
    nightly_rates: list[float]
    room_total: float
    average_nightly_rate: float


async def _max_soft_holds_for_stay(room_type_id: str, check_in: date, check_out: date) -> int:
    held = 0
    current = check_in
    while current < check_out:
        next_day = current + timedelta(days=1)
        held = max(
            held,
            await BookingDraftRepository.count_active_for_stay(room_type_id, current, next_day),
        )
        current = next_day
    return held


async def _max_type_level_blocks_for_stay(
    room_type_id: str, check_in: date, check_out: date
) -> int:
    blocked = 0
    current = check_in
    while current < check_out:
        next_day = current + timedelta(days=1)
        count = await Database.fetchval(
            """
            SELECT COALESCE(SUM(blocked_count), 0) FROM room_blocks
            WHERE room_type_id = $1
              AND room_id IS NULL
              AND start_date < $3
              AND end_date > $2
            """,
            room_type_id,
            current,
            next_day,
        )
        blocked = max(blocked, count or 0)
        current = next_day
    return blocked


async def _max_unassigned_booked_units_for_stay(
    room_type_id: str, check_in: date, check_out: date
) -> int:
    unassigned = 0
    current = check_in
    while current < check_out:
        next_day = current + timedelta(days=1)
        count = await Database.fetchval(
            """
            WITH extra_rooms AS (
                SELECT booking_id, COUNT(*) AS extra_count
                FROM booking_rooms
                GROUP BY booking_id
            )
            SELECT COALESCE(
                SUM(
                    GREATEST(
                        COALESCE(b.number_of_rooms, 1)
                        - (
                            CASE WHEN b.room_id IS NOT NULL THEN 1 ELSE 0 END
                            + COALESCE(er.extra_count, 0)
                        ),
                        0
                    )
                ),
                0
            )
            FROM bookings b
            LEFT JOIN extra_rooms er ON er.booking_id = b.id
            WHERE b.room_type_id = $1
              AND b.status IN ('pending', 'confirmed', 'checked_in', 'in_house')
              AND b.check_in < $3
              AND b.check_out > $2
              AND NOT (
                b.status = 'pending'
                AND b.payment_status = 'unpaid'
                AND b.created_at < NOW() - INTERVAL '30 minutes'
              )
            """,
            room_type_id,
            current,
            next_day,
        )
        unassigned = max(unassigned, count or 0)
        current = next_day
    return unassigned


async def _remaining_physical_units_for_stay(
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

    type_level_blocks = await _max_type_level_blocks_for_stay(room_type_id, check_in, check_out)
    unassigned_bookings = await _max_unassigned_booked_units_for_stay(
        room_type_id, check_in, check_out
    )
    soft_held = await _max_soft_holds_for_stay(room_type_id, check_in, check_out)
    return max(0, len(free_units) - type_level_blocks - unassigned_bookings - soft_held)


async def remaining_for_stay(
    room_type_id: str,
    total_rooms: int,
    check_in: date,
    check_out: date,
) -> int:
    """Rooms of this type still bookable across the given stay.

    Returns the minimum free inventory across each occupied night, where
    active card-payment drafts (VAY-388) count as soft holds. A room type
    with staggered bookings/blocks across different nights should remain
    bookable as long as every night still has a free unit.
    """
    if check_in >= check_out:
        return 0

    physical_remaining = await _remaining_physical_units_for_stay(room_type_id, check_in, check_out)
    if physical_remaining is not None:
        return physical_remaining

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
