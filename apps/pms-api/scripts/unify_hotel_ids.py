#!/usr/bin/env python3
"""
One-time migration: unify PMS hotels.id with booking_hotels.id.

For every existing row in the PMS `hotels` table, look up its
`booking_hotels` counterpart (joined on user_id + slug) and change
the PMS hotel's primary key and every child table's hotel_id FK to
match the booking_hotels.id.

After this migration completes, there is exactly one UUID per hotel
across both databases. New hotels must be created with
id = booking_hotels.id from the start — see the application code
changes in admin.py::register_hotel.

The migration runs inside a single transaction. Either everything
succeeds and commits, or nothing changes.

Child tables (detected via information_schema on 2026-04-10):
    affiliate_clicks, affiliates, bookings, cancellation_policies,
    channex_booking_mappings, channex_connections,
    channex_rate_plan_mappings, channex_room_type_mappings,
    hotel_payment_settings, room_blocks, room_types, rooms

Usage:
    # Inside the pms-backend container (or any env that sees both DBs):
    python scripts/unify_hotel_ids.py              # dry-run (default)
    python scripts/unify_hotel_ids.py --execute    # perform migration

Environment variables required:
    DATABASE_URL                  (PMS DB connection string)
    BOOKING_ENGINE_DATABASE_URL   (booking-engine DB connection string)
"""

import argparse
import asyncio
import os
import sys
from typing import Dict, List, Tuple

import asyncpg


# All child tables with a FK(hotel_id) referencing hotels.id.
# Generated from information_schema.table_constraints — if new FKs
# are added to the PMS schema, this list MUST be updated before running.
CHILD_TABLES: List[str] = [
    "affiliate_clicks",
    "affiliates",
    "bookings",
    "cancellation_policies",
    "channex_booking_mappings",
    "channex_connections",
    "channex_rate_plan_mappings",
    "channex_room_type_mappings",
    "hotel_payment_settings",
    "room_blocks",
    "room_types",
    "rooms",
]


async def fetch_mapping(
    pms_conn: asyncpg.Connection,
    booking_conn: asyncpg.Connection,
) -> Tuple[List[Tuple[str, str]], List[dict], List[dict]]:
    """
    Build the id mapping from PMS → booking_hotels.

    Returns:
        mapping: list of (old_pms_id, new_id) tuples, one per PMS hotel
        pms_orphans: PMS hotels with no booking counterpart (BLOCKER)
        booking_orphans: booking_hotels with no PMS counterpart (informational)
    """
    pms_rows = await pms_conn.fetch(
        "SELECT id, user_id, slug, name FROM hotels ORDER BY created_at"
    )
    booking_rows = await booking_conn.fetch(
        "SELECT id, user_id, slug, name FROM booking_hotels ORDER BY created_at"
    )

    booking_by_key: Dict[Tuple[str, str], dict] = {}
    for r in booking_rows:
        key = (str(r["user_id"]), r["slug"])
        if key in booking_by_key:
            raise RuntimeError(
                f"booking_hotels has duplicate (user_id, slug): {key} — "
                "schema expected this to be unique; manual reconciliation required"
            )
        booking_by_key[key] = dict(r)

    pms_by_key: Dict[Tuple[str, str], dict] = {}
    for r in pms_rows:
        key = (str(r["user_id"]), r["slug"])
        if key in pms_by_key:
            raise RuntimeError(
                f"PMS hotels has duplicate (user_id, slug): {key} — "
                "manual reconciliation required"
            )
        pms_by_key[key] = dict(r)

    mapping: List[Tuple[str, str]] = []
    pms_orphans: List[dict] = []
    for key, pms_row in pms_by_key.items():
        bh = booking_by_key.get(key)
        if bh is None:
            pms_orphans.append(pms_row)
            continue
        mapping.append((str(pms_row["id"]), str(bh["id"])))

    booking_orphans = [b for k, b in booking_by_key.items() if k not in pms_by_key]
    return mapping, pms_orphans, booking_orphans


