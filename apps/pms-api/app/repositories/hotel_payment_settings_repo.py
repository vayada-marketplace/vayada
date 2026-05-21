from typing import Optional
from app.database import Database
from app.utils import upsert_by_hotel_id


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
        return await upsert_by_hotel_id("hotel_payment_settings", hotel_id, data)
