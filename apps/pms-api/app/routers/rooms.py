import logging
from typing import Optional, List
from datetime import date, timedelta

from fastapi import APIRouter, HTTPException, Query

from app.models.room_type import RoomTypeResponse
from app.services.room_type_service import get_rooms_for_guest, get_hotel_id_by_slug
from app.repositories.room_type_repo import RoomTypeRepository

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/hotels", tags=["rooms"])


@router.get("/{slug}/rooms", response_model=List[RoomTypeResponse])
async def get_rooms(
    slug: str,
    check_in: Optional[date] = Query(None),
    check_out: Optional[date] = Query(None),
    adults: Optional[int] = Query(None),
):
    try:
        rooms = await get_rooms_for_guest(slug, check_in, check_out, adults)
    except Exception as e:
        logger.error("Error fetching rooms for %s: %s", slug, e)
        raise HTTPException(status_code=500, detail="Internal server error")
    return rooms


@router.get("/{slug}/unavailable-dates")
async def get_unavailable_dates(
    slug: str,
    start: date = Query(...),
    end: date = Query(...),
):
    """Return dates where ALL room types are fully booked."""
    hotel_id = await get_hotel_id_by_slug(slug)
    if not hotel_id:
        return {"dates": []}

    rooms = await RoomTypeRepository.list_by_hotel_id(hotel_id, active_only=True)
    if not rooms:
        return {"dates": []}

    unavailable = []
    current = start
    while current < end:
        next_day = current + timedelta(days=1)
        all_full = True
        for room in rooms:
            total = room["total_rooms"]
            if not RoomTypeRepository.is_date_in_operating_periods(room, current):
                continue  # not operating = skip, don't count as available
            booked = await RoomTypeRepository.count_booked(str(room["id"]), current, next_day)
            blocked = await RoomTypeRepository.count_blocked(str(room["id"]), current, next_day)
            remaining = total - booked - blocked
            if remaining > 0:
                all_full = False
                break
        if all_full:
            unavailable.append(current.isoformat())
        current = next_day

    return {"dates": unavailable}
