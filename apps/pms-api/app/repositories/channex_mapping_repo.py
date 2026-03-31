from typing import Optional, List
from datetime import datetime

from app.database import Database


class ChannexConnectionRepository:

    @staticmethod
    async def upsert(hotel_id: str, api_key: str) -> dict:
        existing = await ChannexConnectionRepository.get_by_hotel_id(hotel_id)
        if existing:
            row = await Database.fetchrow(
                """
                UPDATE channex_connections
                SET api_key = $2, is_active = true, updated_at = now()
                WHERE hotel_id = $1
                RETURNING *
                """,
                hotel_id, api_key,
            )
        else:
            row = await Database.fetchrow(
                """
                INSERT INTO channex_connections (hotel_id, api_key)
                VALUES ($1, $2)
                RETURNING *
                """,
                hotel_id, api_key,
            )
        return dict(row)

    @staticmethod
    async def get_by_hotel_id(hotel_id: str) -> Optional[dict]:
        row = await Database.fetchrow(
            "SELECT * FROM channex_connections WHERE hotel_id = $1",
            hotel_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def get_by_property_id(channex_property_id: str) -> Optional[dict]:
        row = await Database.fetchrow(
            "SELECT * FROM channex_connections WHERE channex_property_id = $1",
            channex_property_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def list_active() -> List[dict]:
        rows = await Database.fetch(
            "SELECT * FROM channex_connections WHERE is_active = true"
        )
        return [dict(r) for r in rows]

    @staticmethod
    async def set_property_id(hotel_id: str, channex_property_id: str) -> dict:
        row = await Database.fetchrow(
            """
            UPDATE channex_connections
            SET channex_property_id = $2, updated_at = now()
            WHERE hotel_id = $1
            RETURNING *
            """,
            hotel_id, channex_property_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def update_last_booking_sync(hotel_id: str, synced_at: datetime) -> None:
        await Database.execute(
            """
            UPDATE channex_connections
            SET last_booking_sync_at = $2, updated_at = now()
            WHERE hotel_id = $1
            """,
            hotel_id, synced_at,
        )

    @staticmethod
    async def update_last_ari_sync(hotel_id: str, synced_at: datetime) -> None:
        await Database.execute(
            """
            UPDATE channex_connections
            SET last_ari_sync_at = $2, updated_at = now()
            WHERE hotel_id = $1
            """,
            hotel_id, synced_at,
        )

    @staticmethod
    async def deactivate(hotel_id: str) -> None:
        await Database.execute(
            """
            UPDATE channex_connections
            SET is_active = false, updated_at = now()
            WHERE hotel_id = $1
            """,
            hotel_id,
        )


class ChannexRoomTypeMappingRepository:

    @staticmethod
    async def create(
        hotel_id: str, room_type_id: str, channex_room_type_id: str
    ) -> dict:
        row = await Database.fetchrow(
            """
            INSERT INTO channex_room_type_mappings
                (hotel_id, room_type_id, channex_room_type_id)
            VALUES ($1, $2, $3)
            RETURNING *
            """,
            hotel_id, room_type_id, channex_room_type_id,
        )
        return dict(row)

    @staticmethod
    async def get_by_room_type_id(room_type_id: str) -> Optional[dict]:
        row = await Database.fetchrow(
            "SELECT * FROM channex_room_type_mappings WHERE room_type_id = $1",
            room_type_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def get_by_channex_room_type_id(channex_room_type_id: str) -> Optional[dict]:
        row = await Database.fetchrow(
            "SELECT * FROM channex_room_type_mappings WHERE channex_room_type_id = $1",
            channex_room_type_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def list_by_hotel_id(hotel_id: str) -> List[dict]:
        rows = await Database.fetch(
            """
            SELECT m.*, rt.name AS room_type_name
            FROM channex_room_type_mappings m
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
            "DELETE FROM channex_room_type_mappings WHERE id = $1", mapping_id
        )
        return result == "DELETE 1"

    @staticmethod
    async def delete_by_room_type_id(room_type_id: str) -> bool:
        result = await Database.execute(
            "DELETE FROM channex_room_type_mappings WHERE room_type_id = $1",
            room_type_id,
        )
        return result == "DELETE 1"


class ChannexRatePlanMappingRepository:

    @staticmethod
    async def create(
        hotel_id: str,
        room_type_id: str,
        channex_rate_plan_id: str,
        channex_room_type_id: str,
        sell_mode: str = "per_room",
        plan_name: str = "standard",
    ) -> dict:
        row = await Database.fetchrow(
            """
            INSERT INTO channex_rate_plan_mappings
                (hotel_id, room_type_id, channex_rate_plan_id,
                 channex_room_type_id, sell_mode, plan_name)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
            """,
            hotel_id, room_type_id, channex_rate_plan_id,
            channex_room_type_id, sell_mode, plan_name,
        )
        return dict(row)

    @staticmethod
    async def get_by_room_type_id(room_type_id: str) -> Optional[dict]:
        """Get the first (primary) rate plan mapping for a room type."""
        row = await Database.fetchrow(
            "SELECT * FROM channex_rate_plan_mappings WHERE room_type_id = $1 LIMIT 1",
            room_type_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def list_by_room_type_id(room_type_id: str) -> List[dict]:
        """Get ALL rate plan mappings for a room type."""
        rows = await Database.fetch(
            "SELECT * FROM channex_rate_plan_mappings WHERE room_type_id = $1",
            room_type_id,
        )
        return [dict(r) for r in rows]

    @staticmethod
    async def get_by_channex_rate_plan_id(channex_rate_plan_id: str) -> Optional[dict]:
        row = await Database.fetchrow(
            "SELECT * FROM channex_rate_plan_mappings WHERE channex_rate_plan_id = $1",
            channex_rate_plan_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def list_by_hotel_id(hotel_id: str) -> List[dict]:
        rows = await Database.fetch(
            """
            SELECT m.*, rt.name AS room_type_name
            FROM channex_rate_plan_mappings m
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
            "DELETE FROM channex_rate_plan_mappings WHERE id = $1", mapping_id
        )
        return result == "DELETE 1"

    @staticmethod
    async def delete_by_room_type_id(room_type_id: str) -> bool:
        result = await Database.execute(
            "DELETE FROM channex_rate_plan_mappings WHERE room_type_id = $1",
            room_type_id,
        )
        return result == "DELETE 1"


class ChannexBookingMappingRepository:

    @staticmethod
    async def create(
        hotel_id: str,
        booking_id: str,
        channex_booking_id: str,
        channel_source: str = "channex",
        channex_revision_id: str = None,
    ) -> dict:
        row = await Database.fetchrow(
            """
            INSERT INTO channex_booking_mappings
                (hotel_id, booking_id, channex_booking_id,
                 channel_source, channex_revision_id)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *
            """,
            hotel_id, booking_id, channex_booking_id,
            channel_source, channex_revision_id,
        )
        return dict(row)

    @staticmethod
    async def get_by_booking_id(booking_id: str) -> Optional[dict]:
        row = await Database.fetchrow(
            "SELECT * FROM channex_booking_mappings WHERE booking_id = $1",
            booking_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def get_by_channex_id(channex_booking_id: str) -> Optional[dict]:
        row = await Database.fetchrow(
            "SELECT * FROM channex_booking_mappings WHERE channex_booking_id = $1",
            channex_booking_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def update_sync_time(
        booking_id: str, synced_at: datetime, revision_id: str = None
    ) -> None:
        if revision_id:
            await Database.execute(
                """
                UPDATE channex_booking_mappings
                SET last_synced_at = $2, channex_revision_id = $3, updated_at = now()
                WHERE booking_id = $1
                """,
                booking_id, synced_at, revision_id,
            )
        else:
            await Database.execute(
                """
                UPDATE channex_booking_mappings
                SET last_synced_at = $2, updated_at = now()
                WHERE booking_id = $1
                """,
                booking_id, synced_at,
            )
