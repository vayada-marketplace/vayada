"""Inbound bookings from Channex — revision feed polling, dedupe, modify,
and cancel mapping back into vayada bookings.

A Channex booking revision can describe one or more booked rooms in the
``rooms[]`` array (Booking.com lets a guest book several rooms under a
single reservation). Each entry in the array is a distinct room the guest
paid for. The PMS data model stores one ``bookings`` row per room, so a
multi-room OTA reservation produces N booking rows, all linked back to
the same Channex booking ID via ``channex_booking_mappings`` rows keyed
by ``channex_room_index``. Reading only ``rooms[0]`` would silently drop
the other rooms and create a double-booking hazard (VAY-392)."""

import asyncio
import logging
from datetime import UTC, date, datetime

from app.channels import normalize_channel
from app.config import settings as app_settings
from app.database import BookingEngineDatabase, Database
from app.repositories.booking_repo import BookingRepository
from app.repositories.channex_mapping_repo import (
    ChannexBookingMappingRepository,
    ChannexConnectionRepository,
    ChannexRoomTypeMappingRepository,
)
from app.repositories.room_type_repo import RoomTypeRepository
from app.services import channex_service
from app.services.channex.ari_push import push_availability_for_room_type
from app.services.email_service import send_host_ota_booking_imported
from app.services.room_assignment import (
    apply_moves_atomic,
    record_auto_rearrange,
    resolve_assignment,
    try_place_unassigned_after_cancellation,
)

logger = logging.getLogger(__name__)


async def _maybe_notify_ota_booking(hotel_id: str, booking_id: str, *, event: str) -> None:
    """Send the host OTA-booking notification iff the hotel opted in.

    Checks ``email_notifications`` (master) AND ``ota_booking_alerts``
    in booking_db; both must be true. Failures are logged and swallowed
    — a missing booking_db connection or notification toggle row must
    never break the inbound import pipeline.
    """
    if not app_settings.BOOKING_ENGINE_DATABASE_URL:
        return
    try:
        toggles = await BookingEngineDatabase.fetchrow(
            "SELECT email_notifications, ota_booking_alerts, contact_email "
            "FROM booking_hotels WHERE id = $1",
            hotel_id,
        )
    except Exception as exc:
        logger.warning(
            "Failed to read OTA notification toggles for hotel %s: %s",
            hotel_id,
            exc,
        )
        return
    if not toggles:
        return
    if not (toggles["email_notifications"] and toggles["ota_booking_alerts"]):
        return

    booking = await BookingRepository.get_by_id(booking_id)
    if not booking:
        return

    # Recipient comes from the PMS hotels row (kept in sync with booking_db
    # contact_email), with the booking_db value as a fallback.
    hotel_row = await Database.fetchrow("SELECT contact_email FROM hotels WHERE id = $1", hotel_id)
    hotel_email = (hotel_row["contact_email"] if hotel_row else None) or toggles["contact_email"]
    if not hotel_email:
        return

    await send_host_ota_booking_imported(hotel_email, booking, event=event)


async def _resolve_room_type(
    hotel_id: str, channex_room_type_id: str, channex_booking_id: str
) -> tuple[str, dict] | None:
    """Resolve a Channex room_type_id to (room_type_id, room_type_row).

    Returns None and logs a warning if the mapping is missing or the
    resolved room_type belongs to a different hotel (belt-and-suspenders
    against the cross-hotel import bug fixed in migration 058)."""
    if not channex_room_type_id:
        logger.warning(
            "Channex booking %s has a room with no room_type_id",
            channex_booking_id,
        )
        return None
    room_mapping = await ChannexRoomTypeMappingRepository.get_by_channex_room_type_id(
        hotel_id, str(channex_room_type_id)
    )
    if not room_mapping:
        logger.warning(
            "No room mapping for Channex room type %s, skipping booking %s",
            channex_room_type_id,
            channex_booking_id,
        )
        return None

    room_type_id = str(room_mapping["room_type_id"])
    room_type = await RoomTypeRepository.get_by_id(room_type_id)
    if not room_type:
        logger.warning("Room type %s not found, skipping", room_type_id)
        return None

    if str(room_type["hotel_id"]) != hotel_id:
        logger.error(
            "Channex room mapping %s resolves to room_type %s owned by hotel "
            "%s, but polling hotel is %s — refusing to import booking %s",
            channex_room_type_id,
            room_type_id,
            room_type["hotel_id"],
            hotel_id,
            channex_booking_id,
        )
        return None

    return room_type_id, room_type


