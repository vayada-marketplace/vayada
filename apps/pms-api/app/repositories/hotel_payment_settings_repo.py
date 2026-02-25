from typing import Optional
from app.database import Database


class HotelPaymentSettingsRepository:

    @staticmethod
    async def get_by_hotel_id(hotel_id: str) -> Optional[dict]:
        row = await Database.fetchrow(
            "SELECT * FROM hotel_payment_settings WHERE hotel_id = $1",
            hotel_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def upsert(hotel_id: str, data: dict) -> dict:
        existing = await HotelPaymentSettingsRepository.get_by_hotel_id(hotel_id)

        if existing:
            sets = ["updated_at = now()"]
            args = [str(existing["id"])]
            idx = 2
            for key, value in data.items():
                sets.append(f"{key} = ${idx}")
                args.append(value)
                idx += 1

            row = await Database.fetchrow(
                f"UPDATE hotel_payment_settings SET {', '.join(sets)} WHERE id = $1 RETURNING *",
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
                INSERT INTO hotel_payment_settings ({', '.join(columns)})
                VALUES ({', '.join(placeholders)})
                RETURNING *
                """,
                *values,
            )
        return dict(row)
