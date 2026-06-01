"""DB-backed tests for the auto-rearrange orchestration (VAY-397).

The pure solver is exercised in test_room_assignment.py. These integration
tests cover the orchestration layer that sits on top of it:
- `resolve_assignment` reads from the DB and respects the per-hotel toggle.
- `try_place_unassigned_after_cancellation` actually places candidates and
  writes audit rows.
- The Channex-inbound path picks rooms via the solver.
"""

import json as _json

from app.database import Database
from app.services.room_assignment import (
    resolve_assignment,
    resolve_room_assignments,
    try_place_unassigned_after_cancellation,
)

from tests.conftest import (
    create_test_booking,
    create_test_room_block,
)


async def _set_room(booking_id, room_id):
    await Database.execute(
        "UPDATE bookings SET room_id = $1 WHERE id = $2",
        room_id,
        booking_id,
    )


async def _set_status(booking_id, status):
    await Database.execute(
        "UPDATE bookings SET status = $1 WHERE id = $2",
        status,
        booking_id,
    )


class TestResolveAssignment:
    async def test_direct_fit_when_a_room_is_free(self, client, hotel_with_rooms):
        hotel = hotel_with_rooms["hotel"]
        rt = hotel_with_rooms["room"]
        rooms = hotel_with_rooms["rooms"]

        # rooms[0] is busy for the window; rooms[1..] are free.
        existing = await create_test_booking(
            str(hotel["id"]),
            str(rt["id"]),
            check_in="2026-05-23",
            check_out="2026-05-26",
            status="confirmed",
        )
        await _set_room(existing["id"], rooms[0]["id"])

        target, moves = await resolve_assignment(
            str(hotel["id"]),
            str(rt["id"]),
            existing["check_in"].__class__.fromisoformat("2026-05-22"),
            existing["check_in"].__class__.fromisoformat("2026-05-27"),
        )
        assert target == str(rooms[1]["id"])
        assert moves == []

    async def test_toggle_off_disables_rearrange(self, client, hotel_with_rooms):
        """Direct fit fails on every room; with the toggle off, we must not
        invent a packing — we should return None (caller falls back to
        Unassigned). With the toggle on, the solver should find a packing.
        """
        from datetime import date

        hotel = hotel_with_rooms["hotel"]
        rt = hotel_with_rooms["room"]
        rooms = hotel_with_rooms["rooms"]

        # Block every room for some portion of [22, 27).
        for idx, (ci, co) in enumerate(
            [
                ("2026-05-23", "2026-05-26"),
                ("2026-05-25", "2026-05-28"),
                ("2026-05-22", "2026-05-24"),
                ("2026-05-21", "2026-05-23"),  # rooms[3]
                ("2026-05-26", "2026-05-29"),  # rooms[4]
            ]
        ):
            b = await create_test_booking(
                str(hotel["id"]),
                str(rt["id"]),
                check_in=ci,
                check_out=co,
                status="confirmed",
                guest_email=f"g{idx}@example.com",
            )
            await _set_room(b["id"], rooms[idx]["id"])

        # Toggle OFF — should return None.
        await Database.execute(
            "UPDATE hotels SET auto_rearrange_enabled = FALSE WHERE id = $1",
            hotel["id"],
        )
        target, moves = await resolve_assignment(
            str(hotel["id"]),
            str(rt["id"]),
            date(2026, 5, 22),
            date(2026, 5, 27),
        )
        # With the toggle off and no direct fit, both target and moves must
        # be empty — caller treats this as "Unassigned".
        assert target is None
        assert moves == []

        # Toggle ON — solver should find at least one valid packing.
        await Database.execute(
            "UPDATE hotels SET auto_rearrange_enabled = TRUE WHERE id = $1",
            hotel["id"],
        )
        target_on, _ = await resolve_assignment(
            str(hotel["id"]),
            str(rt["id"]),
            date(2026, 5, 22),
            date(2026, 5, 27),
        )
        # 5 rooms with overlapping but coverable windows — packing should
        # exist.
        assert target_on is not None