def _split_amount(
    room: dict, attrs: dict, nights: int, room_count: int
) -> tuple[float | None, float | None]:
    """Return (nightly_rate, total_amount) for a single room slot.

    Channex sometimes puts the price on the room entry and sometimes only at
    the top level. Per-room amount wins; otherwise the top-level total is
    split evenly across rooms so the per-room rows still sum to the OTA
    total."""
    per_room_amount = room.get("amount")
    if per_room_amount:
        total_amount = float(per_room_amount)
    else:
        top_amount = attrs.get("amount")
        if not top_amount:
            return None, None
        total_amount = float(top_amount) / max(room_count, 1)
    nightly_rate = round(total_amount / nights, 2) if nights > 0 else total_amount
    return nightly_rate, total_amount


def _max_stay_warning(room_type: dict, check_in: date, check_out: date) -> str | None:
    nights = (check_out - check_in).days
    seasons = RoomTypeRepository._parse_seasons(room_type)
    max_stay = RoomTypeRepository._find_stay_max_stay(seasons, check_in, check_out)
    if max_stay and nights > max_stay:
        return (
            f"Exceeds max stay restriction: {nights} nights selected, "
            f"maximum is {max_stay} nights for the selected dates."
        )
    return None


def _append_import_warning(notes: str, warning: str | None) -> str:
    if not warning:
        return notes
    return f"{notes}\n\n{warning}" if notes else warning


