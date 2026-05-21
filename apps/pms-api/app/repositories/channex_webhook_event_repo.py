import json

from app.database import Database


class ChannexWebhookEventRepository:
    @staticmethod
    async def insert(
        event_type: str,
        property_id: str | None,
        payload: dict,
    ) -> str:
        row = await Database.fetchrow(
            """
            INSERT INTO channex_webhook_events (event_type, property_id, payload)
            VALUES ($1, $2, $3::jsonb)
            RETURNING id
            """,
            event_type,
            property_id,
            json.dumps(payload),
        )
        return str(row["id"])

    @staticmethod
    async def mark_processed(event_id: str, ok: bool, error: str | None = None) -> None:
        await Database.execute(
            """
            UPDATE channex_webhook_events
               SET processed_ok = $2, error = $3
             WHERE id = $1
            """,
            event_id,
            ok,
            error,
        )

    @staticmethod
    async def summary_since(hours: int) -> list[dict]:
        """Counts grouped by event_type + processed_ok over the given window."""
        rows = await Database.fetch(
            """
            SELECT
                event_type,
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE processed_ok IS TRUE)  AS ok,
                COUNT(*) FILTER (WHERE processed_ok IS FALSE) AS failed,
                COUNT(*) FILTER (WHERE processed_ok IS NULL)  AS ignored,
                MAX(received_at) AS last_received_at
            FROM channex_webhook_events
            WHERE received_at >= now() - make_interval(hours => $1)
            GROUP BY event_type
            ORDER BY event_type
            """,
            hours,
        )
        return [dict(r) for r in rows]
