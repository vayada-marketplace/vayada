import json

from asyncpg import Connection

from app.database import Database


class CheckinChecklistRepository:
    @staticmethod
    async def get_template(hotel_id: str) -> dict | None:
        row = await Database.fetchrow(
            """
            SELECT hotel_id, steps, updated_at, updated_by
            FROM checkin_checklist_templates
            WHERE hotel_id = $1
            """,
            hotel_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def upsert_template(hotel_id: str, steps: list[dict], user_id: str) -> dict:
        row = await Database.fetchrow(
            """
            INSERT INTO checkin_checklist_templates (hotel_id, steps, updated_by)
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
    async def create_record(
        booking_id: str,
        completed_by: str,
        step_results: list[dict],
        pending_flags: list[dict],
        conn: Connection | None = None,
    ) -> dict:
        executor = conn or Database
        row = await executor.fetchrow(
            """
            INSERT INTO booking_checkin_records (
                booking_id,
                completed_by,
                step_results,
                pending_flags
            )
            VALUES ($1, $2, $3::jsonb, $4::jsonb)
            RETURNING *
            """,
            booking_id,
            completed_by,
            json.dumps(step_results),
            json.dumps(pending_flags),
        )
        return dict(row)
