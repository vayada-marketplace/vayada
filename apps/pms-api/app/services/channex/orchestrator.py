"""Channex sync orchestration — full-hotel and per-booking ARI dispatch."""

import logging
from datetime import UTC, datetime
from decimal import Decimal

from app.repositories.booking_repo import BookingRepository
from app.repositories.channex_mapping_repo import (
    ChannexChannelMarkupRepository,
    ChannexConnectionRepository,
    ChannexRatePlanMappingRepository,
    ChannexRoomTypeMappingRepository,
)
from app.services.channex.ari_push import (
    push_availability_for_room_type,
    push_restrictions_for_rate_plan,
)

logger = logging.getLogger(__name__)


async def push_ari_for_hotel(hotel_id: str) -> None:
    """Full availability + restrictions sync for all mapped room types in a hotel."""
    room_mappings = await ChannexRoomTypeMappingRepository.list_by_hotel_id(hotel_id)
    markup_map = await ChannexChannelMarkupRepository.get_markup_map(hotel_id)
    for mapping in room_mappings:
        room_type_id = str(mapping["room_type_id"])
        await push_availability_for_room_type(hotel_id, room_type_id)

        # Push restrictions for ALL rate plans linked to this room type
        rate_plans = await ChannexRatePlanMappingRepository.list_by_room_type_id(room_type_id)
        for rp in rate_plans:
            channel = rp.get("channel", "direct")
            await push_restrictions_for_rate_plan(
                hotel_id,
                room_type_id,
                str(rp["channex_rate_plan_id"]),
                plan_name=rp.get("plan_name", "standard"),
                channel=channel,
                markup_pct=markup_map.get(channel, Decimal(0)),
                meal_plan_code=int(rp.get("meal_plan_code") or 0),
            )

    await ChannexConnectionRepository.update_last_ari_sync(hotel_id, datetime.now(UTC))
    logger.info("Full ARI sync completed for hotel %s", hotel_id)


async def push_ari_for_booking(booking_id: str) -> None:
    """Targeted ARI sync after a booking changes — only affected room type + dates."""
    try:
        booking = await BookingRepository.get_by_id(booking_id)
        if not booking:
            return

        hotel_id = str(booking["hotel_id"])
        room_type_id = str(booking["room_type_id"])

        conn = await ChannexConnectionRepository.get_by_hotel_id(hotel_id)
        if not conn or not conn["is_active"]:
            return

        await push_availability_for_room_type(
            hotel_id,
            room_type_id,
            start_date=booking["check_in"],
            end_date=booking["check_out"],
        )
    except Exception as e:
        logger.error("Failed to push ARI for booking %s: %s", booking_id, e)
