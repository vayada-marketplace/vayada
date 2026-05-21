#!/usr/bin/env python3
"""
One-shot backfill for VAY-322.

Hotels that renamed a room type before the on-rename fix shipped on
2026-05-05 still display stale room numbers (e.g. "#Deluxe Room" under
"Deluxe Party Room"). The on-rename path can never fire for them
because the old name is gone. This script walks every hotel × room
type and runs RoomRepository.heal_stale_room_names — same heuristic
used on every PATCH /admin/room-types/{id}, so the result is
deterministic and idempotent.

Defaults to dry-run; pass --execute to commit. Logs every rename it
plans/applies plus a per-hotel summary so we can spot-check before
trusting the run.

Usage:
    python scripts/backfill_room_names_vay322.py              # dry-run
    python scripts/backfill_room_names_vay322.py --execute    # apply
"""

import argparse
import asyncio
import logging
import re
import sys
from collections import Counter
from typing import List, Tuple

from app.database import Database
from app.repositories.room_repo import RoomRepository


logger = logging.getLogger("backfill_vay322")


async def _plan_for_room_type(
    hotel_id: str,
    room_type_id: str,
    current_name: str,
) -> List[Tuple[str, str, str]]:
    """Return [(room_id, old_number, new_number)] this room type would
    have rewritten, using the same heuristic as
    RoomRepository.heal_stale_room_names. Kept in sync by mirroring
    the same SQL + regex shape.
    """
    rooms = await Database.fetch(
        """
        SELECT id, room_number
        FROM rooms
        WHERE hotel_id = $1 AND room_type_id = $2
        """,
        hotel_id,
        room_type_id,
    )
    if not rooms:
        return []

    sibling_rows = await Database.fetch(
        """
        SELECT name
        FROM room_types
        WHERE hotel_id = $1 AND id != $2
        """,
        hotel_id,
        room_type_id,
    )
    sibling_names = {row["name"] for row in sibling_rows}

    prefix_re = re.compile(r"^(.*?)( [0-9]+)?$")
    candidates: List[Tuple[str, str, str, str]] = []
    for r in rooms:
        number = r["room_number"]
        m = prefix_re.match(number)
        if not m:
            continue
        prefix = m.group(1)
        suffix = m.group(2) or ""
        if not prefix or prefix == current_name:
            continue
        if prefix in sibling_names:
            continue
        candidates.append((str(r["id"]), number, prefix, suffix))

    if not candidates:
        return []

    prefix_counts = Counter(c[2] for c in candidates)
    only_room_in_type = len(rooms) == 1

    plan: List[Tuple[str, str, str]] = []
    for room_id, old_number, prefix, suffix in candidates:
        shared = prefix_counts[prefix] >= 2
        if not (shared or only_room_in_type):
            continue
        new_number = f"{current_name}{suffix}"
        if new_number == old_number:
            continue
        plan.append((room_id, old_number, new_number))
    return plan


async def run(execute: bool) -> int:
    hotels = await Database.fetch(
        "SELECT id, name, slug FROM hotels ORDER BY created_at"
    )
    total_planned = 0
    total_applied = 0
    total_skipped = 0

    for hotel in hotels:
        hotel_id = str(hotel["id"])
        types = await Database.fetch(
            """
            SELECT id, name FROM room_types
            WHERE hotel_id = $1
            ORDER BY sort_order, name
            """,
            hotel_id,
        )
        hotel_planned = 0
        hotel_applied = 0
        for rt in types:
            room_type_id = str(rt["id"])
            current_name = rt["name"]
            plan = await _plan_for_room_type(
                hotel_id, room_type_id, current_name,
            )
            if not plan:
                continue
            for _, old_number, new_number in plan:
                logger.info(
                    "%s [%s/%s] %r -> %r",
                    "PLAN" if not execute else "APPLY",
                    hotel.get("slug") or hotel_id,
                    current_name,
                    old_number,
                    new_number,
                )
            hotel_planned += len(plan)
            if execute:
                applied = await RoomRepository.heal_stale_room_names(
                    hotel_id, room_type_id, current_name,
                )
                hotel_applied += applied
                if applied != len(plan):
                    total_skipped += len(plan) - applied
                    logger.warning(
                        "%s [%s/%s] applied %d of %d planned renames "
                        "(unique-collision skipped the rest)",
                        "DIFF",
                        hotel.get("slug") or hotel_id,
                        current_name,
                        applied,
                        len(plan),
                    )
        if hotel_planned:
            logger.info(
                "Hotel %s: planned=%d applied=%d",
                hotel.get("slug") or hotel_id,
                hotel_planned,
                hotel_applied,
            )
        total_planned += hotel_planned
        total_applied += hotel_applied

    logger.info(
        "Done. hotels=%d planned=%d applied=%d skipped=%d execute=%s",
        len(hotels),
        total_planned,
        total_applied,
        total_skipped,
        execute,
    )
    return total_applied


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Apply renames. Default is dry-run.",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    try:
        return await run(execute=args.execute)
    finally:
        await Database.close_pool()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()) and 0)
