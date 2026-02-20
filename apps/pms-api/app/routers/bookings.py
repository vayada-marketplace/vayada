import logging

from fastapi import APIRouter, HTTPException

from app.models.booking import BookingCreate, BookingResponse, BookingLookup
from app.services.booking_service import create_booking, lookup_booking

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/hotels", tags=["bookings"])


@router.post("/{slug}/bookings", response_model=BookingResponse)
async def post_booking(slug: str, data: BookingCreate):
    try:
        booking = await create_booking(slug, data)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("Error creating booking for %s: %s", slug, e)
        raise HTTPException(status_code=500, detail="Internal server error")
    return booking


@router.post("/{slug}/bookings/lookup", response_model=BookingResponse)
async def post_booking_lookup(slug: str, data: BookingLookup):
    try:
        booking = await lookup_booking(
            slug, data.booking_reference, data.guest_email
        )
    except Exception as e:
        logger.error("Error looking up booking: %s", e)
        raise HTTPException(status_code=500, detail="Internal server error")

    if not booking:
        raise HTTPException(status_code=404, detail="Booking not found")
    return booking
