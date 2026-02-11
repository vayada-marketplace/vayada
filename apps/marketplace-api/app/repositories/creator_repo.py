"""
Repository for creators and creator_platforms tables (Database).
"""
from typing import Optional, List

import asyncpg

from app.database import Database


class CreatorRepository:

    @staticmethod
    async def get_by_user_id(
        user_id: str,
        *,
        columns: str = "*",
        conn: Optional[asyncpg.Connection] = None,
    ) -> Optional[dict]:
        query = f"SELECT {columns} FROM creators WHERE user_id = $1"
        if conn:
            row = await conn.fetchrow(query, user_id)
        else:
            row = await Database.fetchrow(query, user_id)
        return dict(row) if row else None

    @staticmethod
    async def get_by_id(
        creator_id: str,
        *,
        columns: str = "*",
        conn: Optional[asyncpg.Connection] = None,
    ) -> Optional[dict]:
        query = f"SELECT {columns} FROM creators WHERE id = $1"
        if conn:
            row = await conn.fetchrow(query, creator_id)
        else:
            row = await Database.fetchrow(query, creator_id)
        return dict(row) if row else None

    @staticmethod
    async def create(
        user_id: str,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> None:
        query = """
            INSERT INTO creators (user_id, location, short_description)
            VALUES ($1, NULL, NULL)
        """
        if conn:
            await conn.execute(query, user_id)
        else:
            await Database.execute(query, user_id)

    @staticmethod
    async def update(
        creator_id: str,
        update_fields: List[str],
        update_values: list,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> None:
        """Execute a dynamic UPDATE on the creators table.

        ``update_fields`` is a list of SET fragments like ``["location = $1", "short_description = $2"]``.
        ``update_values`` must include all positional args including the final WHERE id value.
        """
        if not update_fields:
            return
        update_fields_with_ts = update_fields + ["updated_at = now()"]
        param_idx = len(update_values) + 1
        update_values_final = list(update_values) + [creator_id]
        query = f"""
            UPDATE creators
            SET {', '.join(update_fields_with_ts)}
            WHERE id = ${param_idx}
        """
        if conn:
            await conn.execute(query, *update_values_final)
        else:
            await Database.execute(query, *update_values_final)

    @staticmethod
    async def get_platforms(
        creator_id: str,
        *,
        columns: str = "id, name, handle, followers, engagement_rate, top_countries, top_age_groups, gender_split",
        conn: Optional[asyncpg.Connection] = None,
    ) -> list:
        query = f"SELECT {columns} FROM creator_platforms WHERE creator_id = $1 ORDER BY name"
        if conn:
            rows = await conn.fetch(query, creator_id)
        else:
            rows = await Database.fetch(query, creator_id)
        return [dict(r) for r in rows]

    @staticmethod
    async def delete_platforms(
        creator_id: str,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> None:
        query = "DELETE FROM creator_platforms WHERE creator_id = $1"
        if conn:
            await conn.execute(query, creator_id)
        else:
            await Database.execute(query, creator_id)

    @staticmethod
    async def insert_platform(
        creator_id: str,
        name: str,
        handle: str,
        followers: int,
        engagement_rate,
        top_countries_json: Optional[str] = None,
        top_age_groups_json: Optional[str] = None,
        gender_split_json: Optional[str] = None,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> None:
        query = """
            INSERT INTO creator_platforms
            (creator_id, name, handle, followers, engagement_rate, top_countries, top_age_groups, gender_split)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        """
        if conn:
            await conn.execute(
                query, creator_id, name, handle, followers, engagement_rate,
                top_countries_json, top_age_groups_json, gender_split_json,
            )
        else:
            await Database.execute(
                query, creator_id, name, handle, followers, engagement_rate,
                top_countries_json, top_age_groups_json, gender_split_json,
            )

    @staticmethod
    async def get_ratings(
        creator_id: str,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> list:
        query = """
            SELECT cr.id, cr.hotel_id, cr.rating, cr.comment, cr.created_at,
                   hp.name as hotel_name
            FROM creator_ratings cr
            LEFT JOIN hotel_profiles hp ON cr.hotel_id = hp.id
            WHERE cr.creator_id = $1
            ORDER BY cr.created_at DESC
        """
        if conn:
            rows = await conn.fetch(query, creator_id)
        else:
            rows = await Database.fetch(query, creator_id)
        return [dict(r) for r in rows]

    @staticmethod
    async def get_complete_creators_by_user_ids(
        verified_ids: list,
        *,
        creator_type_filter: Optional[list] = None,
        conn: Optional[asyncpg.Connection] = None,
    ) -> list:
        """Get creators with complete profiles whose user_id is in verified_ids."""
        query = """
            SELECT
                c.id,
                c.user_id,
                c.location,
                c.short_description,
                c.portfolio_link,
                c.profile_picture,
                c.creator_type,
                c.created_at,
                COALESCE(rating_stats.average_rating, 0.0) as average_rating,
                COALESCE(rating_stats.total_reviews, 0) as total_reviews
            FROM creators c
            LEFT JOIN (
                SELECT
                    creator_id,
                    AVG(rating)::float as average_rating,
                    COUNT(*)::int as total_reviews
                FROM creator_ratings
                GROUP BY creator_id
            ) rating_stats ON rating_stats.creator_id = c.id
            WHERE c.profile_complete = true
            AND c.user_id = ANY($1::uuid[])
        """
        params: list = [verified_ids]
        param_counter = 2

        if creator_type_filter:
            query += f" AND c.creator_type = ANY(${param_counter}::text[])"
            params.append(creator_type_filter)
            param_counter += 1

        query += " ORDER BY c.created_at DESC"

        if conn:
            rows = await conn.fetch(query, *params)
        else:
            rows = await Database.fetch(query, *params)
        return [dict(r) for r in rows]

    @staticmethod
    async def get_platforms_for_creators(
        creator_ids: list,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> list:
        """Batch-fetch platforms for multiple creators."""
        if not creator_ids:
            return []
        placeholders = ','.join([f'${i+1}' for i in range(len(creator_ids))])
        query = f"""
            SELECT id, creator_id, name, handle, followers, engagement_rate,
                   top_countries, top_age_groups, gender_split
            FROM creator_platforms
            WHERE creator_id IN ({placeholders})
            ORDER BY creator_id, name
        """
        if conn:
            rows = await conn.fetch(query, *creator_ids)
        else:
            rows = await Database.fetch(query, *creator_ids)
        return [dict(r) for r in rows]
