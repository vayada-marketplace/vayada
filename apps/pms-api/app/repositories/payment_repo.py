from typing import Optional
from app.database import Database


class PaymentRepository:

    @staticmethod
    async def create(
        booking_id: str,
        amount: float,
        currency: str,
        payment_method: str,
        stripe_pi_id: Optional[str] = None,
    ) -> dict:
        row = await Database.fetchrow(
            """
            INSERT INTO payments (
                booking_id, amount, currency, payment_method,
                stripe_payment_intent_id, status
            ) VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
            """,
            booking_id,
            amount,
            currency,
            payment_method,
            stripe_pi_id,
            "pending",
        )
        return dict(row)

    @staticmethod
    async def get_by_booking_id(booking_id: str) -> Optional[dict]:
        row = await Database.fetchrow(
            "SELECT * FROM payments WHERE booking_id = $1 ORDER BY created_at DESC LIMIT 1",
            booking_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def get_by_stripe_pi(stripe_pi_id: str) -> Optional[dict]:
        row = await Database.fetchrow(
            "SELECT * FROM payments WHERE stripe_payment_intent_id = $1",
            stripe_pi_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def update_status(payment_id: str, status: str, **kwargs) -> dict:
        sets = ["status = $2", "updated_at = now()"]
        args = [payment_id, status]
        idx = 3

        for key in ("captured_at", "refunded_at", "refund_amount", "card_last_four", "card_brand"):
            if key in kwargs:
                sets.append(f"{key} = ${idx}")
                args.append(kwargs[key])
                idx += 1

        row = await Database.fetchrow(
            f"UPDATE payments SET {', '.join(sets)} WHERE id = $1 RETURNING *",
            *args,
        )
        return dict(row)
