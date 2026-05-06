"""Persistence for guest-initiated booking change requests (VAY-379).

A change request captures the guest's desired new state for a confirmed
booking. It lives in its own table so the booking row stays the
authoritative current state until the host decides — and so we keep an
audit trail of every requested change for the hotel.
"""
import json
from typing import Optional

from app.database import Database


class BookingChangeRequestRepository:

    @staticmethod
    async def create(data: dict) -> dict:
        row = await Database.fetchrow(
            """
            INSERT INTO booking_change_requests (
                booking_id, status,
                old_check_in, old_check_out,
                old_addon_ids, old_addon_quantities, old_addon_dates,
                old_total,
                requested_check_in, requested_check_out,
                requested_addon_ids, requested_addon_quantities, requested_addon_dates,
                requested_nightly_rate, requested_addon_total, requested_addon_names,
                new_total, price_difference, currency
            ) VALUES (
                $1, 'pending',
                $2, $3, $4, $5, $6, $7,
                $8, $9, $10, $11, $12,
                $13, $14, $15, $16, $17, $18
            ) RETURNING *
            """,
            data["booking_id"],
            data["old_check_in"],
            data["old_check_out"],
            json.dumps(data.get("old_addon_ids", [])),
            json.dumps(data.get("old_addon_quantities", {})),
            json.dumps(data.get("old_addon_dates", {})),
            data["old_total"],
            data["requested_check_in"],
            data["requested_check_out"],
            json.dumps(data.get("requested_addon_ids", [])),
            json.dumps(data.get("requested_addon_quantities", {})),
            json.dumps(data.get("requested_addon_dates", {})),
            data["requested_nightly_rate"],
            data.get("requested_addon_total", 0),
            json.dumps(data.get("requested_addon_names", [])),
            data["new_total"],
            data["price_difference"],
            data["currency"],
        )
        return dict(row)

    @staticmethod
    async def get_by_id(change_request_id: str) -> Optional[dict]:
        row = await Database.fetchrow(
            "SELECT * FROM booking_change_requests WHERE id = $1",
            change_request_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def get_by_decision_token(token: str) -> Optional[dict]:
        row = await Database.fetchrow(
            "SELECT * FROM booking_change_requests WHERE decision_token = $1",
            token,
        )
        return dict(row) if row else None

    @staticmethod
    async def get_pending_for_booking(booking_id: str) -> Optional[dict]:
        row = await Database.fetchrow(
            """
            SELECT * FROM booking_change_requests
            WHERE booking_id = $1 AND status = 'pending'
            ORDER BY created_at DESC LIMIT 1
            """,
            booking_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def get_latest_for_booking(booking_id: str) -> Optional[dict]:
        row = await Database.fetchrow(
            """
            SELECT * FROM booking_change_requests
            WHERE booking_id = $1
            ORDER BY created_at DESC LIMIT 1
            """,
            booking_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def mark_decided(
        change_request_id: str,
        new_status: str,
        decline_reason: Optional[str] = None,
    ) -> Optional[dict]:
        row = await Database.fetchrow(
            """
            UPDATE booking_change_requests
            SET status = $2,
                decline_reason = $3,
                decided_at = now()
            WHERE id = $1
            RETURNING *
            """,
            change_request_id,
            new_status,
            decline_reason,
        )
        return dict(row) if row else None
