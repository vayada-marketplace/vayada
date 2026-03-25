import logging
from datetime import datetime, timezone
from typing import Optional

from app.repositories.messaging_repo import (
    ConversationRepository,
    MessageRepository,
    MessageSyncStateRepository,
)

logger = logging.getLogger(__name__)


async def get_or_create_conversation(
    hotel_id: str,
    booking_id: str,
    channel: str,
    guest_name: str,
    guest_email: str,
    beds24_booking_id: Optional[str] = None,
) -> dict:
    return await ConversationRepository.get_or_create_for_booking(
        hotel_id=hotel_id,
        booking_id=booking_id,
        channel=channel,
        guest_name=guest_name,
        guest_email=guest_email,
        beds24_booking_id=beds24_booking_id,
    )


async def send_host_message(conversation_id: str, body: str, hotel_id: str) -> dict:
    """Host sends a reply. Routes to the appropriate channel."""
    conversation = await ConversationRepository.get_by_id(conversation_id)
    if not conversation:
        raise ValueError("Conversation not found")
    if str(conversation["hotel_id"]) != hotel_id:
        raise ValueError("Conversation not found")

    now = datetime.now(timezone.utc)
    message = await MessageRepository.create({
        "conversation_id": conversation_id,
        "sender_type": "host",
        "sender_name": "Host",
        "body": body,
        "channel": conversation["channel"],
        "is_read": True,
    })
    await ConversationRepository.update_last_message(conversation_id, now)

    # Route reply to OTA via Beds24
    beds24_booking_id = conversation.get("beds24_booking_id")
    if beds24_booking_id:
        try:
            from app.services import beds24_service
            await beds24_service.send_message(hotel_id, beds24_booking_id, body)
            logger.info("Sent reply to Beds24 for conversation %s", conversation_id)
        except Exception as e:
            logger.error("Failed to send reply to Beds24 for conversation %s: %s", conversation_id, e)

    return message


async def receive_guest_message(
    booking_id: str,
    body: str,
    guest_name: str,
    guest_email: str,
    hotel_id: str,
    channel: str = "direct",
    beds24_message_id: Optional[str] = None,
    beds24_booking_id: Optional[str] = None,
) -> dict:
    """Record an inbound guest message."""
    # Dedup if Beds24 message
    if beds24_message_id:
        exists = await MessageRepository.exists_by_beds24_id(beds24_message_id)
        if exists:
            return None

    conversation = await ConversationRepository.get_or_create_for_booking(
        hotel_id=hotel_id,
        booking_id=booking_id,
        channel=channel,
        guest_name=guest_name,
        guest_email=guest_email,
        beds24_booking_id=beds24_booking_id,
    )

    now = datetime.now(timezone.utc)
    message = await MessageRepository.create({
        "conversation_id": str(conversation["id"]),
        "sender_type": "guest",
        "sender_name": guest_name,
        "body": body,
        "channel": channel,
        "beds24_message_id": beds24_message_id,
        "is_read": False,
    })

    await ConversationRepository.increment_unread(str(conversation["id"]))
    await ConversationRepository.update_last_message(str(conversation["id"]), now)

    # Reopen if closed
    if conversation["status"] != "open":
        await ConversationRepository.update_status(str(conversation["id"]), "open")

    return message


async def mark_conversation_read(conversation_id: str) -> None:
    await MessageRepository.mark_all_read(conversation_id)
    await ConversationRepository.reset_unread(conversation_id)


async def receive_beds24_messages(hotel_id: str) -> None:
    """Poll Beds24 for new messages and store them."""
    from app.services import beds24_service
    from app.repositories.beds24_mapping_repo import Beds24BookingMappingRepository
    from app.repositories.booking_repo import BookingRepository

    sync_state = await MessageSyncStateRepository.get_or_create(hotel_id)
    modified_since = sync_state.get("last_polled_at")

    try:
        raw_messages = await beds24_service.get_messages(hotel_id, modified_since=modified_since)
    except Exception as e:
        logger.error("Failed to fetch Beds24 messages for hotel %s: %s", hotel_id, e)
        return

    for msg in raw_messages:
        beds24_booking_id = str(msg.get("bookingId", ""))
        beds24_message_id = str(msg.get("id", ""))
        msg_type = msg.get("type", "").lower()

        if not beds24_booking_id or not beds24_message_id:
            continue

        # Only process guest messages (skip host/system messages we sent)
        if msg_type not in ("guest", ""):
            continue

        # Dedup
        exists = await MessageRepository.exists_by_beds24_id(beds24_message_id)
        if exists:
            continue

        # Find the vayada booking
        mapping = await Beds24BookingMappingRepository.get_by_beds24_id(beds24_booking_id)
        if not mapping:
            logger.debug("No booking mapping for Beds24 booking %s, skipping message", beds24_booking_id)
            continue

        booking_id = str(mapping["booking_id"])
        booking = await BookingRepository.get_by_id(booking_id)
        if not booking:
            continue

        channel_source = mapping.get("channel_source", "beds24")
        guest_name = msg.get("guestName", "") or f"{booking.get('guest_first_name', '')} {booking.get('guest_last_name', '')}".strip()

        await receive_guest_message(
            booking_id=booking_id,
            body=msg.get("message", "") or msg.get("text", ""),
            guest_name=guest_name,
            guest_email=booking.get("guest_email", ""),
            hotel_id=hotel_id,
            channel=channel_source,
            beds24_message_id=beds24_message_id,
            beds24_booking_id=beds24_booking_id,
        )

    await MessageSyncStateRepository.update_last_polled(hotel_id, datetime.now(timezone.utc))
