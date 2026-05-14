"""Same-room-type assignment solver for new bookings (VAY-397).

When a new booking arrives for a room type, the inflow code first tries to
drop it on any single room that's free across the stay window. If none is
free, this module looks for a packing — a reshuffle of existing future
bookings within the same room type — that frees a slot for the new booking
without overlapping anyone else.

Pure function on purpose: callers gather the current state from the database,
hand it to `plan_assignment`, then apply the returned plan atomically.
Keeping the search free of I/O makes it exhaustively testable and trivial to
re-run if the database state changes between calls.

Constraints implemented:
- Checked-in / checked-out bookings are pinned (caller marks `movable=False`).
- Only same-room-type swaps — the caller filters the input set.
- Tie-break: prefer the packing that moves the fewest existing bookings.
- Hard wall-clock + node budget so a worst-case input falls back to
  "Unassigned" rather than wedging the request thread.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from datetime import date
from typing import Optional

logger = logging.getLogger(__name__)


# Sentinel booking id used internally to represent the not-yet-created booking
# we're trying to place. Callers never see this; the returned plan exposes the
# chosen room separately via `new_booking_room_id`.
_NEW_BOOKING_SENTINEL = "__new_booking__"


@dataclass(frozen=True)
class RoomSlot:
    """One room of the target room type."""
    room_id: str
    sort_order: int = 0


@dataclass(frozen=True)
class BookingSlot:
    """An existing booking on a room of the target room type.

    `original_room_id` is None only when the booking is currently unassigned
    (and movable). `movable=False` pins the booking to its current room — used
    for guests who have already checked in or checked out.
    """
    booking_id: str
    original_room_id: Optional[str]
    check_in: date
    check_out: date
    movable: bool = True


@dataclass(frozen=True)
class Move:
    booking_id: str
    from_room_id: Optional[str]
    to_room_id: str


@dataclass
class AssignmentPlan:
    new_booking_room_id: str
    moves: list[Move]


def _overlaps(a_in: date, a_out: date, b_in: date, b_out: date) -> bool:
    # PMS booking dates are half-open [check_in, check_out): a same-day
    # checkout/checkin pair shares no night, so equal boundaries don't overlap.
    return a_in < b_out and b_in < a_out


def plan_assignment(
    rooms: list[RoomSlot],
    existing: list[BookingSlot],
    new_check_in: date,
    new_check_out: date,
    *,
    timeout_seconds: float = 0.5,
    max_nodes: int = 50_000,
) -> Optional[AssignmentPlan]:
    """Return a packing that places the new booking, or None if infeasible.

    `timeout_seconds` and `max_nodes` cap the search so a pathological input
    (heavy overlaps, many movable bookings) cannot stall the request. If the
    cap fires before any packing is found, callers should fall back to the
    Unassigned row exactly as they would today.
    """
    if not rooms or new_check_in >= new_check_out:
        return None

    # Preserve caller order — the DB query hands rooms back in the
    # calendar's display order (sort_order, then numeric room_number
    # prefix), which we want for direct-fit tie-breaking. Re-sorting here
    # by `sort_order` only would pick an arbitrary same-sort-order room
    # as the tiebreaker.
    rooms_sorted = list(rooms)
    room_ids = [r.room_id for r in rooms_sorted]
    room_index = {rid: i for i, rid in enumerate(room_ids)}
    n_rooms = len(rooms_sorted)

    pinned_intervals: list[list[tuple[date, date]]] = [[] for _ in range(n_rooms)]
    for b in existing:
        if b.movable:
            continue
        if b.original_room_id is None:
            # A pinned booking with no room is nonsensical (checked-in guests
            # always sit on a room). Skip defensively rather than crash.
            continue
        idx = room_index.get(b.original_room_id)
        if idx is None:
            continue
        pinned_intervals[idx].append((b.check_in, b.check_out))

    # Direct-fit shortcut. Existing assignment stands; new booking just picks
    # the lowest-sorted room that's free for the stay window.
    current_intervals: list[list[tuple[date, date]]] = [
        list(intervals) for intervals in pinned_intervals
    ]
    for b in existing:
        if not b.movable or b.original_room_id is None:
            continue
        idx = room_index.get(b.original_room_id)
        if idx is None:
            continue
        current_intervals[idx].append((b.check_in, b.check_out))

    for i, rid in enumerate(room_ids):
        if not any(
            _overlaps(new_check_in, new_check_out, ci, co)
            for ci, co in current_intervals[i]
        ):
            return AssignmentPlan(new_booking_room_id=rid, moves=[])

    movable_existing = [b for b in existing if b.movable]
    new_slot = BookingSlot(
        booking_id=_NEW_BOOKING_SENTINEL,
        original_room_id=None,
        check_in=new_check_in,
        check_out=new_check_out,
        movable=True,
    )
    # Earliest-start-first works as the search order — it's the classic
    # interval-partitioning greedy, which finds a valid packing quickly
    # whenever one exists.
    to_place = sorted(
        movable_existing + [new_slot],
        key=lambda b: (b.check_in, b.check_out, b.booking_id),
    )

    occupancy: list[list[tuple[date, date]]] = [
        list(intervals) for intervals in pinned_intervals
    ]
    assignment: dict[str, int] = {}

    deadline = time.monotonic() + timeout_seconds
    nodes = [0]

    best_moves: list[Optional[int]] = [None]
    best_assignment: list[Optional[dict[str, int]]] = [None]

    def count_moves(asn: dict[str, int]) -> int:
        moves = 0
        for b in movable_existing:
            current_idx = asn.get(b.booking_id)
            if current_idx is None:
                continue
            original_idx = (
                room_index.get(b.original_room_id) if b.original_room_id else None
            )
            if current_idx != original_idx:
                moves += 1
        return moves

    def budget_exhausted() -> bool:
        return nodes[0] >= max_nodes or time.monotonic() > deadline

    def dfs(k: int, partial_moves: int) -> None:
        if budget_exhausted():
            return
        if best_moves[0] is not None and partial_moves >= best_moves[0]:
            # Already worse than the best complete solution — prune.
            return
        if k == len(to_place):
            best_moves[0] = partial_moves
            best_assignment[0] = dict(assignment)
            return

        b = to_place[k]
        original_idx = (
            room_index.get(b.original_room_id) if b.original_room_id else None
        )
        # Try the original room first (free move), then everything else in
        # sort order. The first complete solution found is usually close to
        # optimal because of this ordering.
        order: list[int] = []
        if original_idx is not None:
            order.append(original_idx)
        for i in range(n_rooms):
            if i != original_idx:
                order.append(i)

        for i in order:
            nodes[0] += 1
            if budget_exhausted():
                return
            if any(
                _overlaps(b.check_in, b.check_out, ci, co)
                for ci, co in occupancy[i]
            ):
                continue
            move_cost = 0
            if original_idx is not None and i != original_idx:
                move_cost = 1
            occupancy[i].append((b.check_in, b.check_out))
            assignment[b.booking_id] = i
            dfs(k + 1, partial_moves + move_cost)
            occupancy[i].pop()
            del assignment[b.booking_id]

    dfs(0, 0)

    asn = best_assignment[0]
    if asn is None:
        return None

    new_room_idx = asn[_NEW_BOOKING_SENTINEL]
    moves: list[Move] = []
    for b in movable_existing:
        new_idx = asn[b.booking_id]
        original_idx = (
            room_index.get(b.original_room_id) if b.original_room_id else None
        )
        if new_idx != original_idx:
            moves.append(
                Move(
                    booking_id=b.booking_id,
                    from_room_id=b.original_room_id,
                    to_room_id=room_ids[new_idx],
                )
            )
    return AssignmentPlan(
        new_booking_room_id=room_ids[new_room_idx],
        moves=moves,
    )


# Statuses where the guest has already arrived or departed — moving them in
# the calendar would be operationally disruptive, so the solver pins them.
PINNED_BOOKING_STATUSES = frozenset({"checked_in", "checked_out"})


@dataclass
class AssignmentResult:
    target_room_id: str
    moves: list[Move]

    @property
    def rearranged(self) -> bool:
        return bool(self.moves)


async def find_assignment_for_window(
    hotel_id: str,
    room_type_id: str,
    check_in: date,
    check_out: date,
    *,
    auto_rearrange_enabled: bool,
    exclude_booking_id: Optional[str] = None,
) -> Optional[AssignmentResult]:
    """Find a room for a new (or unassigned) booking, optionally shuffling.

    Returns None if no room is free directly and either auto-rearrange is off
    or the solver can't find a packing in its budget. When the hotel's toggle
    is off this function behaves exactly like the legacy direct-fit lookup —
    same SQL, same sort order — so an OFF hotel sees no behavior change.

    `exclude_booking_id` excludes one booking from the existing-set; the
    cancellation-triggered Unassigned sweep uses this to leave the booking it
    is trying to re-place out of the input set (it's the "new" booking here).
    """
    from app.repositories.booking_repo import BookingRepository
    from app.repositories.room_repo import RoomRepository

    rooms = await RoomRepository.list_for_room_type(room_type_id)
    if not rooms:
        return None

    overlapping = await BookingRepository.list_movable_for_room_type(
        room_type_id, check_in, check_out
    )

    room_slots = [
        RoomSlot(room_id=str(r["id"]), sort_order=r.get("sort_order") or 0)
        for r in rooms
    ]
    booking_slots: list[BookingSlot] = []
    for b in overlapping:
        bid = str(b["id"])
        if exclude_booking_id and bid == exclude_booking_id:
            continue
        rid = b.get("room_id")
        movable = (b.get("status") or "") not in PINNED_BOOKING_STATUSES
        # An unassigned booking with no room can't pin anything anyway —
        # leave it out of the input set since it isn't competing for a slot
        # (it's already in the Unassigned row).
        if rid is None and movable:
            continue
        booking_slots.append(
            BookingSlot(
                booking_id=bid,
                original_room_id=str(rid) if rid is not None else None,
                check_in=b["check_in"],
                check_out=b["check_out"],
                movable=movable,
            )
        )

    plan = plan_assignment(
        room_slots, booking_slots, check_in, check_out,
    )
    if plan is None:
        return None
    if plan.moves and not auto_rearrange_enabled:
        # Direct fit failed and rearranging would require moves — but the
        # hotel opted out, so we behave like the old code and bail.
        return None
    return AssignmentResult(
        target_room_id=plan.new_booking_room_id,
        moves=list(plan.moves),
    )


async def resolve_assignment(
    hotel_id: str,
    room_type_id: str,
    check_in: date,
    check_out: date,
) -> tuple[Optional[str], list[Move]]:
    """Direct fit, or — if the hotel opted in — a rearrangement plan.

    Returns (target_room_id, moves_to_apply). target_room_id is None when no
    fit exists (truly overbooked, or the toggle is off and no direct fit
    exists). Caller must apply moves with `apply_moves_atomic` BEFORE
    inserting the new booking so the target room is genuinely free at
    insert time, then call `record_auto_rearrange` once the new booking's
    id is known.
    """
    from app.repositories.hotel_repo import HotelRepository

    enabled = await HotelRepository.get_auto_rearrange_enabled(hotel_id)
    result = await find_assignment_for_window(
        hotel_id,
        room_type_id,
        check_in,
        check_out,
        auto_rearrange_enabled=enabled,
    )
    if result is None:
        return None, []
    return result.target_room_id, result.moves


async def apply_moves_atomic(moves: list[Move]) -> None:
    """Apply the solver's moves in one indivisible SQL update.

    Called before the new booking is INSERTed so the target room is genuinely
    free at insert time — see VAY-397 ticket's atomicity requirement.
    """
    if not moves:
        return
    from app.repositories.booking_repo import BookingRepository

    await BookingRepository.apply_room_moves(
        [(m.booking_id, m.to_room_id) for m in moves]
    )


async def try_place_unassigned_after_cancellation(
    hotel_id: str,
    room_type_id: str,
    freed_check_in: date,
    freed_check_out: date,
) -> int:
    """Sweep Unassigned bookings of `room_type_id` whose stay window overlaps
    the freed slot and try to place each via the rearrange solver.

    Returns the number of bookings successfully placed. Honors the per-hotel
    `auto_rearrange_enabled` toggle: when off, this is a no-op so an opted-out
    property doesn't get surprise reassignments after cancellations.

    Designed to be invoked fire-and-forget (`asyncio.create_task`) from
    cancellation paths — see VAY-397's "Behavior for already-Unassigned
    bookings" requirement.
    """
    from app.repositories.booking_repo import BookingRepository
    from app.repositories.hotel_repo import HotelRepository

    enabled = await HotelRepository.get_auto_rearrange_enabled(hotel_id)
    if not enabled:
        return 0

    candidates = await BookingRepository.list_unassigned_for_room_type(
        room_type_id, freed_check_in, freed_check_out
    )
    if not candidates:
        return 0

    placed = 0
    for candidate in candidates:
        candidate_id = str(candidate["id"])
        # Exclude this booking from the existing-set since we're treating
        # its window as the "new" booking we're placing.
        result = await find_assignment_for_window(
            hotel_id,
            room_type_id,
            candidate["check_in"],
            candidate["check_out"],
            auto_rearrange_enabled=True,
            exclude_booking_id=candidate_id,
        )
        if result is None:
            continue
        if result.moves:
            await apply_moves_atomic(result.moves)
        await BookingRepository.assign_room(candidate_id, result.target_room_id)
        if result.moves:
            # The candidate is the booking that triggered the moves — record
            # the audit trail against it just like the new-booking path.
            booking_row = await BookingRepository.get_by_id(candidate_id)
            guest_name = "guest"
            if booking_row:
                guest_name = (
                    f"{booking_row.get('guest_first_name', '')} "
                    f"{booking_row.get('guest_last_name', '')}"
                ).strip() or "guest"
            await record_auto_rearrange(
                hotel_id=hotel_id,
                moves=result.moves,
                triggered_by_booking_id=candidate_id,
                triggered_by_guest_name=guest_name,
            )
        placed += 1
        logger.info(
            "Auto-placed unassigned booking %s after cancellation freed slot",
            candidate_id,
        )

    return placed


async def record_auto_rearrange(
    *,
    hotel_id: str,
    moves: list[Move],
    triggered_by_booking_id: str,
    triggered_by_guest_name: str,
    actor_user_id: Optional[str] = None,
) -> None:
    """Write one summary event on the triggering booking + one per moved
    booking. The summary event is what the calendar reads to render the
    "Auto-rearranged on assignment of {guest}" indicator; the per-booking
    events let staff trace which guest moved when from the booking history.
    """
    if not moves:
        return
    from app.repositories.booking_event_repo import BookingEventRepository

    for m in moves:
        await BookingEventRepository.record(
            booking_id=m.booking_id,
            hotel_id=hotel_id,
            event_type="auto_rearranged_move",
            payload={
                "from_room_id": m.from_room_id,
                "to_room_id": m.to_room_id,
                "triggered_by_booking_id": triggered_by_booking_id,
            },
            actor_user_id=actor_user_id,
        )
    await BookingEventRepository.record(
        booking_id=triggered_by_booking_id,
        hotel_id=hotel_id,
        event_type="auto_rearranged",
        payload={
            "guest_name": triggered_by_guest_name,
            "moves": [
                {
                    "booking_id": m.booking_id,
                    "from_room_id": m.from_room_id,
                    "to_room_id": m.to_room_id,
                }
                for m in moves
            ],
        },
        actor_user_id=actor_user_id,
    )
    logger.info(
        "Auto-rearranged %d booking(s) to place %s",
        len(moves), triggered_by_booking_id,
    )