async def run_migration(
    pms_conn: asyncpg.Connection,
    mapping: List[Tuple[str, str]],
) -> None:
    """Execute the full migration inside a single transaction."""
    async with pms_conn.transaction():
        await pms_conn.execute(
            """
            CREATE TEMP TABLE id_mapping (
                old_id uuid PRIMARY KEY,
                new_id uuid NOT NULL UNIQUE
            ) ON COMMIT DROP
            """
        )
        if mapping:
            await pms_conn.executemany(
                "INSERT INTO id_mapping (old_id, new_id) VALUES ($1, $2)",
                mapping,
            )

        # Pre-flight: every hotels row must have a mapping, and the
        # mapping targets must not conflict with unmapped existing rows.
        total_hotels = await pms_conn.fetchval("SELECT COUNT(*) FROM hotels")
        total_mapping = await pms_conn.fetchval("SELECT COUNT(*) FROM id_mapping")
        if total_hotels != total_mapping:
            raise RuntimeError(
                f"Pre-flight failed: hotels count ({total_hotels}) "
                f"!= mapping count ({total_mapping})"
            )

        # Drop FK constraints on all child tables. The constraints use
        # the naming convention `<table>_hotel_id_fkey` (verified via
        # information_schema). If a constraint is named differently,
        # this statement will be a no-op and the UPDATE below will fail
        # the FK check — which is what we want, a loud failure.
        for table in CHILD_TABLES:
            await pms_conn.execute(
                f"ALTER TABLE {table} DROP CONSTRAINT {table}_hotel_id_fkey"
            )

        # Update child tables first, parent last. Order matters for
        # clarity even though we're inside a transaction with FKs
        # already dropped.
        for table in CHILD_TABLES:
            await pms_conn.execute(
                f"""
                UPDATE {table}
                SET hotel_id = m.new_id
                FROM id_mapping m
                WHERE {table}.hotel_id = m.old_id
                """
            )

        # Update the parent (hotels.id). PostgreSQL evaluates UPDATE
        # set-at-once, so even if old/new ids temporarily overlap
        # between different rows (a rotating-ids scenario) the
        # statement succeeds as long as the FINAL state has unique PKs.
        await pms_conn.execute(
            """
            UPDATE hotels
            SET id = m.new_id
            FROM id_mapping m
            WHERE hotels.id = m.old_id
            """
        )

        # Re-add FK constraints. Using ON DELETE CASCADE to match the
        # original constraint semantics (verified via information_schema
        # pre-migration).
        for table in CHILD_TABLES:
            await pms_conn.execute(
                f"""
                ALTER TABLE {table}
                ADD CONSTRAINT {table}_hotel_id_fkey
                FOREIGN KEY (hotel_id) REFERENCES hotels(id) ON DELETE CASCADE
                """
            )

        # Sanity: every child row's hotel_id (if not null) points at a
        # real hotels row. This should be tautological after the FK
        # re-creation above, but we check explicitly to catch any
        # silent NULLs or typos.
        for table in CHILD_TABLES:
            orphan_count = await pms_conn.fetchval(
                f"""
                SELECT COUNT(*) FROM {table}
                WHERE hotel_id IS NOT NULL
                  AND hotel_id NOT IN (SELECT id FROM hotels)
                """
            )
            if orphan_count:
                raise RuntimeError(
                    f"Post-migration sanity check failed: {table} has "
                    f"{orphan_count} rows with hotel_id not in hotels.id"
                )


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Actually perform the migration (default: dry-run)",
    )
    args = parser.parse_args()

    pms_url = os.environ.get("DATABASE_URL")
    booking_url = os.environ.get("BOOKING_ENGINE_DATABASE_URL")
    if not pms_url or not booking_url:
        print(
            "ERROR: DATABASE_URL and BOOKING_ENGINE_DATABASE_URL must be set",
            file=sys.stderr,
        )
        sys.exit(2)

    pms_conn = await asyncpg.connect(pms_url)
    booking_conn = await asyncpg.connect(booking_url)

    try:
        print("Fetching hotels from both databases...")
        mapping, pms_orphans, booking_orphans = await fetch_mapping(
            pms_conn, booking_conn
        )

        print(f"  Total mappable hotels: {len(mapping)}")
        print(f"  PMS orphans (no booking_hotels match): {len(pms_orphans)}")
        print(f"  Booking orphans (no PMS match, ignored): {len(booking_orphans)}")

        if pms_orphans:
            print()
            print("BLOCKER — the following PMS hotels have no matching booking_hotels row:")
            for o in pms_orphans:
                print(
                    f"  id={o['id']}  user_id={o['user_id']}  "
                    f"slug={o['slug']}  name={o['name']}"
                )
            print()
            print(
                "Cannot proceed. Each PMS hotel needs a booking_hotels counterpart "
                "before this migration can run. Options:"
            )
            print("  1. Create the missing booking_hotels row manually")
            print("  2. Delete the orphan PMS hotel if it's garbage")
            print("  3. Investigate how these orphans came to exist")
            sys.exit(1)

        if booking_orphans:
            print()
            print("Note: booking_hotels rows with no PMS counterpart are fine.")
            print("These users started the booking-admin setup flow but never")
            print("created a PMS hotel. Sample (up to 5):")
            for o in booking_orphans[:5]:
                print(f"  id={o['id']}  slug={o['slug']}")
            if len(booking_orphans) > 5:
                print(f"  ... and {len(booking_orphans) - 5} more")

        already_unified = sum(1 for old, new in mapping if old == new)
        to_change = len(mapping) - already_unified
        print()
        print(f"Mapping summary: {to_change} ids to change, {already_unified} already unified (noop)")

        print()
        print("Sample mapping (first 5):")
        for old, new in mapping[:5]:
            marker = "  (noop)" if old == new else ""
            print(f"  {old}  ->  {new}{marker}")

        if not args.execute:
            print()
            print("DRY RUN — no changes made.")
            print("Rerun with --execute to perform the migration.")
            return

        print()
        print("Executing migration in a single transaction...")
        await run_migration(pms_conn, mapping)
        print("Migration completed successfully.")
    finally:
        await pms_conn.close()
        await booking_conn.close()


if __name__ == "__main__":
    asyncio.run(main())
