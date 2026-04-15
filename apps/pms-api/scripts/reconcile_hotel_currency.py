#!/usr/bin/env python3
"""
One-time reconciliation: align booking_hotels.currency with
hotel_payment_settings.default_currency for hotels where the two
have drifted.

Context: historically, the PMS stored currency in
hotel_payment_settings.default_currency and the booking engine
stored it in booking_hotels.currency. These could drift because the
PMS PATCH /payment-settings flow only synced the pms→booking write
after a certain commit; anything created before that, or edited
via other paths, could end up out of sync.

Going forward, booking_hotels.currency is the single source of
truth (see memory/project_hotel_data_ownership.md). This script
fixes historical drift by copying the PMS value into the booking
engine — because in practice the PMS side has always been the one
the user actually interacted with (it's where the hotel's currency
dropdown lives), and is therefore the "right" value. You can
override on a case-by-case basis with --trust=booking if you know
the PMS value is wrong for a specific hotel.

Usage:
    # Inside the pms-backend container (or any env that sees both DBs):
    python scripts/reconcile_hotel_currency.py                 # dry-run
    python scripts/reconcile_hotel_currency.py --apply         # trust pms (default)
    python scripts/reconcile_hotel_currency.py --apply --trust booking
                                                               # no-op, just lists

Environment variables required:
    DATABASE_URL                  (PMS DB connection string)
    BOOKING_ENGINE_DATABASE_URL   (booking-engine DB connection string)
"""

import argparse
import asyncio
import os
import sys
from typing import List

import asyncpg


async def fetch_conflicts(
    pms_conn: asyncpg.Connection,
    booking_conn: asyncpg.Connection,
) -> List[dict]:
    pms_rows = await pms_conn.fetch(
        "SELECT hotel_id, default_currency FROM hotel_payment_settings "
        "WHERE default_currency IS NOT NULL"
    )
    pms_by_id = {str(r["hotel_id"]): r["default_currency"] for r in pms_rows}

    booking_rows = await booking_conn.fetch(
        "SELECT id, name, currency FROM booking_hotels ORDER BY name"
    )

    conflicts: List[dict] = []
    for b in booking_rows:
        hotel_id = str(b["id"])
        be_currency = b["currency"]
        pms_currency = pms_by_id.get(hotel_id)
        if pms_currency is None:
            continue
        if be_currency == pms_currency:
            continue
        conflicts.append({
            "id": hotel_id,
            "name": b["name"],
            "booking_engine": be_currency,
            "pms": pms_currency,
        })
    return conflicts


def print_table(conflicts: List[dict]) -> None:
    if not conflicts:
        print("No conflicts — booking_hotels.currency matches "
              "hotel_payment_settings.default_currency for every hotel.")
        return
    name_w = max(len(c["name"] or "") for c in conflicts)
    name_w = max(name_w, len("Name"))
    print(f"{'Hotel ID':<36}  {'Name':<{name_w}}  {'booking_db':<12}  {'pms_db':<12}")
    print(f"{'-' * 36}  {'-' * name_w}  {'-' * 12}  {'-' * 12}")
    for c in conflicts:
        print(
            f"{c['id']:<36}  {(c['name'] or ''):<{name_w}}  "
            f"{(c['booking_engine'] or ''):<12}  {(c['pms'] or ''):<12}"
        )
    print(f"\n{len(conflicts)} hotel(s) with currency drift.")


async def apply_reconciliation(
    booking_conn: asyncpg.Connection,
    conflicts: List[dict],
    trust: str,
) -> int:
    if trust == "booking":
        print("--trust=booking is a no-op: booking_hotels.currency is already "
              "authoritative going forward, nothing to write.")
        return 0
    updated = 0
    for c in conflicts:
        await booking_conn.execute(
            "UPDATE booking_hotels SET currency = $2 WHERE id = $1",
            c["id"], c["pms"],
        )
        print(f"  {c['name']}: {c['booking_engine']} → {c['pms']}")
        updated += 1
    return updated


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "--apply", action="store_true",
        help="Actually write changes. Default is dry-run.",
    )
    parser.add_argument(
        "--trust", choices=["pms", "booking"], default="pms",
        help="Which side is authoritative for conflicts (default: pms).",
    )
    args = parser.parse_args()

    pms_url = os.environ.get("DATABASE_URL")
    booking_url = os.environ.get("BOOKING_ENGINE_DATABASE_URL")
    if not pms_url or not booking_url:
        print("ERROR: DATABASE_URL and BOOKING_ENGINE_DATABASE_URL must be set",
              file=sys.stderr)
        return 2

    pms_conn = await asyncpg.connect(pms_url)
    booking_conn = await asyncpg.connect(booking_url)
    try:
        conflicts = await fetch_conflicts(pms_conn, booking_conn)
        print_table(conflicts)
        if not conflicts:
            return 0
        if not args.apply:
            print("\n(dry-run — pass --apply to write changes)")
            return 0
        print(f"\nApplying with --trust={args.trust}…")
        async with booking_conn.transaction():
            updated = await apply_reconciliation(booking_conn, conflicts, args.trust)
        print(f"\nUpdated {updated} booking_hotels row(s).")
        return 0
    finally:
        await pms_conn.close()
        await booking_conn.close()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
