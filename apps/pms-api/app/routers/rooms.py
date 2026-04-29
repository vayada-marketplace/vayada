import logging
from typing import Optional, List
from datetime import date, timedelta

from fastapi import APIRouter, HTTPException, Query

from app.models.room_type import RoomTypeResponse, UnavailableDatesResponse
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


@router.get("/{slug}/unavailable-dates", response_model=UnavailableDatesResponse)
async def get_unavailable_dates(
    slug: str,
    start: date = Query(...),
    end: date = Query(...),
):
    """Return dates where ALL room types are fully booked, plus per-arrival
    min-stay constraints across the active rooms in the requested range.

    `min_stay_by_arrival` only includes arrival dates where the smallest
    available room min-stay is greater than 1 — clients can default to 1
    for any date not present in the map.
    """
    hotel_id = await get_hotel_id_by_slug(slug)
    if not hotel_id:
        return UnavailableDatesResponse()

    rooms = await RoomTypeRepository.list_by_hotel_id(hotel_id, active_only=True)
    if not rooms:
        return UnavailableDatesResponse()

    seasons_by_room = {str(r["id"]): RoomTypeRepository._parse_seasons(r) for r in rooms}

    today = date.today()
    unavailable = []
    min_stay_by_arrival: dict[str, int] = {}
    current = start
    while current < end:
        next_day = current + timedelta(days=1)
        all_full = True
        days_until = (current - today).days
        eligible_min_stays: list[int] = []
        for room in rooms:
            total = room["total_rooms"]
            if not RoomTypeRepository.is_date_in_operating_periods(room, current):
                continue  # not operating = skip, don't count as available
            # Check minimum advance days requirement
            min_advance = room.get("minimum_advance_days") or 0
            if min_advance > 0 and days_until < min_advance:
                continue  # too soon for this room type, skip
            booked = await RoomTypeRepository.count_booked(str(room["id"]), current, next_day)
            blocked = await RoomTypeRepository.count_blocked(str(room["id"]), current, next_day)
            remaining = total - booked - blocked
            if remaining > 0:
                all_full = False
                room_min = RoomTypeRepository._find_season_min_stay(
                    seasons_by_room[str(room["id"])], current
                ) or 1
                eligible_min_stays.append(room_min)
        if all_full:
            unavailable.append(current.isoformat())
        elif eligible_min_stays:
            lowest = min(eligible_min_stays)
            if lowest > 1:
                min_stay_by_arrival[current.isoformat()] = lowest
        current = next_day

    return UnavailableDatesResponse(
        dates=unavailable,
        min_stay_by_arrival=min_stay_by_arrival,
    )
