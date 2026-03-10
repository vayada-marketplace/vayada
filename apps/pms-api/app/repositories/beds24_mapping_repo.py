from typing import Optional, List
from datetime import datetime

from app.database import Database


class Beds24ConnectionRepository:

    @staticmethod
    async def upsert(
        hotel_id: str,
        api_token: str,
        refresh_token: str,
        token_expires_at: datetime,
    ) -> dict:
        existing = await Beds24ConnectionRepository.get_by_hotel_id(hotel_id)
        if existing:
            row = await Database.fetchrow(
                """
                UPDATE beds24_connections
                SET api_token = $2, refresh_token = $3, token_expires_at = $4,
                    is_active = true, updated_at = now()
                WHERE hotel_id = $1
                RETURNING *
                """,
                hotel_id, api_token, refresh_token, token_expires_at,
            )
        else:
            row = await Database.fetchrow(
                """
                INSERT INTO beds24_connections
                    (hotel_id, api_token, refresh_token, token_expires_at)
                VALUES ($1, $2, $3, $4)
                RETURNING *
                """,
                hotel_id, api_token, refresh_token, token_expires_at,
            )
        return dict(row)

    @staticmethod
    async def get_by_hotel_id(hotel_id: str) -> Optional[dict]:
        row = await Database.fetchrow(
            "SELECT * FROM beds24_connections WHERE hotel_id = $1",
            hotel_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def get_by_property_id(beds24_property_id: str) -> Optional[dict]:
        row = await Database.fetchrow(
            "SELECT * FROM beds24_connections WHERE beds24_property_id = $1",
            beds24_property_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def list_active() -> List[dict]:
        rows = await Database.fetch(
            "SELECT * FROM beds24_connections WHERE is_active = true"
        )
        return [dict(r) for r in rows]

    @staticmethod
    async def update_last_sync(hotel_id: str, synced_at: datetime) -> None:
        await Database.execute(
            """
            UPDATE beds24_connections
            SET last_sync_at = $2, updated_at = now()
            WHERE hotel_id = $1
            """,
            hotel_id, synced_at,
        )

    @staticmethod
    async def update_tokens(
        hotel_id: str,
        api_token: str,
        refresh_token: str,
        token_expires_at: datetime,
    ) -> None:
        await Database.execute(
            """
            UPDATE beds24_connections
            SET api_token = $2, refresh_token = $3, token_expires_at = $4, updated_at = now()
            WHERE hotel_id = $1
            """,
            hotel_id, api_token, refresh_token, token_expires_at,
        )

    @staticmethod
    async def set_property_id(hotel_id: str, beds24_property_id: str) -> dict:
        row = await Database.fetchrow(
            """
            UPDATE beds24_connections
            SET beds24_property_id = $2, updated_at = now()
            WHERE hotel_id = $1
            RETURNING *
            """,
            hotel_id, beds24_property_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def deactivate(hotel_id: str) -> None:
        await Database.execute(
            """
            UPDATE beds24_connections
            SET is_active = false, updated_at = now()
            WHERE hotel_id = $1
            """,
            hotel_id,
        )


class Beds24RoomMappingRepository:

    @staticmethod
    async def create(hotel_id: str, room_type_id: str, beds24_room_id: str) -> dict:
        row = await Database.fetchrow(
            """
            INSERT INTO beds24_room_mappings (hotel_id, room_type_id, beds24_room_id)
            VALUES ($1, $2, $3)
            RETURNING *
            """,
            hotel_id, room_type_id, beds24_room_id,
        )
        return dict(row)

    @staticmethod
    async def get_by_room_type_id(room_type_id: str) -> Optional[dict]:
        row = await Database.fetchrow(
            "SELECT * FROM beds24_room_mappings WHERE room_type_id = $1",
            room_type_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def get_by_beds24_room_id(beds24_room_id: str) -> Optional[dict]:
        row = await Database.fetchrow(
            "SELECT * FROM beds24_room_mappings WHERE beds24_room_id = $1",
            beds24_room_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def list_by_hotel_id(hotel_id: str) -> List[dict]:
        rows = await Database.fetch(
            """
            SELECT m.*, rt.name AS room_type_name
            FROM beds24_room_mappings m
            JOIN room_types rt ON rt.id = m.room_type_id
            WHERE m.hotel_id = $1
            ORDER BY rt.sort_order, rt.name
            """,
            hotel_id,
        )
        return [dict(r) for r in rows]

    @staticmethod
    async def delete(mapping_id: str) -> bool:
        result = await Database.execute(
            "DELETE FROM beds24_room_mappings WHERE id = $1", mapping_id
        )
        return result == "DELETE 1"


class Beds24BookingMappingRepository:

    @staticmethod
    async def create(
        hotel_id: str,
        booking_id: str,
        beds24_booking_id: str,
        channel_source: str = "beds24",
    ) -> dict:
        row = await Database.fetchrow(
            """
            INSERT INTO beds24_booking_mappings
                (hotel_id, booking_id, beds24_booking_id, channel_source)
            VALUES ($1, $2, $3, $4)
            RETURNING *
            """,
            hotel_id, booking_id, beds24_booking_id, channel_source,
        )
        return dict(row)

    @staticmethod
    async def get_by_booking_id(booking_id: str) -> Optional[dict]:
        row = await Database.fetchrow(
            "SELECT * FROM beds24_booking_mappings WHERE booking_id = $1",
            booking_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def get_by_beds24_id(beds24_booking_id: str) -> Optional[dict]:
        row = await Database.fetchrow(
            "SELECT * FROM beds24_booking_mappings WHERE beds24_booking_id = $1",
            beds24_booking_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def update_sync_time(booking_id: str, synced_at: datetime) -> None:
        await Database.execute(
            """
            UPDATE beds24_booking_mappings
            SET last_synced_at = $2, updated_at = now()
            WHERE booking_id = $1
            """,
            booking_id, synced_at,
        )
