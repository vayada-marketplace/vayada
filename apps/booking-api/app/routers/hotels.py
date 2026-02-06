import logging
from typing import List
from fastapi import APIRouter, HTTPException
from app.models.hotel import HotelResponse, RoomTypeResponse, AddonResponse
from app.services.hotel_service import (
    get_hotel_by_slug,
    get_rooms_by_hotel_slug,
    get_addons_by_hotel_slug,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/hotels", tags=["hotels"])


@router.get("/{slug}", response_model=HotelResponse)
async def get_hotel(slug: str, lang: str = "en"):
    try:
        hotel = await get_hotel_by_slug(slug, locale=lang)
    except Exception as e:
        logger.error(f"Error fetching hotel {slug}: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")

    if not hotel:
        raise HTTPException(status_code=404, detail=f"Hotel '{slug}' not found")

    return hotel


@router.get("/{slug}/rooms", response_model=List[RoomTypeResponse])
async def get_rooms(slug: str):
    try:
        rooms = await get_rooms_by_hotel_slug(slug)
    except Exception as e:
        logger.error(f"Error fetching rooms for {slug}: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")

    return rooms


@router.get("/{slug}/addons", response_model=List[AddonResponse])
async def get_addons(slug: str):
    try:
        addons = await get_addons_by_hotel_slug(slug)
    except Exception as e:
        logger.error(f"Error fetching addons for {slug}: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")

    return addons
