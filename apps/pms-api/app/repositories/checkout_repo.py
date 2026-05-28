import json

from asyncpg import Connection

from app.database import Database


class CheckoutRepository:
    @staticmethod
    async def get_template(hotel_id: str) -> dict | None:
        row = await Database.fetchrow(
            """
            SELECT hotel_id, steps, updated_at, updated_by
            FROM checkout_inspection_templates
            WHERE hotel_id = $1
            """,
            hotel_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def upsert_template(hotel_id: str, steps: list[dict], user_id: str) -> dict:
        row = await Database.fetchrow(
            """
            INSERT INTO checkout_inspection_templates (hotel_id, steps, updated_by)
            VALUES ($1, $2::jsonb, $3)
            ON CONFLICT (hotel_id) DO UPDATE
            SET steps = EXCLUDED.steps,
                updated_by = EXCLUDED.updated_by,
                updated_at = now()
            RETURNING hotel_id, steps, updated_at, updated_by
            """,
            hotel_id,
            json.dumps(steps),
            user_id,
        )
        return dict(row)

    @staticmethod
    async def list_charges(booking_id: str, conn: Connection | None = None) -> list[dict]:
        executor = conn or Database
        rows = await executor.fetch(
            """
            SELECT *
            FROM booking_checkout_charges
            WHERE booking_id = $1
            ORDER BY created_at, id
            """,
            booking_id,
        )
        return [dict(row) for row in rows]

    @staticmethod
    async def create_charge(
        booking_id: str,
        hotel_id: str,
        label: str,
        amount: float,
        user_id: str,
        conn: Connection | None = None,
    ) -> dict:
        executor = conn or Database
        row = await executor.fetchrow(
            """
            INSERT INTO booking_checkout_charges (
                booking_id,
                hotel_id,
                label,
                amount,
                original_amount,
                created_by
            )
            VALUES ($1, $2, $3, $4, $4, $5)
            RETURNING *
            """,
            booking_id,
            hotel_id,
            label,
            amount,
            user_id,
        )
        return dict(row)

    @staticmethod
    async def settle_charge(
        charge_id: str,
        booking_id: str,
        conn: Connection | None = None,
    ) -> dict | None:
        executor = conn or Database
        row = await executor.fetchrow(
            """
            UPDATE booking_checkout_charges
            SET status = 'paid',
                settled_at = now()
            WHERE id = $1
              AND booking_id = $2
              AND status = 'pending'
            RETURNING *
            """,
            charge_id,
            booking_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def waive_charge(
        charge_id: str,
        booking_id: str,
        conn: Connection | None = None,
    ) -> dict | None:
        executor = conn or Database
        row = await executor.fetchrow(
            """
            UPDATE booking_checkout_charges
            SET status = 'waived',
                amount = 0,
                waived_at = now()
            WHERE id = $1
              AND booking_id = $2
              AND status = 'pending'
            RETURNING *
            """,
            charge_id,
            booking_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def pending_total(booking_id: str, conn: Connection | None = None) -> float:
        executor = conn or Database
        value = await executor.fetchval(
            """
            SELECT COALESCE(SUM(amount), 0)
            FROM booking_checkout_charges
            WHERE booking_id = $1
              AND status = 'pending'
            """,
            booking_id,
        )
        return float(value or 0)

    @staticmethod
    async def create_record(
        booking_id: str,
        completed_by: str,
        inspection_results: list[dict],
        charges_settled: list[dict],
        pending_flags: list[dict],
        checkout_notes: str | None,
        conn: Connection | None = None,
    ) -> dict:
        executor = conn or Database
        row = await executor.fetchrow(
            """
            INSERT INTO booking_checkout_records (
                booking_id,
                completed_by,
                inspection_results,
                charges_settled,
                pending_flags,
                checkout_notes
            )
            VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6)
            RETURNING *
            """,
            booking_id,
            completed_by,
            json.dumps(inspection_results),
            json.dumps(charges_settled),
            json.dumps(pending_flags),
            checkout_notes,
        )
        return dict(row)

    @staticmethod
    async def get_latest_record(booking_id: str) -> dict | None:
        row = await Database.fetchrow(
            """
            SELECT *
            FROM booking_checkout_records
            WHERE booking_id = $1
            ORDER BY completed_at DESC
            LIMIT 1
            """,
            booking_id,
        )
        return dict(row) if row else None
