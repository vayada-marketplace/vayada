"""Repository for the lodgify_connections table.

Encryption lives in app.integration_secrets; this layer just persists
the already-encrypted blob. Keeping the cipher one layer up means the
repo stays a thin SQL wrapper — easier to test, easier to reason about.
"""

from app.database import Database

_COLUMNS = (
    "id, hotel_id, lodgify_property_id, lodgify_property_name, "
    "status, last_validated_at, last_error, created_at, updated_at"
)
_COLUMNS_WITH_KEY = _COLUMNS + ", api_key_encrypted"


class LodgifyConnectionRepository:
    @staticmethod
    async def get_by_hotel_id(hotel_id: str, *, include_key: bool = False) -> dict | None:
        cols = _COLUMNS_WITH_KEY if include_key else _COLUMNS
        row = await Database.fetchrow(
            f"SELECT {cols} FROM lodgify_connections WHERE hotel_id = $1",
            hotel_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def upsert(
        hotel_id: str,
        *,
        api_key_encrypted: str,
        lodgify_property_id: str,
        lodgify_property_name: str,
        last_validated_at,
    ) -> dict:
        row = await Database.fetchrow(
            f"""
            INSERT INTO lodgify_connections (
                hotel_id, api_key_encrypted, lodgify_property_id,
                lodgify_property_name, status, last_validated_at, last_error
            )
            VALUES ($1, $2, $3, $4, 'active', $5, NULL)
            ON CONFLICT (hotel_id) DO UPDATE SET
                api_key_encrypted = EXCLUDED.api_key_encrypted,
                lodgify_property_id = EXCLUDED.lodgify_property_id,
                lodgify_property_name = EXCLUDED.lodgify_property_name,
                status = 'active',
                last_validated_at = EXCLUDED.last_validated_at,
                last_error = NULL,
                updated_at = now()
            RETURNING {_COLUMNS}
            """,
            hotel_id,
            api_key_encrypted,
            lodgify_property_id,
            lodgify_property_name,
            last_validated_at,
        )
        return dict(row)

    @staticmethod
    async def mark_disconnected(hotel_id: str) -> None:
        """Soft-delete: clear the encrypted key (so it can't be used by
        a leaked DB dump after disconnect) but keep the row for audit
        history of past connections."""
        await Database.execute(
            """
            UPDATE lodgify_connections
            SET status = 'disconnected',
                api_key_encrypted = '',
                updated_at = now()
            WHERE hotel_id = $1
            """,
            hotel_id,
        )

    @staticmethod
    async def record_error(hotel_id: str, message: str) -> None:
        await Database.execute(
            """
            UPDATE lodgify_connections
            SET status = 'error',
                last_error = $2,
                updated_at = now()
            WHERE hotel_id = $1
            """,
            hotel_id,
            message,
        )
