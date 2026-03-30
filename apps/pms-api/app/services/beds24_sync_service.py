import logging
from datetime import date, timedelta, datetime, timezone
from typing import Optional

from app.repositories.room_type_repo import RoomTypeRepository
from app.repositories.booking_repo import BookingRepository
from app.database import Database
from app.repositories.beds24_mapping_repo import (
    Beds24ConnectionRepository,
    Beds24RoomMappingRepository,
    Beds24BookingMappingRepository,
)
from app.services import beds24_service

logger = logging.getLogger(__name__)

SYNC_HORIZON_DAYS = 365


async def push_availability_for_room_type(
    hotel_id: str,
    room_type_id: str,
    start_date: Optional[date] = None,
    end_date: Optional[date] = None,
) -> None:
    """Calculate and push availability + rates for a room type to Beds24."""
    mapping = await Beds24RoomMappingRepository.get_by_room_type_id(room_type_id)
    if not mapping:
        return

    room_type = await RoomTypeRepository.get_by_id(room_type_id)
    if not room_type:
        return

    if start_date is None:
        start_date = date.today()
    if end_date is None:
        end_date = start_date + timedelta(days=SYNC_HORIZON_DAYS)

    total_rooms = room_type["total_rooms"]
    calendar_data = []

    current = start_date
    while current < end_date:
        next_day = current + timedelta(days=1)

        booked = await RoomTypeRepository.count_booked(room_type_id, current, next_day)
        blocked = await RoomTypeRepository.count_blocked(room_type_id, current, next_day)
        available = max(0, total_rooms - booked - blocked)

        base_rate, _ = RoomTypeRepository.resolve_rate(room_type, current)

        calendar_data.append({
            "date": current.isoformat(),
            "available": available,
            "price": base_rate,
            "minStay": 1,
        })

        current = next_day

    try:
        await beds24_service.set_room_calendar(
            hotel_id, mapping["beds24_room_id"], calendar_data
        )
        logger.info(
            "Pushed availability for room type %s (%s dates)",
            room_type_id, len(calendar_data),
        )
    except Exception as e:
        logger.error(
            "Failed to push availability for room type %s: %s",
            room_type_id, e,
        )


async def push_availability_for_hotel(hotel_id: str) -> None:
    """Full availability sync for all mapped room types in a hotel."""
    mappings = await Beds24RoomMappingRepository.list_by_hotel_id(hotel_id)
    for mapping in mappings:
        await push_availability_for_room_type(hotel_id, str(mapping["room_type_id"]))

    await Beds24ConnectionRepository.update_last_sync(
        hotel_id, datetime.now(timezone.utc)
    )
    logger.info("Full availability sync completed for hotel %s", hotel_id)


async def push_availability_for_booking(booking_id: str) -> None:
    """Targeted sync after a booking changes — only sync affected room type dates."""
    try:
        booking = await BookingRepository.get_by_id(booking_id)
        if not booking:
            return

        hotel_id = str(booking["hotel_id"])
        room_type_id = str(booking["room_type_id"])

        conn = await Beds24ConnectionRepository.get_by_hotel_id(hotel_id)
        if not conn or not conn["is_active"]:
            return

        await push_availability_for_room_type(
            hotel_id,
            room_type_id,
            start_date=booking["check_in"],
            end_date=booking["check_out"],
        )
    except Exception as e:
        logger.error("Failed to push availability for booking %s: %s", booking_id, e)


