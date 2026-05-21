"""Outbound notifications to Channex when vayada-side state changes
(e.g. a guest cancellation must update inventory across OTAs)."""

import logging

from app.repositories.booking_repo import BookingRepository
from app.repositories.channex_mapping_repo import ChannexBookingMappingRepository
from app.services.channex.ari_push import push_availability_for_room_type

logger = logging.getLogger(__name__)


async def handle_vayada_cancellation(booking_id: str) -> None:
    """When a vayada booking is cancelled, update availability in Channex.
    Note: Channex doesn't have a cancel-booking API for OTA bookings,
    but we still need to push updated availability."""
    try:
        mapping = await ChannexBookingMappingRepository.get_by_booking_id(booking_id)
        if not mapping:
            return

        booking = await BookingRepository.get_by_id(booking_id)
        if not booking:
            return

        hotel_id = str(booking["hotel_id"])
        room_type_id = str(booking["room_type_id"])

        # Push updated availability for the affected dates
        await push_availability_for_room_type(
            hotel_id,
            room_type_id,
            start_date=booking["check_in"],
            end_date=booking["check_out"],
        )
        logger.info(
            "Pushed updated availability after cancellation of booking %s",
            booking_id,
        )
    except Exception as e:
        logger.error(
            "Failed to handle cancellation for booking %s: %s",
            booking_id,
            e,
        )
