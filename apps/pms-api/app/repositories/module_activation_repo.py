from app.database import Database


class ModuleActivationRepository:
    @staticmethod
    async def list_by_hotel_id(hotel_id: str) -> list[dict]:
        rows = await Database.fetch(
            """
            SELECT module_id, is_active, activated_at, deactivated_at, updated_at
            FROM property_module_activations
            WHERE hotel_id = $1
            ORDER BY module_id ASC
            """,
            hotel_id,
        )
        return [dict(row) for row in rows]

    @staticmethod
    async def upsert(hotel_id: str, module_id: str, is_active: bool) -> dict:
        row = await Database.fetchrow(
            """
            INSERT INTO property_module_activations (
                hotel_id,
                module_id,
                is_active,
                activated_at,
                deactivated_at,
                updated_at
            )
            VALUES (
                $1,
                $2,
                $3,
                CASE WHEN $3 THEN NOW() ELSE NULL END,
                CASE WHEN $3 THEN NULL ELSE NOW() END,
                NOW()
            )
            ON CONFLICT (hotel_id, module_id) DO UPDATE
            SET
                is_active = EXCLUDED.is_active,
                activated_at = CASE
                    WHEN EXCLUDED.is_active THEN COALESCE(property_module_activations.activated_at, NOW())
                    ELSE NULL
                END,
                deactivated_at = CASE
                    WHEN EXCLUDED.is_active THEN NULL
                    ELSE NOW()
                END,
                updated_at = NOW()
            RETURNING module_id, is_active, activated_at, deactivated_at, updated_at
            """,
            hotel_id,
            module_id,
            is_active,
        )
        return dict(row)
