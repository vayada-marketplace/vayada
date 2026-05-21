from app.database import Database
from app.utils import upsert_by_hotel_id


class CancellationPolicyRepository:
    @staticmethod
    async def get_by_hotel_id(hotel_id: str) -> dict | None:
        row = await Database.fetchrow(
            "SELECT * FROM cancellation_policies WHERE hotel_id = $1",
            hotel_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def upsert(hotel_id: str, data: dict) -> dict:
        return await upsert_by_hotel_id("cancellation_policies", hotel_id, data)