class TestBlockedRoomExclusion:
    """VAY-564: manual room blocks must be treated as unavailable inventory."""

    async def test_blocked_room_skipped_available_room_chosen(self, client, hotel_with_rooms):
        """Exact repro from the bug report: rooms[0] blocked, rooms[1] free →
        assignment must land on rooms[1], not the blocked rooms[0]."""
        from datetime import date

        hotel = hotel_with_rooms["hotel"]
        rt = hotel_with_rooms["room"]
        rooms = hotel_with_rooms["rooms"]

        await create_test_room_block(
            str(hotel["id"]),
            str(rt["id"]),
            start_date="2026-07-11",
            end_date="2026-07-19",
            room_id=str(rooms[0]["id"]),
            reason="Liz",
        )

        target, moves = await resolve_assignment(
            str(hotel["id"]),
            str(rt["id"]),
            date(2026, 7, 13),
            date(2026, 7, 19),
        )

        assert target is not None
        assert target != str(rooms[0]["id"]), "must not assign into the blocked room"
        assert moves == []

    async def test_partial_overlap_still_excluded(self, client, hotel_with_rooms):
        """Block Jul 11-19, booking Jul 18-25: single-night overlap still excludes."""
        from datetime import date

        hotel = hotel_with_rooms["hotel"]
        rt = hotel_with_rooms["room"]
        rooms = hotel_with_rooms["rooms"]

        await create_test_room_block(
            str(hotel["id"]),
            str(rt["id"]),
            start_date="2026-07-11",
            end_date="2026-07-19",
            room_id=str(rooms[0]["id"]),
        )

        target, _moves = await resolve_assignment(
            str(hotel["id"]),
            str(rt["id"]),
            date(2026, 7, 18),
            date(2026, 7, 25),
        )

        assert target is not None
        assert target != str(rooms[0]["id"])

    async def test_all_rooms_blocked_returns_none(self, client, hotel_with_rooms):
        """All units blocked for the window → no room available → returns None."""
        from datetime import date

        hotel = hotel_with_rooms["hotel"]
        rt = hotel_with_rooms["room"]
        rooms = hotel_with_rooms["rooms"]

        for room in rooms:
            await create_test_room_block(
                str(hotel["id"]),
                str(rt["id"]),
                start_date="2026-07-13",
                end_date="2026-07-19",
                room_id=str(room["id"]),
            )

        target, _moves = await resolve_assignment(
            str(hotel["id"]),
            str(rt["id"]),
            date(2026, 7, 13),
            date(2026, 7, 19),
        )

        assert target is None

    async def test_auto_rearrange_never_moves_into_blocked_room(self, client, hotel_with_rooms):
        """Solver must not shuffle an existing booking into a blocked room
        even when that is the only way to place the new booking."""
        from datetime import date

        hotel = hotel_with_rooms["hotel"]
        rt = hotel_with_rooms["room"]
        rooms = hotel_with_rooms["rooms"]

        # Enable rearrange so the solver is allowed to shuffle.
        await Database.execute(
            "UPDATE hotels SET auto_rearrange_enabled = TRUE WHERE id = $1",
            hotel["id"],
        )

        # Place a booking on rooms[1] that spans the new booking's window.
        existing = await create_test_booking(
            str(hotel["id"]),
            str(rt["id"]),
            check_in="2026-07-10",
            check_out="2026-07-20",
            status="confirmed",
        )
        await Database.execute(
            "UPDATE bookings SET room_id = $1 WHERE id = $2",
            rooms[1]["id"],
            existing["id"],
        )

        # Block rooms[0] — the only other room that could host the existing
        # booking if the solver tried to move it there to free up rooms[1].
        for room in rooms:
            if room["id"] != rooms[1]["id"]:
                await create_test_room_block(
                    str(hotel["id"]),
                    str(rt["id"]),
                    start_date="2026-07-10",
                    end_date="2026-07-20",
                    room_id=str(room["id"]),
                )

        # No valid packing exists — the solver must not move the booking into
        # a blocked room and must return None instead.
        target, _moves = await resolve_assignment(
            str(hotel["id"]),
            str(rt["id"]),
            date(2026, 7, 13),
            date(2026, 7, 19),
        )

        assert target is None, "solver must not place the booking into a blocked room"

    async def test_multi_room_path_skips_blocked_room(self, client, hotel_with_rooms):
        """resolve_room_assignments (count>1) must also honour blocks."""
        from datetime import date

        hotel = hotel_with_rooms["hotel"]
        rt = hotel_with_rooms["room"]
        rooms = hotel_with_rooms["rooms"]

        # Block rooms[0].
        await create_test_room_block(
            str(hotel["id"]),
            str(rt["id"]),
            start_date="2026-07-13",
            end_date="2026-07-19",
            room_id=str(rooms[0]["id"]),
        )

        primary, extras, moves = await resolve_room_assignments(
            str(hotel["id"]),
            str(rt["id"]),
            date(2026, 7, 13),
            date(2026, 7, 19),
            count=2,
        )

        assert primary is not None
        all_chosen = ([primary] + extras) if primary else []
        assert str(rooms[0]["id"]) not in all_chosen, (
            "multi-room path must not assign into a blocked room"
        )


