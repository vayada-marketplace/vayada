"""
Repository for trips and external_collaborations tables (Database).
"""

import asyncpg

from app.database import Database


class TripRepository:
    @staticmethod
    async def create(
        creator_id: str,
        name: str,
        location: str | None,
        start_date,
        end_date,
        notes: str | None,
        *,
        conn: asyncpg.Connection | None = None,
    ) -> dict:
        query = """
            INSERT INTO trips (creator_id, name, location, start_date, end_date, notes)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
        """
        if conn:
            row = await conn.fetchrow(
                query, creator_id, name, location, start_date, end_date, notes
            )
        else:
            row = await Database.fetchrow(
                query, creator_id, name, location, start_date, end_date, notes
            )
        return dict(row)

    @staticmethod
    async def get_by_id(
        trip_id: str,
        *,
        conn: asyncpg.Connection | None = None,
    ) -> dict | None:
        query = "SELECT * FROM trips WHERE id = $1"
        if conn:
            row = await conn.fetchrow(query, trip_id)
        else:
            row = await Database.fetchrow(query, trip_id)
        return dict(row) if row else None

    @staticmethod
    async def get_by_id_and_creator(
        trip_id: str,
        creator_id: str,
        *,
        conn: asyncpg.Connection | None = None,
    ) -> dict | None:
        query = "SELECT * FROM trips WHERE id = $1 AND creator_id = $2"
        if conn:
            row = await conn.fetchrow(query, trip_id, creator_id)
        else:
            row = await Database.fetchrow(query, trip_id, creator_id)
        return dict(row) if row else None

    @staticmethod
    async def list_by_creator(
        creator_id: str,
        *,
        conn: asyncpg.Connection | None = None,
    ) -> list:
        query = "SELECT * FROM trips WHERE creator_id = $1 ORDER BY start_date DESC"
        if conn:
            rows = await conn.fetch(query, creator_id)
        else:
            rows = await Database.fetch(query, creator_id)
        return [dict(r) for r in rows]

    @staticmethod
    async def update(trip_id: str, **kwargs) -> dict | None:
        fields = {k: v for k, v in kwargs.items() if v is not None}
        if not fields:
            return await TripRepository.get_by_id(trip_id)

        set_clauses = []
        params = []
        for i, (key, value) in enumerate(fields.items(), 1):
            set_clauses.append(f"{key} = ${i}")
            params.append(value)
        params.append(trip_id)

        query = f"UPDATE trips SET {', '.join(set_clauses)} WHERE id = ${len(params)} RETURNING *"
        row = await Database.fetchrow(query, *params)
        return dict(row) if row else None

    @staticmethod
    async def delete(trip_id: str) -> bool:
        result = await Database.execute("DELETE FROM trips WHERE id = $1", trip_id)
        return result == "DELETE 1"


class ExternalCollaborationRepository:
    @staticmethod
    async def create(
        creator_id: str,
        title: str,
        start_date,
        end_date,
        *,
        trip_id=None,
        hotel_name=None,
        location=None,
        collaboration_type=None,
        deliverables=None,
        notes=None,
        conn: asyncpg.Connection | None = None,
    ) -> dict:
        query = """
            INSERT INTO external_collaborations
                (creator_id, trip_id, title, hotel_name, location, collaboration_type, start_date, end_date, deliverables, notes)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING *
        """
        params = (
            creator_id,
            trip_id,
            title,
            hotel_name,
            location,
            collaboration_type,
            start_date,
            end_date,
            deliverables,
            notes,
        )
        if conn:
            row = await conn.fetchrow(query, *params)
        else:
            row = await Database.fetchrow(query, *params)
        return dict(row)

    @staticmethod
    async def get_by_id(
        collab_id: str,
        *,
        conn: asyncpg.Connection | None = None,
    ) -> dict | None:
        query = "SELECT * FROM external_collaborations WHERE id = $1"
        if conn:
            row = await conn.fetchrow(query, collab_id)
        else:
            row = await Database.fetchrow(query, collab_id)
        return dict(row) if row else None

    @staticmethod
    async def get_by_id_and_creator(
        collab_id: str,
        creator_id: str,
        *,
        conn: asyncpg.Connection | None = None,
    ) -> dict | None:
        query = "SELECT * FROM external_collaborations WHERE id = $1 AND creator_id = $2"
        if conn:
            row = await conn.fetchrow(query, collab_id, creator_id)
        else:
            row = await Database.fetchrow(query, collab_id, creator_id)
        return dict(row) if row else None

    @staticmethod
    async def list_by_creator(
        creator_id: str,
        *,
        trip_id: str | None = None,
        conn: asyncpg.Connection | None = None,
    ) -> list:
        query = "SELECT * FROM external_collaborations WHERE creator_id = $1"
        params: list = [creator_id]
        if trip_id:
            query += " AND trip_id = $2"
            params.append(trip_id)
        query += " ORDER BY start_date DESC"
        if conn:
            rows = await conn.fetch(query, *params)
        else:
            rows = await Database.fetch(query, *params)
        return [dict(r) for r in rows]

    @staticmethod
    async def list_by_trip(
        trip_id: str,
        *,
        conn: asyncpg.Connection | None = None,
    ) -> list:
        query = "SELECT * FROM external_collaborations WHERE trip_id = $1 ORDER BY start_date ASC"
        if conn:
            rows = await conn.fetch(query, trip_id)
        else:
            rows = await Database.fetch(query, trip_id)
        return [dict(r) for r in rows]

    @staticmethod
    async def update(collab_id: str, **kwargs) -> dict | None:
        fields = {k: v for k, v in kwargs.items() if v is not None}
        if not fields:
            return await ExternalCollaborationRepository.get_by_id(collab_id)

        set_clauses = []
        params = []
        for i, (key, value) in enumerate(fields.items(), 1):
            set_clauses.append(f"{key} = ${i}")
            params.append(value)
        params.append(collab_id)

        query = f"UPDATE external_collaborations SET {', '.join(set_clauses)} WHERE id = ${len(params)} RETURNING *"
        row = await Database.fetchrow(query, *params)
        return dict(row) if row else None

    @staticmethod
    async def delete(collab_id: str) -> bool:
        result = await Database.execute(
            "DELETE FROM external_collaborations WHERE id = $1", collab_id
        )
        return result == "DELETE 1"