async def process_inbound_booking(beds24_booking: dict, hotel_id: str) -> None:
    """Import a Beds24 booking into vayada. Handles deduplication and cancellations."""
    beds24_booking_id = str(beds24_booking.get("id", ""))
    if not beds24_booking_id:
        logger.warning("Beds24 booking has no ID, skipping")
        return

    # Check if we already have this booking
    existing = await Beds24BookingMappingRepository.get_by_beds24_id(beds24_booking_id)

    beds24_status = beds24_booking.get("status", "").lower()
    channel_source = beds24_booking.get("channelName", "beds24") or "beds24"

    if existing:
        # Handle cancellation of existing booking
        if beds24_status in ("cancelled", "canceled"):
            booking = await BookingRepository.get_by_id(str(existing["booking_id"]))
            if booking and booking["status"] not in ("cancelled", "expired"):
                await BookingRepository.update_status(
                    str(existing["booking_id"]), "cancelled"
                )
                logger.info(
                    "Cancelled vayada booking %s (Beds24 %s cancelled)",
                    existing["booking_id"], beds24_booking_id,
                )
        await Beds24BookingMappingRepository.update_sync_time(
            str(existing["booking_id"]), datetime.now(timezone.utc)
        )
        return

    # Skip cancelled bookings that we don't have yet
    if beds24_status in ("cancelled", "canceled"):
        return

    # Find room type mapping from Beds24 room ID
    beds24_room_id = str(beds24_booking.get("roomId", ""))
    room_mapping = await Beds24RoomMappingRepository.get_by_beds24_room_id(beds24_room_id)
    if not room_mapping:
        logger.warning(
            "No room mapping for Beds24 room %s, skipping booking %s",
            beds24_room_id, beds24_booking_id,
        )
        return

    room_type_id = str(room_mapping["room_type_id"])
    room_type = await RoomTypeRepository.get_by_id(room_type_id)
    if not room_type:
        logger.warning("Room type %s not found, skipping booking %s", room_type_id, beds24_booking_id)
        return

    # Parse dates
    check_in = date.fromisoformat(beds24_booking["arrival"])
    check_out = date.fromisoformat(beds24_booking["departure"])
    nights = (check_out - check_in).days
    if nights <= 0:
        logger.warning("Invalid dates for Beds24 booking %s", beds24_booking_id)
        return

    # Resolve rate
    base_rate, _ = RoomTypeRepository.resolve_rate(room_type, check_in)
    total_from_beds24 = beds24_booking.get("price")
    if total_from_beds24 is not None:
        total_amount = float(total_from_beds24)
        nightly_rate = round(total_amount / nights, 2)
    else:
        nightly_rate = base_rate
        total_amount = nightly_rate * nights

    guest_name = beds24_booking.get("guestName", "")
    name_parts = guest_name.split(" ", 1) if guest_name else ["", ""]
    first_name = name_parts[0] or "Guest"
    last_name = name_parts[1] if len(name_parts) > 1 else ""

    booking_data = {
        "hotel_id": hotel_id,
        "room_type_id": room_type_id,
        "guest_first_name": first_name,
        "guest_last_name": last_name,
        "guest_email": beds24_booking.get("guestEmail", ""),
        "guest_phone": beds24_booking.get("guestPhone", ""),
        "special_requests": beds24_booking.get("guestComments", ""),
        "check_in": check_in,
        "check_out": check_out,
        "adults": beds24_booking.get("numAdult", 1) or 1,
        "children": beds24_booking.get("numChild", 0) or 0,
        "nightly_rate": nightly_rate,
        "total_amount": total_amount,
        "currency": room_type["currency"],
        "channel": "beds24",
        "status": "confirmed",
        "payment_method": "pay_at_property",
        "payment_status": "pay_at_property",
    }

    # Auto-assign an available room unit
    available_room = await Database.fetchrow(
        """
        SELECT r.id FROM rooms r
        WHERE r.room_type_id = $1
          AND r.status = 'available'
          AND r.id NOT IN (
            SELECT b.room_id FROM bookings b
            WHERE b.room_id IS NOT NULL
              AND b.status IN ('pending', 'confirmed')
              AND b.check_in < $3
              AND b.check_out > $2
          )
        ORDER BY r.sort_order, r.room_number
        LIMIT 1
        """,
        room_type_id, check_in, check_out,
    )
    if available_room:
        booking_data["room_id"] = str(available_room["id"])

    booking_row = await BookingRepository.create(booking_data)
    booking_id = str(booking_row["id"])

    await Beds24BookingMappingRepository.create(
        hotel_id=hotel_id,
        booking_id=booking_id,
        beds24_booking_id=beds24_booking_id,
        channel_source=channel_source,
    )

    # Auto-create conversation for messaging
    try:
        from app.services.messaging_service import get_or_create_conversation
        await get_or_create_conversation(
            hotel_id=hotel_id,
            booking_id=booking_id,
            channel=channel_source,
            guest_name=guest_name,
            guest_email=beds24_booking.get("guestEmail", ""),
            beds24_booking_id=beds24_booking_id,
        )
    except Exception as e:
        logger.error("Failed to create conversation for booking %s: %s", booking_id, e)

    logger.info(
        "Imported Beds24 booking %s as vayada booking %s (channel: %s)",
        beds24_booking_id, booking_id, channel_source,
    )


async def poll_bookings_for_hotel(hotel_id: str) -> None:
    """Poll Beds24 for new/modified bookings for a hotel."""
    conn = await Beds24ConnectionRepository.get_by_hotel_id(hotel_id)
    if not conn or not conn["is_active"]:
        return

    modified_since = conn.get("last_sync_at")
    property_id = conn.get("beds24_property_id")

    try:
        bookings = await beds24_service.get_bookings(
            hotel_id,
            property_id=property_id,
            modified_since=modified_since,
        )
    except Exception as e:
        logger.error("Failed to poll Beds24 bookings for hotel %s: %s", hotel_id, e)
        return

    for b24_booking in bookings:
        try:
            await process_inbound_booking(b24_booking, hotel_id)
        except Exception as e:
            logger.error(
                "Failed to process Beds24 booking %s: %s",
                b24_booking.get("id"), e,
            )

    await Beds24ConnectionRepository.update_last_sync(
        hotel_id, datetime.now(timezone.utc)
    )


async def handle_vayada_cancellation(booking_id: str) -> None:
    """Propagate a vayada cancellation to Beds24 if the booking came from there."""
    try:
        mapping = await Beds24BookingMappingRepository.get_by_booking_id(booking_id)
        if not mapping:
            return

        booking = await BookingRepository.get_by_id(booking_id)
        if not booking:
            return

        hotel_id = str(booking["hotel_id"])
        await beds24_service.cancel_booking(hotel_id, mapping["beds24_booking_id"])
        logger.info(
            "Propagated cancellation to Beds24 for booking %s (Beds24 %s)",
            booking_id, mapping["beds24_booking_id"],
        )
    except Exception as e:
        logger.error(
            "Failed to propagate cancellation to Beds24 for booking %s: %s",
            booking_id, e,
        )