async def process_inbound_booking(revision: dict, hotel_id: str) -> None:
    """Import a Channex booking revision into vayada.
    Handles deduplication, new bookings, modifications, and cancellations.

    Multi-room reservations produce one PMS booking row per entry in
    ``rooms[]``; every row is linked to the same Channex booking ID via
    a per-room-index mapping. See module docstring."""
    attrs = revision.get("attributes", revision)
    revision_id = revision.get("id", "")
    channex_booking_id = str(attrs.get("booking_id", ""))
    if not channex_booking_id:
        logger.warning("Channex revision has no booking_id, skipping")
        return

    status = (attrs.get("status", "") or "").lower()
    # Normalize aliases (``Booking.com`` / ``booking_com`` / ``BookingCom``
    # → canonical ``booking.com``) so downstream calendar/reports/filters
    # can do a single-key lookup. See ``app/channels.py``.
    ota_name = normalize_channel(attrs.get("ota_name"))

    # All mapping rows for this Channex booking — one per booked room.
    existing_mappings = await ChannexBookingMappingRepository.list_by_channex_id(
        hotel_id, channex_booking_id
    )

    if existing_mappings:
        if status == "cancelled":
            await _cancel_linked_bookings(existing_mappings, hotel_id, channex_booking_id)
        elif status == "modified":
            await _apply_booking_modification(
                existing_mappings,
                attrs,
                hotel_id,
                channex_booking_id,
                revision_id=revision_id,
                ota_name=ota_name,
            )

        synced_at = datetime.now(UTC)
        for mapping in existing_mappings:
            await ChannexBookingMappingRepository.update_sync_time(
                str(mapping["booking_id"]),
                synced_at,
                revision_id=revision_id,
            )
        return

    # Skip cancelled bookings we don't have yet
    if status == "cancelled":
        return

    rooms = attrs.get("rooms", [])
    if not rooms:
        logger.warning("Channex booking %s has no rooms, skipping", channex_booking_id)
        return

    # Top-level dates (Channex applies the booking-level stay window to every
    # room slot; per-room dates aren't part of the supported payload).
    try:
        check_in = date.fromisoformat(attrs["arrival_date"])
        check_out = date.fromisoformat(attrs["departure_date"])
    except (KeyError, TypeError, ValueError):
        logger.warning(
            "Channex booking %s missing/invalid arrival/departure date",
            channex_booking_id,
        )
        return
    nights = (check_out - check_in).days
    if nights <= 0:
        logger.warning("Invalid dates for Channex booking %s", channex_booking_id)
        return

    customer = attrs.get("customer", {}) or {}
    first_name = customer.get("name", "") or "Guest"
    last_name = customer.get("surname", "") or ""
    guest_email = customer.get("mail", "") or ""
    guest_phone = customer.get("phone", "") or ""
    top_occupancy = attrs.get("occupancy", {}) or {}

    created_booking_ids: list[str] = []
    affected_room_types: set[str] = set()

    for index, room in enumerate(rooms):
        resolved = await _resolve_room_type(
            hotel_id, room.get("room_type_id", ""), channex_booking_id
        )
        if not resolved:
            # Skip this slot but keep importing the rest — silently dropping
            # the whole booking would be worse than partial import.
            continue
        room_type_id, room_type = resolved

        nightly_rate, total_amount = _split_amount(room, attrs, nights, len(rooms))
        if nightly_rate is None:
            base_rate, _ = RoomTypeRepository.resolve_rate(room_type, check_in)
            nightly_rate = base_rate
            total_amount = nightly_rate * nights

        occupancy = room.get("occupancy", {}) or top_occupancy
        adults = occupancy.get("adults", 1) or 1
        children = occupancy.get("children", 0) or 0

        warning = _max_stay_warning(room_type, check_in, check_out)
        booking_data = {
            "hotel_id": hotel_id,
            "room_type_id": room_type_id,
            "guest_first_name": first_name,
            "guest_last_name": last_name,
            "guest_email": guest_email,
            "guest_phone": guest_phone,
            "special_requests": _append_import_warning(attrs.get("notes", "") or "", warning),
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

        # VAY-397: same auto-rearrange path direct + admin bookings use. The
        # solver sees siblings created earlier in this loop because each
        # iteration commits its booking before the next runs.
        room_id, rearrange_moves = await resolve_assignment(
            hotel_id, room_type_id, check_in, check_out
        )
        if rearrange_moves:
            await apply_moves_atomic(rearrange_moves)
        if room_id:
            booking_data["room_id"] = room_id

        booking_row = await BookingRepository.create(booking_data)
        booking_id = str(booking_row["id"])
        created_booking_ids.append(booking_id)
        affected_room_types.add(room_type_id)

        if rearrange_moves:
            await record_auto_rearrange(
                hotel_id=hotel_id,
                moves=rearrange_moves,
                triggered_by_booking_id=booking_id,
                triggered_by_guest_name=(f"{first_name} {last_name}".strip() or "guest"),
            )

        await ChannexBookingMappingRepository.create(
            hotel_id=hotel_id,
            booking_id=booking_id,
            channex_booking_id=channex_booking_id,
            channel_source=ota_name,
            channex_revision_id=revision_id,
            channex_room_index=index,
        )

    if not created_booking_ids:
        logger.warning(
            "Channex booking %s: no rooms could be imported (all room types unmapped)",
            channex_booking_id,
        )
        return

    logger.info(
        "Imported Channex booking %s as %d vayada booking(s) (channel: %s)",
        channex_booking_id,
        len(created_booking_ids),
        ota_name,
    )

    # Push updated availability for every distinct room type touched.
    for rt_id in affected_room_types:
        asyncio.create_task(
            push_availability_for_room_type(
                hotel_id,
                rt_id,
                start_date=check_in,
                end_date=check_out,
            )
        )

    # One notification per OTA reservation, not one per room — the host
    # cares about the booking, not the individual rows we created for it.
    asyncio.create_task(
        _maybe_notify_ota_booking(
            hotel_id,
            created_booking_ids[0],
            event="imported",
        )
    )


async def _cancel_linked_bookings(
    mappings: list[dict], hotel_id: str, channex_booking_id: str
) -> None:
    """Cancel every PMS booking linked to a Channex booking ID."""
    notified = False
    for mapping in mappings:
        booking_id = str(mapping["booking_id"])
        booking = await BookingRepository.get_by_id(booking_id)
        if not booking or booking["status"] in ("cancelled", "expired"):
            continue
        await BookingRepository.update_status(booking_id, "cancelled")
        logger.info(
            "Cancelled vayada booking %s (Channex %s cancelled)",
            booking_id,
            channex_booking_id,
        )
        asyncio.create_task(
            push_availability_for_room_type(
                hotel_id,
                str(booking["room_type_id"]),
                start_date=booking["check_in"],
                end_date=booking["check_out"],
            )
        )
        # VAY-397: OTA cancellations are the biggest source of overnight
        # freed slots — sweep for any unassigned booking that can take them.
        if booking.get("room_id"):
            asyncio.create_task(
                try_place_unassigned_after_cancellation(
                    hotel_id,
                    str(booking["room_type_id"]),
                    booking["check_in"],
                    booking["check_out"],
                )
            )
        if not notified:
            asyncio.create_task(
                _maybe_notify_ota_booking(
                    hotel_id,
                    booking_id,
                    event="cancelled",
                )
            )
            notified = True


async def _apply_booking_modification(
    mappings: list[dict],
    attrs: dict,
    hotel_id: str,
    channex_booking_id: str,
    *,
    revision_id: str,
    ota_name: str,
) -> None:
    """Apply a Channex modification to every room slot of a multi-room booking.

    * Equal room count → update each existing booking with the modified data.
    * Fewer rooms in the revision (guest reduced) → cancel the trailing
      bookings whose slot index no longer exists.
    * More rooms (guest added) → create new bookings for the new slots.
    """
    rooms = attrs.get("rooms", [])
    arrival = attrs.get("arrival_date")
    departure = attrs.get("departure_date")
    new_check_in = date.fromisoformat(arrival) if arrival else None
    new_check_out = date.fromisoformat(departure) if departure else None

    customer = attrs.get("customer", {}) or {}
    notes = attrs.get("notes")
    top_occupancy = attrs.get("occupancy", {}) or {}

    existing_by_index = {int(m["channex_room_index"]): m for m in mappings}
    seen_indices: set[int] = set()
    notified = False

    for index, room in enumerate(rooms):
        seen_indices.add(index)
        mapping = existing_by_index.get(index)
        if mapping is None:
            # Guest added a new room on the OTA side. Best-effort: create a
            # fresh booking for this slot by re-running the import path with
            # a single-room synthetic revision.
            synthetic = {
                "id": revision_id,
                "attributes": {
                    **attrs,
                    "status": "new",
                    "rooms": [room],
                },
            }
            # Stamp the slot index by post-processing the mapping row after
            # process_inbound_booking creates it at index 0.
            await _import_extra_slot(synthetic, hotel_id, channex_booking_id, index)
            continue

        booking_id = str(mapping["booking_id"])
        booking = await BookingRepository.get_by_id(booking_id)
        if not booking:
            continue

        updates: dict = {}
        if new_check_in:
            updates["check_in"] = new_check_in
        if new_check_out:
            updates["check_out"] = new_check_out

        room_count = max(len(rooms), 1)
        check_in_eff = updates.get("check_in", booking["check_in"])
        check_out_eff = updates.get("check_out", booking["check_out"])
        nights = (check_out_eff - check_in_eff).days
        nightly_rate, total_amount = _split_amount(room, attrs, nights, room_count)
        if total_amount is not None:
            updates["total_amount"] = total_amount
            updates["nightly_rate"] = nightly_rate

        if customer.get("name"):
            updates["guest_first_name"] = customer["name"]
        if customer.get("surname"):
            updates["guest_last_name"] = customer["surname"]
        if customer.get("mail"):
            updates["guest_email"] = customer["mail"]
        if customer.get("phone"):
            updates["guest_phone"] = customer["phone"]

        occupancy = room.get("occupancy", {}) or top_occupancy
        if occupancy.get("adults"):
            updates["adults"] = occupancy["adults"]
        if occupancy.get("children") is not None:
            updates["children"] = occupancy["children"]

        if notes is not None:
            updates["special_requests"] = notes

        if updates:
            await _apply_updates(booking_id, updates)
            logger.info(
                "Updated vayada booking %s (Channex %s modified, slot %d)",
                booking_id,
                channex_booking_id,
                index,
            )

        if not notified:
            asyncio.create_task(
                _maybe_notify_ota_booking(
                    hotel_id,
                    booking_id,
                    event="modified",
                )
            )
            notified = True

    # Guest reduced the room count — cancel the leftover slots.
    for index, mapping in existing_by_index.items():
        if index in seen_indices:
            continue
        booking_id = str(mapping["booking_id"])
        booking = await BookingRepository.get_by_id(booking_id)
        if not booking or booking["status"] in ("cancelled", "expired"):
            continue
        await BookingRepository.update_status(booking_id, "cancelled")
        logger.info(
            "Cancelled vayada booking %s (Channex %s modified, slot %d removed)",
            booking_id,
            channex_booking_id,
            index,
        )
        asyncio.create_task(
            push_availability_for_room_type(
                hotel_id,
                str(booking["room_type_id"]),
                start_date=booking["check_in"],
                end_date=booking["check_out"],
            )
        )


async def _apply_updates(booking_id: str, updates: dict) -> None:
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


async def _import_extra_slot(
    synthetic_revision: dict,
    hotel_id: str,
    channex_booking_id: str,
    target_index: int,
) -> None:
    """Import an added room slot from a modification and rewrite its mapping
    row to the correct ``channex_room_index``.

    The shared import path always writes index 0 (it sees a single-room
    revision); we overwrite the index afterwards so the slot identity
    survives future modifications/cancellations."""
    # Temporarily delete the placeholder mapping rows we might still have at
    # index 0 — there shouldn't be any (we only call this for added slots),
    # but assert defensively. We then run the import which creates an
    # index=0 mapping; immediately update it to the real index.
    before = await ChannexBookingMappingRepository.list_by_channex_id(hotel_id, channex_booking_id)
    before_ids = {str(m["booking_id"]) for m in before}

    await process_inbound_booking(synthetic_revision, hotel_id)

    after = await ChannexBookingMappingRepository.list_by_channex_id(hotel_id, channex_booking_id)
    for mapping in after:
        booking_id = str(mapping["booking_id"])
        if booking_id in before_ids:
            continue
        # New mapping just created at index 0 — bump it to the real slot.
        await Database.execute(
            "UPDATE channex_booking_mappings SET channex_room_index = $2 WHERE booking_id = $1",
            booking_id,
            target_index,
        )


async def poll_bookings_for_hotel(hotel_id: str) -> None:
    """Poll Channex booking revision feed for a hotel and process new revisions."""
    conn = await ChannexConnectionRepository.get_by_hotel_id(hotel_id)
    if not conn or not conn["is_active"]:
        return

    # Refuse to poll without a property_id — otherwise the Channex feed returns
    # revisions for every property in the shared account and we would steal
    # other hotels' bookings.
    if not conn.get("channex_property_id"):
        logger.warning(
            "Skipping Channex poll for hotel %s: no channex_property_id set",
            hotel_id,
        )
        return

    api_key = channex_service.get_platform_api_key()
    property_id = str(conn["channex_property_id"])

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
                revision_id,
                e,
            )

    await ChannexConnectionRepository.update_last_booking_sync(hotel_id, datetime.now(UTC))
