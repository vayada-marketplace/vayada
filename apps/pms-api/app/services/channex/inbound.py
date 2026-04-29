"""Inbound bookings from Channex — revision feed polling, dedupe, modify,
and cancel mapping back into vayada bookings."""
import asyncio
import logging
from datetime import date, datetime, timezone

from app.database import Database
from app.repositories.room_type_repo import RoomTypeRepository
from app.repositories.booking_repo import BookingRepository
from app.repositories.channex_mapping_repo import (
    ChannexBookingMappingRepository,
    ChannexConnectionRepository,
    ChannexRoomTypeMappingRepository,
)
from app.services import channex_service

from app.services.channex.ari_push import push_availability_for_room_type

logger = logging.getLogger(__name__)


async def process_inbound_booking(revision: dict, hotel_id: str) -> None:
    """Import a Channex booking revision into vayada.
    Handles deduplication, new bookings, modifications, and cancellations."""
    attrs = revision.get("attributes", revision)
    revision_id = revision.get("id", "")
    channex_booking_id = str(attrs.get("booking_id", ""))
    if not channex_booking_id:
        logger.warning("Channex revision has no booking_id, skipping")
        return

    status = (attrs.get("status", "") or "").lower()
    ota_name = (attrs.get("ota_name", "") or "channex").lower()

    # Check if we already have this booking
    existing = await ChannexBookingMappingRepository.get_by_channex_id(channex_booking_id)

    if existing:
        existing_booking_id = str(existing["booking_id"])

        if status == "cancelled":
            booking = await BookingRepository.get_by_id(existing_booking_id)
            if booking and booking["status"] not in ("cancelled", "expired"):
                await BookingRepository.update_status(existing_booking_id, "cancelled")
                logger.info(
                    "Cancelled vayada booking %s (Channex %s cancelled)",
                    existing_booking_id, channex_booking_id,
                )
                # Push updated availability back to Channex
                asyncio.create_task(push_availability_for_room_type(
                    hotel_id, str(booking["room_type_id"]),
                    start_date=booking["check_in"],
                    end_date=booking["check_out"],
                ))
        elif status == "modified":
            # Update existing booking with new details from OTA
            await _apply_booking_modification(existing_booking_id, attrs, hotel_id)
            logger.info(
                "Updated vayada booking %s (Channex %s modified)",
                existing_booking_id, channex_booking_id,
            )

        await ChannexBookingMappingRepository.update_sync_time(
            existing_booking_id,
            datetime.now(timezone.utc),
            revision_id=revision_id,
        )
        return

    # Skip cancelled bookings we don't have yet
    if status == "cancelled":
        return

    # Find room type from Channex room mapping
    rooms = attrs.get("rooms", [])
    if not rooms:
        logger.warning("Channex booking %s has no rooms, skipping", channex_booking_id)
        return

    first_room = rooms[0]
    channex_room_type_id = first_room.get("room_type_id", "")
    room_mapping = await ChannexRoomTypeMappingRepository.get_by_channex_room_type_id(
        str(channex_room_type_id)
    )
    if not room_mapping:
        logger.warning(
            "No room mapping for Channex room type %s, skipping booking %s",
            channex_room_type_id, channex_booking_id,
        )
        return

    room_type_id = str(room_mapping["room_type_id"])
    room_type = await RoomTypeRepository.get_by_id(room_type_id)
    if not room_type:
        logger.warning("Room type %s not found, skipping", room_type_id)
        return

    # Parse dates
    check_in = date.fromisoformat(attrs["arrival_date"])
    check_out = date.fromisoformat(attrs["departure_date"])
    nights = (check_out - check_in).days
    if nights <= 0:
        logger.warning("Invalid dates for Channex booking %s", channex_booking_id)
        return

    # Resolve rate — use Channex amount if available, else local rate
    total_amount_str = first_room.get("amount") or attrs.get("amount")
    if total_amount_str:
        total_amount = float(total_amount_str)
        nightly_rate = round(total_amount / nights, 2) if nights > 0 else total_amount
    else:
        base_rate, _ = RoomTypeRepository.resolve_rate(room_type, check_in)
        nightly_rate = base_rate
        total_amount = nightly_rate * nights

    # Guest info
    customer = attrs.get("customer", {}) or {}
    first_name = customer.get("name", "") or ""
    last_name = customer.get("surname", "") or ""
    if not first_name:
        first_name = "Guest"
    guest_email = customer.get("mail", "") or ""
    guest_phone = customer.get("phone", "") or ""

    # Occupancy
    occupancy = first_room.get("occupancy", {}) or attrs.get("occupancy", {}) or {}
    adults = occupancy.get("adults", 1) or 1
    children = occupancy.get("children", 0) or 0

    booking_data = {
        "hotel_id": hotel_id,
        "room_type_id": room_type_id,
        "guest_first_name": first_name,
        "guest_last_name": last_name,
        "guest_email": guest_email,
        "guest_phone": guest_phone,
        "special_requests": attrs.get("notes", "") or "",
        "check_in": check_in,
        "check_out": check_out,
        "adults": adults,
        "children": children,
        "nightly_rate": nightly_rate,
        "total_amount": total_amount,
        "currency": room_type["currency"],
        "channel": ota_name,
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
        ORDER BY r.sort_order,
                 (COALESCE(NULLIF(regexp_replace(r.room_number, '[^0-9].*', '', 'g'), ''), '0'))::int,
                 r.room_number
        LIMIT 1
        """,
        room_type_id, check_in, check_out,
    )
    if available_room:
        booking_data["room_id"] = str(available_room["id"])

    booking_row = await BookingRepository.create(booking_data)
    booking_id = str(booking_row["id"])

    await ChannexBookingMappingRepository.create(
        hotel_id=hotel_id,
        booking_id=booking_id,
        channex_booking_id=channex_booking_id,
        channel_source=ota_name,
        channex_revision_id=revision_id,
    )

    logger.info(
        "Imported Channex booking %s as vayada booking %s (channel: %s)",
        channex_booking_id, booking_id, ota_name,
    )

    # Push updated availability back to Channex so other OTAs see the reduced inventory
    asyncio.create_task(push_availability_for_room_type(
        hotel_id, room_type_id,
        start_date=check_in,
        end_date=check_out,
    ))


async def _apply_booking_modification(
    booking_id: str, attrs: dict, hotel_id: str
) -> None:
    """Update an existing booking with modified data from a Channex revision."""
    rooms = attrs.get("rooms", [])
    first_room = rooms[0] if rooms else {}

    updates = {}

    # Dates
    if attrs.get("arrival_date"):
        updates["check_in"] = date.fromisoformat(attrs["arrival_date"])
    if attrs.get("departure_date"):
        updates["check_out"] = date.fromisoformat(attrs["departure_date"])

    # Amount
    total_amount_str = first_room.get("amount") or attrs.get("amount")
    if total_amount_str and updates.get("check_in") and updates.get("check_out"):
        total_amount = float(total_amount_str)
        nights = (updates["check_out"] - updates["check_in"]).days
        if nights > 0:
            updates["total_amount"] = total_amount
            updates["nightly_rate"] = round(total_amount / nights, 2)

    # Guest info
    customer = attrs.get("customer", {}) or {}
    if customer.get("name"):
        updates["guest_first_name"] = customer["name"]
    if customer.get("surname"):
        updates["guest_last_name"] = customer["surname"]
    if customer.get("mail"):
        updates["guest_email"] = customer["mail"]
    if customer.get("phone"):
        updates["guest_phone"] = customer["phone"]

    # Occupancy
    occupancy = first_room.get("occupancy", {}) or attrs.get("occupancy", {}) or {}
    if occupancy.get("adults"):
        updates["adults"] = occupancy["adults"]
    if occupancy.get("children") is not None:
        updates["children"] = occupancy["children"]

    # Notes
    if attrs.get("notes") is not None:
        updates["special_requests"] = attrs["notes"]

    if updates:
        set_clauses = []
        values = []
        idx = 1
        for col, val in updates.items():
            set_clauses.append(f"{col} = ${idx}")
            values.append(val)
            idx += 1
        values.append(booking_id)
        await Database.execute(
            f"UPDATE bookings SET {', '.join(set_clauses)}, updated_at = now() WHERE id = ${idx}",
            *values,
        )


async def poll_bookings_for_hotel(hotel_id: str) -> None:
    """Poll Channex booking revision feed for a hotel and process new revisions."""
    conn = await ChannexConnectionRepository.get_by_hotel_id(hotel_id)
    if not conn or not conn["is_active"]:
        return

    api_key = channex_service.get_platform_api_key()
    property_id = str(conn["channex_property_id"]) if conn.get("channex_property_id") else None

    try:
        revisions = await channex_service.get_booking_revisions_feed(
            api_key, property_id=property_id
        )
    except Exception as e:
        logger.error("Failed to poll Channex bookings for hotel %s: %s", hotel_id, e)
        return

    for revision in revisions:
        revision_id = revision.get("id", "")
        try:
            await process_inbound_booking(revision, hotel_id)
            # Acknowledge the revision so it doesn't reappear
            if revision_id:
                await channex_service.acknowledge_booking_revision(api_key, revision_id)
        except Exception as e:
            logger.error(
                "Failed to process Channex revision %s: %s",
                revision_id, e,
            )

    await ChannexConnectionRepository.update_last_booking_sync(
        hotel_id, datetime.now(timezone.utc)
    )
