#!/usr/bin/env python3
"""
One-shot sync for VAY-393.

booking_db.booking_hotels owns hotel-identity (name, slug). pms.hotels
keeps a stale duplicate that gets stamped at hotel creation and never
resyncs — so a rename in the booking engine leaks the old name into
PMS-driven flows (Channex provisioning, super-admin views, affiliate
dashboards). The email path is now read-through (booking_repo.py uses
hotel_identity_service.get_name), but other consumers still read
pms.hotels.name directly. This script reconciles them.

Defaults to dry-run; pass --execute to apply. Logs every diff so we
can spot-check before trusting the run. Idempotent — running twice
produces no further changes.

Usage:
    python scripts/sync_hotel_names_from_booking_engine.py             # dry-run
    python scripts/sync_hotel_names_from_booking_engine.py --execute   # apply
"""

import argparse
import asyncio
import logging
import sys
from typing import Optional

from app.config import settings
from app.database import BookingEngineDatabase, Database


logger = logging.getLogger("sync_hotel_names_vay393")


async def _canonical(hotel_id: str) -> Optional[dict]:
    row = await BookingEngineDatabase.fetchrow(
        "SELECT name, slug FROM booking_hotels WHERE id = $1",
        hotel_id,
    )
    return dict(row) if row else None


async def run(execute: bool) -> int:
    if not settings.BOOKING_ENGINE_DATABASE_URL:
        logger.error("BOOKING_ENGINE_DATABASE_URL not configured; aborting")
        return 0

    hotels = await Database.fetch(
        "SELECT id, name, slug FROM hotels ORDER BY created_at"
    )
    total = len(hotels)
    diffs = 0
    applied = 0
    missing = 0

    for h in hotels:
        hotel_id = str(h["id"])
        canonical = await _canonical(hotel_id)
        if canonical is None:
            missing += 1
            logger.warning(
                "%s no booking_db row (pms slug=%s name=%r) — skipping",
                hotel_id, h["slug"], h["name"],
            )
            continue

        new_name = canonical["name"]
        new_slug = canonical["slug"]
        name_drift = new_name and new_name != h["name"]
        slug_drift = new_slug and new_slug != h["slug"]
        if not (name_drift or slug_drift):
            continue

        diffs += 1
        logger.info(
            "%s [%s] name: %r -> %r | slug: %r -> %r",
            "PLAN" if not execute else "APPLY",
            hotel_id,
            h["name"], new_name,
            h["slug"], new_slug,
        )
        if execute:
            await Database.execute(
                "UPDATE hotels SET name = $2, slug = $3 WHERE id = $1",
                hotel_id, new_name, new_slug,
            )
            applied += 1

    logger.info(
        "Done. hotels=%d diffs=%d applied=%d missing=%d execute=%s",
        total, diffs, applied, missing, execute,
    )
    return applied


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
        await BookingEngineDatabase.close_pool()
        await Database.close_pool()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()) and 0)
