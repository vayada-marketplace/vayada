from typing import Optional, List
from app.database import Database


class PayoutRepository:

    @staticmethod
    async def create(
        booking_id: str,
        recipient_type: str,
        recipient_id: str,
        amount: float,
        currency: str,
        scheduled_for,
    ) -> dict:
        row = await Database.fetchrow(
            """
            INSERT INTO payouts (
                booking_id, recipient_type, recipient_id,
                amount, currency, scheduled_for
            ) VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
            """,
            booking_id,
            recipient_type,
            recipient_id,
            amount,
            currency,
            scheduled_for,
        )
        return dict(row)

    @staticmethod
    async def list_due_payouts(before_date) -> List[dict]:
        rows = await Database.fetch(
            """
            SELECT p.*, b.booking_reference
            FROM payouts p
            JOIN bookings b ON b.id = p.booking_id
            WHERE p.status = 'scheduled'
              AND p.scheduled_for <= $1
            ORDER BY p.scheduled_for
            """,
            before_date,
        )
        return [dict(r) for r in rows]

    @staticmethod
    async def list_monthly_affiliate_payouts(month: int, year: int) -> List[dict]:
        rows = await Database.fetch(
            """
            SELECT p.*, b.booking_reference, b.check_out, b.status AS booking_status
            FROM payouts p
            JOIN bookings b ON b.id = p.booking_id
            WHERE p.recipient_type = 'affiliate'
              AND p.status = 'scheduled'
              AND EXTRACT(MONTH FROM p.scheduled_for) = $1
              AND EXTRACT(YEAR FROM p.scheduled_for) = $2
              AND b.status = 'confirmed'
              AND b.check_out < now()
            ORDER BY p.scheduled_for
            """,
            month,
            year,
        )
        return [dict(r) for r in rows]

    @staticmethod
    async def update_status(
        payout_id: str, status: str, stripe_transfer_id: Optional[str] = None
    ) -> dict:
        if stripe_transfer_id:
            row = await Database.fetchrow(
                """
                UPDATE payouts
                SET status = $2, stripe_transfer_id = $3,
                    completed_at = CASE WHEN $2 = 'completed' THEN now() ELSE completed_at END,
                    updated_at = now()
                WHERE id = $1
                RETURNING *
                """,
                payout_id,
                status,
                stripe_transfer_id,
            )
        else:
            row = await Database.fetchrow(
                """
                UPDATE payouts
                SET status = $2,
                    completed_at = CASE WHEN $2 = 'completed' THEN now() ELSE completed_at END,
                    updated_at = now()
                WHERE id = $1
                RETURNING *
                """,
                payout_id,
                status,
            )
        return dict(row)

    @staticmethod
    async def cancel_by_booking(booking_id: str) -> None:
        await Database.execute(
            """
            UPDATE payouts SET status = 'failed', updated_at = now()
            WHERE booking_id = $1 AND status = 'scheduled'
            """,
            booking_id,
        )

    @staticmethod
    async def list_by_hotel(
        hotel_id: str,
        *,
        status: Optional[str] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> List[dict]:
        conditions = ["b.hotel_id = $1"]
        args: list = [hotel_id]
        idx = 2

        if status:
            conditions.append(f"p.status = ${idx}")
            args.append(status)
            idx += 1

        where = " AND ".join(conditions)
        args.extend([limit, offset])
        rows = await Database.fetch(
            f"""
            SELECT p.*, b.booking_reference, b.guest_first_name, b.guest_last_name
            FROM payouts p
            JOIN bookings b ON b.id = p.booking_id
            WHERE {where}
            ORDER BY p.created_at DESC
            LIMIT ${idx} OFFSET ${idx + 1}
            """,
            *args,
        )
        return [dict(r) for r in rows]

    @staticmethod
    async def count_by_hotel(hotel_id: str, *, status: Optional[str] = None) -> int:
        if status:
            count = await Database.fetchval(
                """
                SELECT COUNT(*) FROM payouts p
                JOIN bookings b ON b.id = p.booking_id
                WHERE b.hotel_id = $1 AND p.status = $2
                """,
                hotel_id,
                status,
            )
        else:
            count = await Database.fetchval(
                """
                SELECT COUNT(*) FROM payouts p
                JOIN bookings b ON b.id = p.booking_id
                WHERE b.hotel_id = $1
                """,
                hotel_id,
            )
        return count or 0
