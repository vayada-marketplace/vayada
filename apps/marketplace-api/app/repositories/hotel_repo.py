"""
Repository for hotel_profiles, hotel_listings, listing_collaboration_offerings,
and listing_creator_requirements tables (Database).
"""
from typing import Optional, List

import asyncpg

from app.database import Database


class HotelRepository:

    # ── hotel_profiles ──

    @staticmethod
    async def get_profile_by_user_id(
        user_id: str,
        *,
        columns: str = "*",
        conn: Optional[asyncpg.Connection] = None,
    ) -> Optional[dict]:
        query = f"SELECT {columns} FROM hotel_profiles WHERE user_id = $1"
        if conn:
            row = await conn.fetchrow(query, user_id)
        else:
            row = await Database.fetchrow(query, user_id)
        return dict(row) if row else None

    @staticmethod
    async def get_profile_by_id(
        profile_id: str,
        *,
        columns: str = "*",
        conn: Optional[asyncpg.Connection] = None,
    ) -> Optional[dict]:
        query = f"SELECT {columns} FROM hotel_profiles WHERE id = $1"
        if conn:
            row = await conn.fetchrow(query, profile_id)
        else:
            row = await Database.fetchrow(query, profile_id)
        return dict(row) if row else None

    @staticmethod
    async def create_profile(
        user_id: str,
        name: str,
        location: str = "Not specified",
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> None:
        query = """
            INSERT INTO hotel_profiles (user_id, name, location)
            VALUES ($1, $2, $3)
        """
        if conn:
            await conn.execute(query, user_id, name, location)
        else:
            await Database.execute(query, user_id, name, location)

    @staticmethod
    async def update_profile(
        profile_id: str,
        update_fields: List[str],
        update_values: list,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> None:
        """Execute a dynamic UPDATE on hotel_profiles.

        ``update_fields`` is a list of SET fragments like ``["name = $1", "location = $2"]``.
        ``update_values`` must include all positional args (excluding the WHERE id value which is appended).
        """
        if not update_fields:
            return
        update_fields_with_ts = update_fields + ["updated_at = now()"]
        param_idx = len(update_values) + 1
        update_values_final = list(update_values) + [profile_id]
        query = f"""
            UPDATE hotel_profiles
            SET {', '.join(update_fields_with_ts)}
            WHERE id = ${param_idx}
        """
        if conn:
            await conn.execute(query, *update_values_final)
        else:
            await Database.execute(query, *update_values_final)

    # ── hotel_listings ──

    @staticmethod
    async def get_listings_by_profile_id(
        profile_id: str,
        *,
        columns: str = "id, hotel_profile_id, name, location, description, accommodation_type, images, status, created_at, updated_at",
        conn: Optional[asyncpg.Connection] = None,
    ) -> list:
        query = f"SELECT {columns} FROM hotel_listings WHERE hotel_profile_id = $1 ORDER BY created_at DESC"
        if conn:
            rows = await conn.fetch(query, profile_id)
        else:
            rows = await Database.fetch(query, profile_id)
        return [dict(r) for r in rows]

    @staticmethod
    async def get_listing(
        listing_id: str,
        hotel_profile_id: str,
        *,
        columns: str = "id, hotel_profile_id, name, location, description, accommodation_type, images, status, created_at, updated_at",
        conn: Optional[asyncpg.Connection] = None,
    ) -> Optional[dict]:
        query = f"SELECT {columns} FROM hotel_listings WHERE id = $1 AND hotel_profile_id = $2"
        if conn:
            row = await conn.fetchrow(query, listing_id, hotel_profile_id)
        else:
            row = await Database.fetchrow(query, listing_id, hotel_profile_id)
        return dict(row) if row else None

    @staticmethod
    async def create_listing(
        hotel_profile_id: str,
        name: str,
        location: str,
        description: str,
        accommodation_type: str,
        images: list,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> dict:
        query = """
            INSERT INTO hotel_listings
            (hotel_profile_id, name, location, description, accommodation_type, images)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id, name, location, description, accommodation_type, images,
                      status, created_at, updated_at
        """
        if conn:
            row = await conn.fetchrow(query, hotel_profile_id, name, location, description, accommodation_type, images)
        else:
            row = await Database.fetchrow(query, hotel_profile_id, name, location, description, accommodation_type, images)
        return dict(row)

    @staticmethod
    async def delete_listing(
        listing_id: str,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> None:
        query = "DELETE FROM hotel_listings WHERE id = $1"
        if conn:
            await conn.execute(query, listing_id)
        else:
            await Database.execute(query, listing_id)

    # ── listing_collaboration_offerings ──

    @staticmethod
    async def get_offerings(
        listing_id: str,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> list:
        query = """
            SELECT id, listing_id, collaboration_type, availability_months, platforms,
                   free_stay_min_nights, free_stay_max_nights, paid_max_amount, discount_percentage,
                   created_at, updated_at
            FROM listing_collaboration_offerings
            WHERE listing_id = $1
            ORDER BY created_at DESC
        """
        if conn:
            rows = await conn.fetch(query, listing_id)
        else:
            rows = await Database.fetch(query, listing_id)
        return [dict(r) for r in rows]

    @staticmethod
    async def create_offering(
        listing_id: str,
        collaboration_type: str,
        availability_months: list,
        platforms: list,
        free_stay_min_nights: Optional[int],
        free_stay_max_nights: Optional[int],
        paid_max_amount: Optional[float],
        discount_percentage: Optional[float],
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> dict:
        query = """
            INSERT INTO listing_collaboration_offerings
            (listing_id, collaboration_type, availability_months, platforms,
             free_stay_min_nights, free_stay_max_nights, paid_max_amount, discount_percentage)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id, collaboration_type, availability_months, platforms,
                      free_stay_min_nights, free_stay_max_nights, paid_max_amount,
                      discount_percentage, created_at, updated_at
        """
        args = (listing_id, collaboration_type, availability_months, platforms,
                free_stay_min_nights, free_stay_max_nights, paid_max_amount, discount_percentage)
        if conn:
            row = await conn.fetchrow(query, *args)
        else:
            row = await Database.fetchrow(query, *args)
        return dict(row)

    @staticmethod
    async def delete_offerings(
        listing_id: str,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> None:
        query = "DELETE FROM listing_collaboration_offerings WHERE listing_id = $1"
        if conn:
            await conn.execute(query, listing_id)
        else:
            await Database.execute(query, listing_id)

    # ── listing_creator_requirements ──

    @staticmethod
    async def get_requirements(
        listing_id: str,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> Optional[dict]:
        query = """
            SELECT id, listing_id, platforms, min_followers, target_countries,
                   target_age_min, target_age_max, target_age_groups, creator_types, created_at, updated_at
            FROM listing_creator_requirements
            WHERE listing_id = $1
        """
        if conn:
            row = await conn.fetchrow(query, listing_id)
        else:
            row = await Database.fetchrow(query, listing_id)
        return dict(row) if row else None

    @staticmethod
    async def create_requirements(
        listing_id: str,
        platforms: list,
        min_followers: int,
        target_countries: list,
        target_age_min: Optional[int],
        target_age_max: Optional[int],
        target_age_groups: list,
        creator_types: list,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> dict:
        query = """
            INSERT INTO listing_creator_requirements
            (listing_id, platforms, min_followers, target_countries, target_age_min, target_age_max, target_age_groups, creator_types)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id, platforms, min_followers, target_countries,
                      target_age_min, target_age_max, target_age_groups, creator_types, created_at, updated_at
        """
        args = (listing_id, platforms, min_followers, target_countries,
                target_age_min, target_age_max, target_age_groups, creator_types)
        if conn:
            row = await conn.fetchrow(query, *args)
        else:
            row = await Database.fetchrow(query, *args)
        return dict(row)

    @staticmethod
    async def delete_requirements(
        listing_id: str,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> None:
        query = "DELETE FROM listing_creator_requirements WHERE listing_id = $1"
        if conn:
            await conn.execute(query, listing_id)
        else:
            await Database.execute(query, listing_id)

    # ── listing_collaboration_offerings (extra) ──

    @staticmethod
    async def get_listing_collaboration_types(
        listing_id: str,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> list:
        """Return distinct collaboration types offered by a listing."""
        query = "SELECT DISTINCT collaboration_type FROM listing_collaboration_offerings WHERE listing_id = $1"
        if conn:
            rows = await conn.fetch(query, listing_id)
        else:
            rows = await Database.fetch(query, listing_id)
        return [row['collaboration_type'] for row in rows]

    # ── marketplace queries ──

    @staticmethod
    async def get_marketplace_listings(
        verified_user_ids: list,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> list:
        """Get listings from verified hotels with complete profiles."""
        query = """
            SELECT
                hl.id,
                hl.hotel_profile_id,
                hl.name,
                hl.location,
                hl.description,
                hl.accommodation_type,
                hl.images,
                hl.status,
                hl.created_at,
                hp.name as hotel_name,
                hp.picture as hotel_picture
            FROM hotel_listings hl
            JOIN hotel_profiles hp ON hp.id = hl.hotel_profile_id
            WHERE hp.profile_complete = true
            AND hp.user_id = ANY($1::uuid[])
            ORDER BY hl.created_at DESC
        """
        if conn:
            rows = await conn.fetch(query, verified_user_ids)
        else:
            rows = await Database.fetch(query, verified_user_ids)
        return [dict(r) for r in rows]

    @staticmethod
    async def get_offerings_for_listings(
        listing_ids: list,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> list:
        """Batch-fetch offerings for multiple listings."""
        if not listing_ids:
            return []
        placeholders = ','.join([f'${i+1}' for i in range(len(listing_ids))])
        query = f"""
            SELECT id, listing_id, collaboration_type, availability_months, platforms,
                   free_stay_min_nights, free_stay_max_nights, paid_max_amount, discount_percentage,
                   created_at, updated_at
            FROM listing_collaboration_offerings
            WHERE listing_id IN ({placeholders})
            ORDER BY listing_id, created_at DESC
        """
        if conn:
            rows = await conn.fetch(query, *listing_ids)
        else:
            rows = await Database.fetch(query, *listing_ids)
        return [dict(r) for r in rows]

    @staticmethod
    async def get_requirements_for_listings(
        listing_ids: list,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> list:
        """Batch-fetch requirements for multiple listings."""
        if not listing_ids:
            return []
        placeholders = ','.join([f'${i+1}' for i in range(len(listing_ids))])
        query = f"""
            SELECT id, listing_id, platforms, min_followers, target_countries,
                   target_age_min, target_age_max, target_age_groups, creator_types, created_at, updated_at
            FROM listing_creator_requirements
            WHERE listing_id IN ({placeholders})
        """
        if conn:
            rows = await conn.fetch(query, *listing_ids)
        else:
            rows = await Database.fetch(query, *listing_ids)
        return [dict(r) for r in rows]
