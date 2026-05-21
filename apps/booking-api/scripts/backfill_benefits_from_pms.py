#!/usr/bin/env python3
"""
One-shot backfill: copy hotel-level Book Direct Benefits from
pms.hotels.benefits into booking_hotels.benefits.

Context: /admin/benefits used to read/write pms.hotels.benefits keyed by
booking_hotels.id, which silently returned/persisted nothing for any
hotel where booking_hotels.id != pms.hotels.id (legacy pre-unification
hotels). We've moved storage to booking_hotels.benefits — this script
backfills the data so hotels that managed to save under the old layout
don't lose their selections.

Match strategy, in order of preference:
  1. id-match (booking_hotels.id == pms.hotels.id) — modern unified hotels
  2. user_id+slug match — legacy hotels where the IDs diverged

Skips booking_hotels rows that already have a non-empty benefits array,
so re-running is safe and won't clobber post-fix writes.

Usage:
    DATABASE_URL=postgresql://... \\
    PMS_DATABASE_URL=postgresql://... \\
        python scripts/backfill_benefits_from_pms.py
"""
import asyncio
import json
import os
import sys
from pathlib import Path

import asyncpg

sys.path.insert(0, str(Path(__file__).parent.parent))


def _parse_jsonb(val):
    if val is None:
        return []
    if isinstance(val, str):
        return json.loads(val)
    return val


async def backfill():
    booking_url = os.environ.get("DATABASE_URL")
    pms_url = os.environ.get("PMS_DATABASE_URL")
    if not booking_url:
        print("❌ DATABASE_URL not set", file=sys.stderr)
        sys.exit(1)
    if not pms_url:
        print("❌ PMS_DATABASE_URL not set", file=sys.stderr)
        sys.exit(1)

    booking = await asyncpg.connect(booking_url)
    pms = await asyncpg.connect(pms_url)

    try:
        pms_rows = await pms.fetch(
            "SELECT id, slug, user_id, benefits FROM hotels "
            "WHERE benefits IS NOT NULL AND benefits::text NOT IN ('[]', 'null')"
        )
        print(f"📋 Found {len(pms_rows)} pms.hotels rows with non-empty benefits")

        copied = 0
        skipped_already_set = 0
        skipped_no_match = 0

        for pms_row in pms_rows:
            benefits = _parse_jsonb(pms_row["benefits"])
            if not benefits:
                continue

            target = await booking.fetchrow(
                "SELECT id, benefits FROM booking_hotels WHERE id = $1",
                pms_row["id"],
            )
            if not target:
                target = await booking.fetchrow(
                    "SELECT id, benefits FROM booking_hotels WHERE user_id = $1 AND slug = $2",
                    pms_row["user_id"],
                    pms_row["slug"],
                )
            if not target:
                skipped_no_match += 1
                print(f"  ⊘ no booking_hotels match for pms.hotels.id={pms_row['id']} slug={pms_row['slug']}")
                continue

            existing = _parse_jsonb(target["benefits"])
            if existing:
                skipped_already_set += 1
                continue

            await booking.execute(
                "UPDATE booking_hotels SET benefits = $1::jsonb WHERE id = $2",
                json.dumps(benefits),
                target["id"],
            )
            copied += 1
            print(f"  ✓ {target['id']}  ← {len(benefits)} benefit(s)")

        print()
        print(f"✅ Copied:                {copied}")
        print(f"⊙ Skipped (already set): {skipped_already_set}")
        print(f"⊘ Skipped (no match):    {skipped_no_match}")
    finally:
        await booking.close()
        await pms.close()


if __name__ == "__main__":
    asyncio.run(backfill())
