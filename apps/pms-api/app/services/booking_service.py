import asyncio
import logging
from datetime import date

from app.database import Database
from app.repositories.room_type_repo import RoomTypeRepository
from app.repositories.booking_repo import BookingRepository
from app.models.booking import BookingCreate, BookingResponse
from app.services.email_service import send_hotel_notification, send_guest_confirmation

logger = logging.getLogger(__name__)


def _nights(check_in: date, check_out: date) -> int:
    return (check_out - check_in).days


def _booking_to_response(booking: dict) -> BookingResponse:
    ci = booking["check_in"]
    co = booking["check_out"]
    return BookingResponse(
        id=str(booking["id"]),
        booking_reference=booking["booking_reference"],
        hotel_name=booking["hotel_name"],
        room_name=booking["room_name"],
        guest_first_name=booking["guest_first_name"],
        guest_last_name=booking["guest_last_name"],
        guest_email=booking["guest_email"],
        check_in=str(ci),
        check_out=str(co),
        nights=_nights(ci, co),
        adults=booking["adults"],
        children=booking["children"],
        nightly_rate=float(booking["nightly_rate"]),
        total_amount=float(booking["total_amount"]),
        currency=booking["currency"],
        status=booking["status"],
        created_at=booking["created_at"].isoformat(),
    )


async def create_booking(slug: str, data: BookingCreate) -> BookingResponse:
    # Resolve hotel
    hotel = await Database.fetchrow(
        "SELECT id, name, contact_email FROM hotels WHERE slug = $1", slug
    )
    if not hotel:
        raise ValueError("Hotel not found")

    hotel_id = str(hotel["id"])

    # Validate room type
    room = await RoomTypeRepository.get_by_id(data.room_type_id)
    if not room or str(room["hotel_id"]) != hotel_id:
        raise ValueError("Room type not found")
    if not room["is_active"]:
        raise ValueError("Room type is not available")

    # Check availability
    booked = await RoomTypeRepository.count_booked(
        data.room_type_id, data.check_in, data.check_out
    )
    if booked >= room["total_rooms"]:
        raise ValueError("No rooms available for the selected dates")

    # Calculate pricing
    nights = _nights(data.check_in, data.check_out)
    if nights <= 0:
        raise ValueError("Check-out must be after check-in")

    nightly_rate = float(room["base_rate"])
    total_amount = nightly_rate * nights

    # Resolve affiliate from referral code
    affiliate_id = None
    if data.referral_code:
        affiliate = await Database.fetchrow(
            "SELECT id FROM affiliates WHERE hotel_id = $1 AND referral_code = $2 AND status = 'approved'",
            hotel_id,
            data.referral_code,
        )
        if affiliate:
            affiliate_id = str(affiliate["id"])

    # Create booking
    booking_data = {
        "hotel_id": hotel_id,
        "room_type_id": data.room_type_id,
        "guest_first_name": data.guest_first_name,
        "guest_last_name": data.guest_last_name,
        "guest_email": data.guest_email,
        "guest_phone": data.guest_phone,
        "special_requests": data.special_requests,
        "check_in": data.check_in,
        "check_out": data.check_out,
        "adults": data.adults,
        "children": data.children,
        "nightly_rate": nightly_rate,
        "total_amount": total_amount,
        "currency": room["currency"],
        "referral_code": data.referral_code,
        "affiliate_id": affiliate_id,
    }
    booking_row = await BookingRepository.create(booking_data)

    # Fetch with JOINed names
    booking = await BookingRepository.get_by_id(str(booking_row["id"]))
    response = _booking_to_response(booking)

    # Fire-and-forget emails
    asyncio.create_task(
        send_hotel_notification(hotel["contact_email"], booking)
    )
    asyncio.create_task(
        send_guest_confirmation(data.guest_email, booking)
    )

    return response


async def lookup_booking(
    slug: str, booking_reference: str, guest_email: str
) -> BookingResponse | None:
    booking = await BookingRepository.lookup(booking_reference, guest_email)
    if not booking:
        return None
    # Verify it belongs to this hotel
    hotel = await Database.fetchrow(
        "SELECT id FROM hotels WHERE slug = $1", slug
    )
    if not hotel or str(booking["hotel_id"]) != str(hotel["id"]):
        return None
    return _booking_to_response(booking)
