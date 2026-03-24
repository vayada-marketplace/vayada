import logging
from typing import Optional, List
from datetime import date

from app.database import Database
from app.repositories.room_type_repo import RoomTypeRepository
from app.models.room_type import RoomTypeResponse
from app.utils import parse_jsonb

logger = logging.getLogger(__name__)


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

        if check_in:
            base_rate, nr_rate = RoomTypeRepository.resolve_rate(room, check_in)
        else:
            base_rate = float(room["base_rate"])
            nr = room.get("non_refundable_rate")
            nr_rate = float(nr) if nr is not None else None
            # If base_rate is 0, try to use the lowest season rate for display
            if base_rate == 0:
                seasons = RoomTypeRepository._parse_seasons(room)
                season_rate = RoomTypeRepository._get_lowest_season_rate(seasons)
                if season_rate is not None:
                    base_rate = season_rate

        # If no explicit NR rate, calculate from discount percentage
        if nr_rate is None and base_rate > 0:
            discount_pct = room.get("non_refundable_discount")
            if discount_pct is not None and discount_pct > 0:
                nr_rate = round(base_rate * (1 - discount_pct / 100), 2)

        result.append(
            RoomTypeResponse(
                id=str(room["id"]),
                name=room["name"],
                category=room.get("category", ""),
                description=room["description"],
                short_description=room["short_description"],
                max_occupancy=room["max_occupancy"],
                size=room["size"],
                base_rate=base_rate,
                non_refundable_rate=nr_rate,
                currency=room["currency"],
                amenities=parse_jsonb(room["amenities"]),
                images=parse_jsonb(room["images"]),
                bed_type=room["bed_type"],
                remaining_rooms=remaining,
                features=parse_jsonb(room["features"]),
                benefits=parse_jsonb(room.get("benefits", [])),
            )
        )

    return result
