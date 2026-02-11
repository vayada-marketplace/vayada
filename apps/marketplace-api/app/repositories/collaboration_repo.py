"""
Repository for collaborations, collaboration_deliverables, and creator_ratings tables (Database).
"""
from typing import Optional, List

import asyncpg

from app.database import Database


class CollaborationRepository:

    # ── collaborations ──

    @staticmethod
    async def get_by_id(
        collaboration_id: str,
        *,
        columns: str = "*",
        conn: Optional[asyncpg.Connection] = None,
    ) -> Optional[dict]:
        query = f"SELECT {columns} FROM collaborations WHERE id = $1"
        if conn:
            row = await conn.fetchrow(query, collaboration_id)
        else:
            row = await Database.fetchrow(query, collaboration_id)
        return dict(row) if row else None

    @staticmethod
    async def get_full(
        collaboration_id: str,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> Optional[dict]:
        """Fetch collaboration with joined creator/hotel/listing data."""
        query = """
            SELECT c.*, cr.profile_picture as creator_profile_picture,
                   cr.user_id as creator_user_id,
                   hp.name as hotel_name, hl.name as listing_name, hl.location as listing_location
            FROM collaborations c
            JOIN creators cr ON cr.id = c.creator_id
            JOIN hotel_profiles hp ON hp.id = c.hotel_id
            JOIN hotel_listings hl ON hl.id = c.listing_id
            WHERE c.id = $1
        """
        if conn:
            row = await conn.fetchrow(query, collaboration_id)
        else:
            row = await Database.fetchrow(query, collaboration_id)
        return dict(row) if row else None

    @staticmethod
    async def get_listing_with_hotel(
        listing_id: str,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> Optional[dict]:
        """Fetch listing with hotel name."""
        query = """
            SELECT hl.id, hl.hotel_profile_id, hl.name, hl.location, hl.status,
                   hp.name as hotel_name
            FROM hotel_listings hl
            JOIN hotel_profiles hp ON hp.id = hl.hotel_profile_id
            WHERE hl.id = $1
        """
        if conn:
            row = await conn.fetchrow(query, listing_id)
        else:
            row = await Database.fetchrow(query, listing_id)
        return dict(row) if row else None

    # ── collaboration_deliverables ──

    @staticmethod
    async def get_deliverables(
        collaboration_id: str,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> list:
        query = """
            SELECT id, platform, type, quantity, status
            FROM collaboration_deliverables
            WHERE collaboration_id = $1
            ORDER BY platform, type
        """
        if conn:
            rows = await conn.fetch(query, collaboration_id)
        else:
            rows = await Database.fetch(query, collaboration_id)
        return [dict(r) for r in rows]

    @staticmethod
    async def get_deliverable(
        deliverable_id: str,
        collaboration_id: str,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> Optional[dict]:
        query = "SELECT type, status FROM collaboration_deliverables WHERE id = $1 AND collaboration_id = $2"
        if conn:
            row = await conn.fetchrow(query, deliverable_id, collaboration_id)
        else:
            row = await Database.fetchrow(query, deliverable_id, collaboration_id)
        return dict(row) if row else None

    @staticmethod
    async def update_deliverable_status(
        deliverable_id: str,
        new_status: str,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> None:
        query = "UPDATE collaboration_deliverables SET status = $1, updated_at = NOW() WHERE id = $2"
        if conn:
            await conn.execute(query, new_status, deliverable_id)
        else:
            await Database.execute(query, new_status, deliverable_id)

    # ── creator_ratings ──

    @staticmethod
    async def get_rating_by_collaboration(
        collaboration_id: str,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> Optional[dict]:
        query = "SELECT id FROM creator_ratings WHERE collaboration_id = $1"
        if conn:
            row = await conn.fetchrow(query, collaboration_id)
        else:
            row = await Database.fetchrow(query, collaboration_id)
        return dict(row) if row else None

    @staticmethod
    async def create_rating(
        creator_id: str,
        hotel_id: str,
        collaboration_id: str,
        rating: int,
        comment: Optional[str] = None,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> dict:
        query = """
            INSERT INTO creator_ratings (creator_id, hotel_id, collaboration_id, rating, comment)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id, created_at
        """
        if conn:
            row = await conn.fetchrow(query, creator_id, hotel_id, collaboration_id, rating, comment)
        else:
            row = await Database.fetchrow(query, creator_id, hotel_id, collaboration_id, rating, comment)
        return dict(row)

    @staticmethod
    async def get_creator_collaborations(
        creator_id: str,
        *,
        status: Optional[str] = None,
        initiator_type: Optional[str] = None,
        conn: Optional[asyncpg.Connection] = None,
    ) -> list:
        """Get collaborations for a creator with hotel/listing info and optional filters."""
        query = """
            SELECT
                c.id, c.initiator_type, c.status, c.created_at,
                c.why_great_fit, c.collaboration_type,
                c.travel_date_from, c.travel_date_to,
                c.free_stay_min_nights, c.free_stay_max_nights,
                c.paid_amount, c.discount_percentage,
                c.hotel_id, c.listing_id,
                hp.name as hotel_name,
                hp.picture as hotel_profile_picture,
                hl.name as listing_name,
                hl.location as listing_location,
                hl.images as listing_images
            FROM collaborations c
            JOIN hotel_profiles hp ON hp.id = c.hotel_id
            JOIN hotel_listings hl ON hl.id = c.listing_id
            WHERE c.creator_id = $1
        """
        params: list = [creator_id]
        param_counter = 2

        if status:
            query += f" AND c.status = ${param_counter}"
            params.append(status)
            param_counter += 1

        if initiator_type:
            query += f" AND c.initiator_type = ${param_counter}"
            params.append(initiator_type)
            param_counter += 1

        query += " ORDER BY c.created_at DESC"

        if conn:
            rows = await conn.fetch(query, *params)
        else:
            rows = await Database.fetch(query, *params)
        return [dict(r) for r in rows]

    @staticmethod
    async def get_hotel_collaborations(
        hotel_id: str,
        *,
        listing_id: Optional[str] = None,
        status: Optional[str] = None,
        initiator_type: Optional[str] = None,
        conn: Optional[asyncpg.Connection] = None,
    ) -> list:
        """Get collaborations for a hotel with creator info and optional filters."""
        query = """
            SELECT
                c.id, c.initiator_type, c.status, c.created_at, c.why_great_fit,
                c.travel_date_from, c.travel_date_to,
                c.creator_id,
                cr.user_id as creator_user_id,
                cr.profile_picture as creator_profile_picture,
                cr.location as creator_location,
                (SELECT SUM(followers) FROM creator_platforms WHERE creator_id = c.creator_id) as total_followers,
                (SELECT AVG(engagement_rate) FROM creator_platforms WHERE creator_id = c.creator_id) as avg_engagement_rate,
                (
                    SELECT handle
                    FROM creator_platforms
                    WHERE creator_id = c.creator_id
                    ORDER BY followers DESC
                    LIMIT 1
                ) as primary_handle,
                (
                    SELECT name
                    FROM creator_platforms
                    WHERE creator_id = c.creator_id
                    ORDER BY followers DESC
                    LIMIT 1
                ) as active_platform
            FROM collaborations c
            JOIN creators cr ON cr.id = c.creator_id
            WHERE c.hotel_id = $1
        """
        params: list = [hotel_id]

        if listing_id:
            query += " AND c.listing_id = $" + str(len(params) + 1)
            params.append(listing_id)
        if status:
            query += " AND c.status = $" + str(len(params) + 1)
            params.append(status)
        if initiator_type:
            query += " AND c.initiator_type = $" + str(len(params) + 1)
            params.append(initiator_type)

        query += " ORDER BY c.created_at DESC"

        if conn:
            rows = await conn.fetch(query, *params)
        else:
            rows = await Database.fetch(query, *params)
        return [dict(r) for r in rows]

    @staticmethod
    async def get_deliverables_batch(
        collab_ids: List[str],
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> list:
        """Batch-fetch deliverables for multiple collaboration IDs."""
        if not collab_ids:
            return []
        query = "SELECT id, collaboration_id, platform, type, quantity, status FROM collaboration_deliverables WHERE collaboration_id = ANY($1::uuid[])"
        if conn:
            rows = await conn.fetch(query, collab_ids)
        else:
            rows = await Database.fetch(query, collab_ids)
        return [dict(r) for r in rows]

    @staticmethod
    async def get_creator_collaboration_detail(
        collaboration_id: str,
        creator_id: str,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> Optional[dict]:
        """Fetch detailed collaboration from creator perspective with hotel/listing/requirements."""
        query = """
            SELECT
                c.id, c.initiator_type, c.status, c.created_at, c.why_great_fit,
                c.collaboration_type, c.free_stay_min_nights, c.free_stay_max_nights,
                c.paid_amount, c.discount_percentage,
                c.travel_date_from, c.travel_date_to,
                c.preferred_date_from, c.preferred_date_to,
                c.preferred_months, c.consent,
                c.updated_at, c.responded_at, c.cancelled_at, c.completed_at,
                c.hotel_id, c.listing_id,
                hp.name as hotel_name,
                hp.location as hotel_location,
                hp.picture as hotel_profile_picture,
                hp.website as hotel_website,
                hp.about as hotel_about,
                hp.phone as hotel_phone,
                hl.name as listing_name,
                hl.location as listing_location,
                hl.images as listing_images,
                lcr.id as req_id,
                lcr.platforms as req_platforms,
                lcr.min_followers as req_min_followers,
                lcr.target_countries as req_target_countries,
                lcr.target_age_min as req_target_age_min,
                lcr.target_age_max as req_target_age_max,
                lcr.target_age_groups as req_target_age_groups,
                lcr.creator_types as req_creator_types,
                lcr.created_at as req_created_at,
                lcr.updated_at as req_updated_at
            FROM collaborations c
            JOIN hotel_profiles hp ON hp.id = c.hotel_id
            JOIN hotel_listings hl ON hl.id = c.listing_id
            LEFT JOIN listing_creator_requirements lcr ON lcr.listing_id = hl.id
            WHERE c.id = $1 AND c.creator_id = $2
        """
        if conn:
            row = await conn.fetchrow(query, collaboration_id, creator_id)
        else:
            row = await Database.fetchrow(query, collaboration_id, creator_id)
        return dict(row) if row else None

    @staticmethod
    async def get_hotel_collaboration_detail(
        collaboration_id: str,
        hotel_id: str,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> Optional[dict]:
        """Fetch detailed collaboration from hotel perspective with creator info."""
        query = """
            SELECT
                c.id, c.initiator_type, c.status, c.creator_id, c.hotel_id, c.listing_id,
                c.why_great_fit, c.collaboration_type,
                c.free_stay_min_nights, c.free_stay_max_nights,
                c.paid_amount, c.discount_percentage,
                c.travel_date_from, c.travel_date_to,
                c.preferred_date_from, c.preferred_date_to,
                c.preferred_months, c.consent,
                c.created_at, c.updated_at, c.responded_at, c.cancelled_at, c.completed_at,
                cr.user_id as creator_user_id,
                cr.profile_picture as creator_profile_picture,
                cr.portfolio_link as creator_portfolio_link,
                cr.location as creator_location,
                hp.name as hotel_name,
                hl.name as listing_name,
                hl.location as listing_location
            FROM collaborations c
            JOIN creators cr ON cr.id = c.creator_id
            JOIN hotel_profiles hp ON hp.id = c.hotel_id
            JOIN hotel_listings hl ON hl.id = c.listing_id
            WHERE c.id = $1 AND c.hotel_id = $2
        """
        if conn:
            row = await conn.fetchrow(query, collaboration_id, hotel_id)
        else:
            row = await Database.fetchrow(query, collaboration_id, hotel_id)
        return dict(row) if row else None

    @staticmethod
    async def get_user_collaborations(
        user_id: str,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> list:
        """Get all collaborations where user is either creator or hotel owner (for GDPR export)."""
        query = """
            SELECT * FROM collaborations
            WHERE creator_id IN (SELECT id FROM creators WHERE user_id = $1)
               OR listing_id IN (SELECT id FROM hotel_listings WHERE hotel_profile_id IN
                   (SELECT id FROM hotel_profiles WHERE user_id = $1))
        """
        if conn:
            rows = await conn.fetch(query, user_id)
        else:
            rows = await Database.fetch(query, user_id)
        return [dict(r) for r in rows]
