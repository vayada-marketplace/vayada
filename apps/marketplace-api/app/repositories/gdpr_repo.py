"""
Repository for gdpr_requests table (AuthDatabase).
"""
from typing import Optional
from datetime import datetime

import asyncpg

from app.database import AuthDatabase


class GdprRepository:

    @staticmethod
    async def get_pending_request(
        user_id: str,
        request_type: str,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> Optional[dict]:
        """Get existing pending/processing request for user."""
        query = """
            SELECT id, status, requested_at, expires_at
            FROM gdpr_requests
            WHERE user_id = $1 AND request_type = $2 AND status IN ('pending', 'processing')
        """
        if conn:
            row = await conn.fetchrow(query, user_id, request_type)
        else:
            row = await AuthDatabase.fetchrow(query, user_id, request_type)
        return dict(row) if row else None

    @staticmethod
    async def create_export_request(
        user_id: str,
        download_token: str,
        expires_at: datetime,
        ip_address: str,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> dict:
        query = """
            INSERT INTO gdpr_requests (user_id, request_type, status, download_token, expires_at, ip_address)
            VALUES ($1, 'export', 'pending', $2, $3, $4)
            RETURNING id, status, requested_at, expires_at
        """
        if conn:
            row = await conn.fetchrow(query, user_id, download_token, expires_at, ip_address)
        else:
            row = await AuthDatabase.fetchrow(query, user_id, download_token, expires_at, ip_address)
        return dict(row)

    @staticmethod
    async def create_deletion_request(
        user_id: str,
        scheduled_deletion: datetime,
        ip_address: str,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> dict:
        query = """
            INSERT INTO gdpr_requests (user_id, request_type, status, expires_at, ip_address)
            VALUES ($1, 'deletion', 'pending', $2, $3)
            RETURNING id, status, requested_at, expires_at
        """
        if conn:
            row = await conn.fetchrow(query, user_id, scheduled_deletion, ip_address)
        else:
            row = await AuthDatabase.fetchrow(query, user_id, scheduled_deletion, ip_address)
        return dict(row)

    @staticmethod
    async def update_status(
        request_id: str,
        new_status: str,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> None:
        query = "UPDATE gdpr_requests SET status = $1 WHERE id = $2"
        if conn:
            await conn.execute(query, new_status, request_id)
        else:
            await AuthDatabase.execute(query, new_status, request_id)

    @staticmethod
    async def mark_completed(
        request_id: str,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> None:
        query = """
            UPDATE gdpr_requests
            SET status = 'completed', processed_at = now()
            WHERE id = $1
        """
        if conn:
            await conn.execute(query, request_id)
        else:
            await AuthDatabase.execute(query, request_id)

    @staticmethod
    async def get_by_download_token(
        token: str,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> Optional[dict]:
        query = """
            SELECT id, user_id, status, expires_at
            FROM gdpr_requests
            WHERE download_token = $1 AND request_type = 'export'
        """
        if conn:
            row = await conn.fetchrow(query, token)
        else:
            row = await AuthDatabase.fetchrow(query, token)
        return dict(row) if row else None

    @staticmethod
    async def get_latest_request(
        user_id: str,
        request_type: str,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> Optional[dict]:
        query = """
            SELECT id, request_type, status, requested_at, processed_at, expires_at
            FROM gdpr_requests
            WHERE user_id = $1 AND request_type = $2
            ORDER BY requested_at DESC
            LIMIT 1
        """
        if conn:
            row = await conn.fetchrow(query, user_id, request_type)
        else:
            row = await AuthDatabase.fetchrow(query, user_id, request_type)
        return dict(row) if row else None

    @staticmethod
    async def get_pending_deletion(
        user_id: str,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> Optional[dict]:
        query = """
            SELECT id, status, expires_at
            FROM gdpr_requests
            WHERE user_id = $1 AND request_type = 'deletion' AND status = 'pending'
        """
        if conn:
            row = await conn.fetchrow(query, user_id)
        else:
            row = await AuthDatabase.fetchrow(query, user_id)
        return dict(row) if row else None

    @staticmethod
    async def cancel_request(
        request_id: str,
        *,
        conn: Optional[asyncpg.Connection] = None,
    ) -> None:
        query = """
            UPDATE gdpr_requests
            SET status = 'cancelled', cancellation_reason = 'User cancelled'
            WHERE id = $1
        """
        if conn:
            await conn.execute(query, request_id)
        else:
            await AuthDatabase.execute(query, request_id)
