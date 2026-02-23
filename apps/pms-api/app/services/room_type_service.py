import json
import logging
from typing import Optional, List
from datetime import date

from app.database import Database
from app.repositories.room_type_repo import RoomTypeRepository
from app.models.room_type import RoomTypeResponse

logger = logging.getLogger(__name__)


def _parse_jsonb(val):
    if isinstance(val, str):
        return json.loads(val)
    return val if val else []


async def get_hotel_id_by_slug(slug: str) -> Optional[str]:
    row = await Database.fetchrow(
        "SELECT id FROM hotels WHERE slug = $1", slug
    )
    return str(row["id"]) if row else None


async def get_rooms_for_guest(
    slug: str,
    check_in: Optional[date] = None,
    check_out: Optional[date] = None,
) -> List[RoomTypeResponse]:
    hotel_id = await get_hotel_id_by_slug(slug)
    if not hotel_id:
        return []

    rooms = await RoomTypeRepository.list_by_hotel_id(hotel_id, active_only=True)
    result = []

    for room in rooms:
        total = room["total_rooms"]
        if check_in and check_out:
            booked = await RoomTypeRepository.count_booked(
                str(room["id"]), check_in, check_out
            )
            blocked = await RoomTypeRepository.count_blocked(
                str(room["id"]), check_in, check_out
            )
            remaining = max(0, total - booked - blocked)
        else:
            remaining = total

        nr_rate = room.get("non_refundable_rate")
        result.append(
            RoomTypeResponse(
                id=str(room["id"]),
                name=room["name"],
                description=room["description"],
                short_description=room["short_description"],
                max_occupancy=room["max_occupancy"],
                size=room["size"],
                base_rate=float(room["base_rate"]),
                non_refundable_rate=float(nr_rate) if nr_rate is not None else None,
                currency=room["currency"],
                amenities=_parse_jsonb(room["amenities"]),
                images=_parse_jsonb(room["images"]),
                bed_type=room["bed_type"],
                remaining_rooms=remaining,
                features=_parse_jsonb(room["features"]),
            )
        )

    return result
