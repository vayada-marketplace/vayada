import logging
from typing import Optional, List
from datetime import date

from fastapi import APIRouter, HTTPException, Query

from app.models.room_type import RoomTypeResponse
from app.services.room_type_service import get_rooms_for_guest

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/hotels", tags=["rooms"])


@router.get("/{slug}/rooms", response_model=List[RoomTypeResponse])
async def get_rooms(
    slug: str,
    check_in: Optional[date] = Query(None),
    check_out: Optional[date] = Query(None),
):
    try:
        rooms = await get_rooms_for_guest(slug, check_in, check_out)
    except Exception as e:
        logger.error("Error fetching rooms for %s: %s", slug, e)
        raise HTTPException(status_code=500, detail="Internal server error")
    return rooms