class TestUnassignedSweep:
    async def test_places_unassigned_after_cancellation_frees_slot(self, client, hotel_with_rooms):
        """Unassigned booking exists; another booking on the same room type
        cancels and frees up a slot that the unassigned booking now fits
        directly. Sweep should assign it and emit no movement audit (no
        moves were needed, just a direct fit)."""
        from datetime import date

        hotel = hotel_with_rooms["hotel"]
        rt = hotel_with_rooms["room"]
        rooms = hotel_with_rooms["rooms"]

        # All rooms occupied across [22, 27): unassigned booking sits in row.
        for idx, room in enumerate(rooms):
            occupant = await create_test_booking(
                str(hotel["id"]),
                str(rt["id"]),
                check_in="2026-05-22",
                check_out="2026-05-27",
                status="confirmed",
                guest_email=f"occ{idx}@example.com",
            )
            await _set_room(occupant["id"], room["id"])

        # Unassigned booking waiting for a slot.
        unassigned = await create_test_booking(
            str(hotel["id"]),
            str(rt["id"]),
            check_in="2026-05-22",
            check_out="2026-05-27",
            status="confirmed",
            guest_email="waiting@example.com",
        )
        # leave room_id NULL

        # Cancel one occupant — simulate the freed slot.
        first_occupant_id = await Database.fetchval(
            "SELECT id FROM bookings WHERE hotel_id = $1 AND guest_email = $2",
            hotel["id"],
            "occ0@example.com",
        )
        await _set_status(str(first_occupant_id), "cancelled")

        placed = await try_place_unassigned_after_cancellation(
            str(hotel["id"]),
            str(rt["id"]),
            date(2026, 5, 22),
            date(2026, 5, 27),
        )
        assert placed == 1

        # The unassigned booking should now have rooms[0] assigned to it.
        row = await Database.fetchrow(
            "SELECT room_id FROM bookings WHERE id = $1",
            unassigned["id"],
        )
        assert row["room_id"] is not None
        assert str(row["room_id"]) == str(rooms[0]["id"])

    async def test_toggle_off_skips_sweep(self, client, hotel_with_rooms):
        """When auto_rearrange is off, the sweep is a no-op even if a
        booking could be placed."""
        from datetime import date

        hotel = hotel_with_rooms["hotel"]
        rt = hotel_with_rooms["room"]
        rooms = hotel_with_rooms["rooms"]

        await Database.execute(
            "UPDATE hotels SET auto_rearrange_enabled = FALSE WHERE id = $1",
            hotel["id"],
        )

        unassigned = await create_test_booking(
            str(hotel["id"]),
            str(rt["id"]),
            check_in="2026-05-22",
            check_out="2026-05-27",
            status="confirmed",
        )
        # Everything else free — direct fit on rooms[0] is trivially available.
        placed = await try_place_unassigned_after_cancellation(
            str(hotel["id"]),
            str(rt["id"]),
            date(2026, 5, 22),
            date(2026, 5, 27),
        )
        # Sweep is gated on the toggle, regardless of feasibility.
        assert placed == 0
        row = await Database.fetchrow(
            "SELECT room_id FROM bookings WHERE id = $1",
            unassigned["id"],
        )
        assert row["room_id"] is None

    async def test_records_audit_event_when_moves_occur(self, client, hotel_with_rooms):
        """When the sweep needs a rearrangement (not just a direct fit),
        an `auto_rearranged` event is written on the placed booking and
        an `auto_rearranged_move` event on each moved booking."""
        from datetime import date

        hotel = hotel_with_rooms["hotel"]
        rt = hotel_with_rooms["room"]
        rooms = hotel_with_rooms["rooms"]

        # 3-room scenario where the unassigned booking needs a swap.
        # rooms[0] busy 23–26 (a)
        # rooms[1] busy 25–28 (b)
        # rooms[2] busy 22–24 (c)
        # rooms[3] busy 21–23 + 26–29
        # rooms[4] busy 21–23 + 26–29
        # Unassigned: 22–27 — single-swap on rooms[0..2] would place it.
        for idx, ranges in enumerate(
            [
                [("2026-05-23", "2026-05-26")],
                [("2026-05-25", "2026-05-28")],
                [("2026-05-22", "2026-05-24")],
                [("2026-05-21", "2026-05-23"), ("2026-05-26", "2026-05-29")],
                [("2026-05-21", "2026-05-23"), ("2026-05-26", "2026-05-29")],
            ]
        ):
            for ci, co in ranges:
                b = await create_test_booking(
                    str(hotel["id"]),
                    str(rt["id"]),
                    check_in=ci,
                    check_out=co,
                    status="confirmed",
                    guest_email=f"occ{idx}-{ci}@example.com",
                )
                await _set_room(b["id"], rooms[idx]["id"])

        unassigned = await create_test_booking(
            str(hotel["id"]),
            str(rt["id"]),
            check_in="2026-05-22",
            check_out="2026-05-27",
            status="confirmed",
            guest_email="waiting@example.com",
        )

        placed = await try_place_unassigned_after_cancellation(
            str(hotel["id"]),
            str(rt["id"]),
            date(2026, 5, 22),
            date(2026, 5, 27),
        )
        assert placed == 1

        # `auto_rearranged` event recorded on the placed booking.
        ev = await Database.fetchrow(
            "SELECT event_type, payload FROM booking_events "
            "WHERE booking_id = $1 AND event_type = 'auto_rearranged'",
            unassigned["id"],
        )
        assert ev is not None
        payload = ev["payload"] if isinstance(ev["payload"], dict) else _json.loads(ev["payload"])
        assert payload["moves"], "expected at least one move in payload"
        # Each moved booking has its own audit row.
        for m in payload["moves"]:
            row = await Database.fetchrow(
                "SELECT 1 FROM booking_events "
                "WHERE booking_id = $1 AND event_type = 'auto_rearranged_move'",
                m["booking_id"],
            )
            assert row is not None
