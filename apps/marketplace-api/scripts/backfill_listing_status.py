#!/usr/bin/env python3
"""
One-off backfill: set hotel_profiles.status and hotel_listings.status to
'verified' for every profile/listing whose owning user is already verified.

Run after deploying the auto-promote logic in admin.update_user and
hotels.create_hotel_listing — existing pending rows for already-verified users
would otherwise stay stuck on 'pending'.

Safe to re-run; only rows currently != 'verified' are touched.
"""
import argparse
import asyncio
import sys
from pathlib import Path

import asyncpg

sys.path.insert(0, str(Path(__file__).parent.parent))

from app.config import settings


async def backfill(dry_run: bool):
    auth_conn = await asyncpg.connect(settings.AUTH_DATABASE_URL)
    try:
        verified_rows = await auth_conn.fetch(
            "SELECT id FROM users WHERE type = 'hotel' AND status = 'verified'"
        )
    finally:
        await auth_conn.close()

    verified_user_ids = [row['id'] for row in verified_rows]
    print(f"Found {len(verified_user_ids)} verified hotel users")

    if not verified_user_ids:
        print("Nothing to backfill.")
        return

    market_conn = await asyncpg.connect(settings.DATABASE_URL)
    try:
        if dry_run:
            profiles_count = await market_conn.fetchval(
                """
                SELECT count(*) FROM hotel_profiles
                WHERE user_id = ANY($1::uuid[]) AND status != 'verified'
                """,
                verified_user_ids,
            )
            listings_count = await market_conn.fetchval(
                """
                SELECT count(*) FROM hotel_listings
                WHERE hotel_profile_id IN (
                    SELECT id FROM hotel_profiles WHERE user_id = ANY($1::uuid[])
                ) AND status != 'verified'
                """,
                verified_user_ids,
            )
            print(f"[DRY RUN] hotel_profiles rows to update: {profiles_count}")
            print(f"[DRY RUN] hotel_listings rows to update: {listings_count}")
            return

        profiles_result = await market_conn.execute(
            """
            UPDATE hotel_profiles
            SET status = 'verified', updated_at = now()
            WHERE user_id = ANY($1::uuid[]) AND status != 'verified'
            """,
            verified_user_ids,
        )
        listings_result = await market_conn.execute(
            """
            UPDATE hotel_listings
            SET status = 'verified', updated_at = now()
            WHERE hotel_profile_id IN (
                SELECT id FROM hotel_profiles WHERE user_id = ANY($1::uuid[])
            ) AND status != 'verified'
            """,
            verified_user_ids,
        )
    finally:
        await market_conn.close()

    # asyncpg returns "UPDATE <count>"
    print(f"hotel_profiles: {profiles_result}")
    print(f"hotel_listings: {listings_result}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="Print row counts without updating")
    args = parser.parse_args()
    asyncio.run(backfill(args.dry_run))
