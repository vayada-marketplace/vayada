import json

from asyncpg import Connection

from app.database import Database


class BookingEventRepository:
    @staticmethod
    async def record(
        *,
        booking_id: str,
        hotel_id: str,
        event_type: str,
        payload: dict,
        actor_user_id: str | None = None,
        conn: Connection | None = None,
    ) -> dict:
        executor = conn or Database
        row = await executor.fetchrow(
            """
            INSERT INTO booking_events (
                booking_id, hotel_id, event_type, payload, actor_user_id
            ) VALUES ($1, $2, $3, $4::jsonb, $5)
            RETURNING *
            """,
            booking_id,
            hotel_id,
            event_type,
            json.dumps(payload),
            actor_user_id,
        )
        return dict(row)
