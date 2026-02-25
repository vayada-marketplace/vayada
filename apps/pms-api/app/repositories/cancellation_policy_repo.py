from typing import Optional
from app.database import Database


class CancellationPolicyRepository:

    @staticmethod
    async def get_by_hotel_id(hotel_id: str) -> Optional[dict]:
        row = await Database.fetchrow(
            "SELECT * FROM cancellation_policies WHERE hotel_id = $1",
            hotel_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def upsert(hotel_id: str, data: dict) -> dict:
        existing = await CancellationPolicyRepository.get_by_hotel_id(hotel_id)

        if existing:
            sets = ["updated_at = now()"]
            args = [str(existing["id"])]
            idx = 2
            for key, value in data.items():
                sets.append(f"{key} = ${idx}")
                args.append(value)
                idx += 1

            row = await Database.fetchrow(
                f"UPDATE cancellation_policies SET {', '.join(sets)} WHERE id = $1 RETURNING *",
                *args,
            )
        else:
            columns = ["hotel_id"]
            values = [hotel_id]
            placeholders = ["$1"]
            idx = 2
            for key, value in data.items():
                columns.append(key)
                values.append(value)
                placeholders.append(f"${idx}")
                idx += 1

            row = await Database.fetchrow(
                f"""
                INSERT INTO cancellation_policies ({', '.join(columns)})
                VALUES ({', '.join(placeholders)})
                RETURNING *
                """,
                *values,
            )
        return dict(row)
