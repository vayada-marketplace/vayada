from app.database import Database


class PaymentRepository:
    @staticmethod
    async def create(
        booking_id: str,
        amount: float,
        currency: str,
        payment_method: str,
        stripe_pi_id: str | None = None,
        xendit_invoice_id: str | None = None,
        xendit_invoice_url: str | None = None,
    ) -> dict:
        row = await Database.fetchrow(
            """
            INSERT INTO payments (
                booking_id, amount, currency, payment_method,
                stripe_payment_intent_id, xendit_invoice_id,
                xendit_invoice_url, status
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING *
            """,
            booking_id,
            amount,
            currency,
            payment_method,
            stripe_pi_id,
            xendit_invoice_id,
            xendit_invoice_url,
            "pending",
        )
        return dict(row)

    @staticmethod
    async def get_by_booking_id(booking_id: str) -> dict | None:
        row = await Database.fetchrow(
            "SELECT * FROM payments WHERE booking_id = $1 ORDER BY created_at DESC LIMIT 1",
            booking_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def get_by_xendit_invoice(xendit_invoice_id: str) -> dict | None:
        row = await Database.fetchrow(
            "SELECT * FROM payments WHERE xendit_invoice_id = $1",
            xendit_invoice_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def get_by_stripe_pi(stripe_pi_id: str) -> dict | None:
        row = await Database.fetchrow(
            "SELECT * FROM payments WHERE stripe_payment_intent_id = $1",
            stripe_pi_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def list_by_booking_ids(booking_ids: list[str]) -> list[dict]:
        if not booking_ids:
            return []
        rows = await Database.fetch(
            """
            SELECT * FROM payments
            WHERE booking_id = ANY($1::uuid[])
            ORDER BY created_at ASC
            """,
            booking_ids,
        )
        return [dict(r) for r in rows]

    @staticmethod
    async def list_by_hotel(
        hotel_id: str,
        *,
        limit: int = 50,
        offset: int = 0,
    ) -> list[dict]:
        rows = await Database.fetch(
            """
            SELECT p.*, b.booking_reference, b.guest_first_name,
                   b.guest_last_name, b.created_at AS booking_created_at
            FROM payments p
            JOIN bookings b ON b.id = p.booking_id
            WHERE b.hotel_id = $1
            ORDER BY p.created_at DESC
            LIMIT $2 OFFSET $3
            """,
            hotel_id,
            limit,
            offset,
        )
        return [dict(r) for r in rows]

    @staticmethod
    async def count_by_hotel(hotel_id: str) -> int:
        count = await Database.fetchval(
            """
            SELECT COUNT(*) FROM payments p
            JOIN bookings b ON b.id = p.booking_id
            WHERE b.hotel_id = $1
            """,
            hotel_id,
        )
        return count or 0

    @staticmethod
    async def create_manual(
        booking_id: str,
        amount: float,
        currency: str,
        payment_method: str,
        reference: str | None = None,
        recorded_by: str | None = None,
    ) -> dict:
        """Record a payment that was made offline (cash, bank transfer, …).

        Goes straight to status='captured' since the operator is logging
        money already received.
        """
        row = await Database.fetchrow(
            """
            INSERT INTO payments (
                booking_id, amount, currency, payment_method,
                status, reference, recorded_by, captured_at
            ) VALUES ($1, $2, $3, $4, 'captured', $5, $6, now())
            RETURNING *
            """,
            booking_id,
            amount,
            currency,
            payment_method,
            reference,
            recorded_by,
        )
        return dict(row)

    @staticmethod
    async def list_for_hotel_currency_conversion(hotel_id: str) -> list[dict]:
        """Minimal projection used when re-denominating payments on a
        hotel currency change (VAY-335)."""
        rows = await Database.fetch(
            """
            SELECT p.id, p.amount, p.refund_amount, p.currency
            FROM payments p
            JOIN bookings b ON b.id = p.booking_id
            WHERE b.hotel_id = $1
            """,
            hotel_id,
        )
        return [dict(r) for r in rows]

    @staticmethod
    async def update_amounts_and_currency(
        payment_id: str,
        *,
        amount: float,
        refund_amount: float | None,
        currency: str,
    ) -> None:
        await Database.execute(
            """
            UPDATE payments
            SET amount = $2,
                refund_amount = $3,
                currency = $4,
                updated_at = now()
            WHERE id = $1
            """,
            payment_id,
            amount,
            refund_amount,
            currency,
        )

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
