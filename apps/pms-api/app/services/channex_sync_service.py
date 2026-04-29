import logging
from datetime import date, timedelta, datetime, timezone
from decimal import Decimal
from typing import Optional, List

from app.repositories.room_type_repo import RoomTypeRepository
from app.repositories.booking_repo import BookingRepository
from app.database import Database, BookingEngineDatabase
from app.config import settings as app_settings
from app.repositories.channex_mapping_repo import (
    ChannexConnectionRepository,
    ChannexRoomTypeMappingRepository,
    ChannexRatePlanMappingRepository,
    ChannexBookingMappingRepository,
    ChannexChannelMarkupRepository,
)
from app.services import channex_service
from app.services.hotel_identity_service import get_currency as get_be_currency

logger = logging.getLogger(__name__)

SYNC_HORIZON_DAYS = 365

# Channel labels used in Channex rate plan titles and plan combinations.
# Airbnb only accepts one rate plan per listing, so we skip non_refundable there.
_CHANNEL_LABELS = {
    "direct": "",
    "booking_com": "BDC",
    "airbnb": "Airbnb",
}
_CHANNELS_WITH_NON_REFUNDABLE = {"direct", "booking_com"}


# ── Provisioning ─────────────────────────────────────────────────────

async def provision_property(hotel_id: str) -> dict:
    """Create property + room types + rate plans in Channex for a hotel.
    Returns summary of what was created."""
    conn = await ChannexConnectionRepository.get_by_hotel_id(hotel_id)
    if not conn or not conn["is_active"]:
        raise ValueError("No active Channex connection")

    api_key = channex_service.get_platform_api_key()

    # Get hotel info
    hotel = await Database.fetchrow("SELECT * FROM hotels WHERE id = $1", hotel_id)
    if not hotel:
        raise ValueError("Hotel not found")

    # Currency is owned by booking_db.booking_hotels (see
    # memory/project_hotel_data_ownership.md).
    currency = await get_be_currency(hotel_id)

    # Step 1: Create property in Channex (or skip if already exists)
    if conn.get("channex_property_id"):
        channex_property_id = str(conn["channex_property_id"])
        logger.info("Property already provisioned in Channex: %s", channex_property_id)
    else:
        prop = await channex_service.create_property(
            api_key,
            title=hotel["name"],
            currency=currency,
            property_type=hotel.get("property_type") or "guest_house",
            country=hotel.get("country") or None,
            state=hotel.get("state") or None,
            city=hotel.get("city") or None,
            address=hotel.get("address") or None,
            zip_code=hotel.get("zip_code") or None,
            latitude=float(hotel["latitude"]) if hotel.get("latitude") is not None else None,
            longitude=float(hotel["longitude"]) if hotel.get("longitude") is not None else None,
            timezone=hotel.get("timezone") or None,
            email=hotel.get("contact_email") or None,
            phone=hotel.get("phone") or None,
        )
        channex_property_id = prop["id"]
        await ChannexConnectionRepository.set_property_id(hotel_id, channex_property_id)
        logger.info("Created Channex property %s for hotel %s", channex_property_id, hotel_id)

    # Step 2: Create room types + rate plans for each vayada room type
    room_types = await Database.fetch(
        """
        SELECT * FROM room_types
        WHERE hotel_id = $1 AND is_active = true
        ORDER BY sort_order, name
        """,
        hotel_id,
    )

    rooms_created = 0
    rates_created = 0

    for rt in room_types:
        room_type_id = str(rt["id"])

        # Check if already mapped
        existing_room = await ChannexRoomTypeMappingRepository.get_by_room_type_id(room_type_id)
        if existing_room:
            channex_room_type_id = str(existing_room["channex_room_type_id"])
        else:
            # Create room type in Channex
            channex_rt = await channex_service.create_room_type(
                api_key,
                property_id=channex_property_id,
                title=rt["name"],
                count_of_rooms=rt["total_rooms"],
                occ_adults=rt["max_occupancy"],
                occ_children=0,
                occ_infants=0,
                default_occupancy=min(2, rt["max_occupancy"]),
            )
            channex_room_type_id = channex_rt["id"]
            await ChannexRoomTypeMappingRepository.create(
                hotel_id, room_type_id, channex_room_type_id
            )
            rooms_created += 1
            logger.info(
                "Created Channex room type %s for %s (%s)",
                channex_room_type_id, rt["name"], room_type_id,
            )

        # Create rate plans — one per (channel, plan_name) combination:
        #   direct        → standard (+ non_refundable if enabled)
        #   booking_com   → standard (+ non_refundable if enabled)
        #   airbnb        → standard only (Airbnb API allows one rate plan per listing)
        existing_rates = await ChannexRatePlanMappingRepository.list_by_room_type_id(room_type_id)
        existing_combos = {
            (r.get("channel", "direct"), r.get("plan_name", "standard"))
            for r in existing_rates
        }
        default_occ = min(2, rt["max_occupancy"])

        plans_to_create = []
        for channel, label in _CHANNEL_LABELS.items():
            prefix = f"{label} " if label else ""
            plans_to_create.append((channel, "standard", f"{rt['name']} - {prefix}Standard"))
            if rt.get("non_refundable_enabled") and channel in _CHANNELS_WITH_NON_REFUNDABLE:
                plans_to_create.append((channel, "non_refundable", f"{rt['name']} - {prefix}Non-Refundable"))

        for channel, plan_name, plan_title in plans_to_create:
            if (channel, plan_name) in existing_combos:
                continue
            channex_rp = await channex_service.create_rate_plan(
                api_key,
                property_id=channex_property_id,
                room_type_id=channex_room_type_id,
                title=plan_title,
                sell_mode="per_room",
                currency=rt["currency"],
                options=[{"occupancy": default_occ, "is_primary": True}],
            )
            await ChannexRatePlanMappingRepository.create(
                hotel_id=hotel_id,
                room_type_id=room_type_id,
                channex_rate_plan_id=channex_rp["id"],
                channex_room_type_id=channex_room_type_id,
                sell_mode="per_room",
                plan_name=plan_name,
                channel=channel,
            )
            rates_created += 1
            logger.info(
                "Created Channex rate plan %s (%s/%s) for %s",
                channex_rp["id"], channel, plan_name, rt["name"],
            )

    return {
        "channex_property_id": channex_property_id,
        "rooms_created": rooms_created,
        "rates_created": rates_created,
    }


# ── ARI Push: Availability ───────────────────────────────────────────

async def push_availability_for_room_type(
    hotel_id: str,
    room_type_id: str,
    start_date: Optional[date] = None,
    end_date: Optional[date] = None,
) -> None:
    """Calculate and push availability for a room type to Channex."""
    conn = await ChannexConnectionRepository.get_by_hotel_id(hotel_id)
    if not conn or not conn["is_active"] or not conn.get("channex_property_id"):
        return

    room_mapping = await ChannexRoomTypeMappingRepository.get_by_room_type_id(room_type_id)
    if not room_mapping:
        return

    room_type = await RoomTypeRepository.get_by_id(room_type_id)
    if not room_type:
        return

    if start_date is None:
        start_date = date.today()
    if end_date is None:
        end_date = start_date + timedelta(days=SYNC_HORIZON_DAYS)

    api_key = channex_service.get_platform_api_key()
    channex_property_id = str(conn["channex_property_id"])
    channex_room_type_id = str(room_mapping["channex_room_type_id"])
    total_rooms = room_type["total_rooms"]

    # Build per-day availability, batch into date ranges where possible
    values = []
    current = start_date
    batch_start = current
    prev_available = None

    while current <= end_date:
        next_day = current + timedelta(days=1)
        booked = await RoomTypeRepository.count_booked(room_type_id, current, next_day)
        blocked = await _count_local_blocks(room_type_id, current, next_day)
        available = max(0, total_rooms - booked - blocked)

        if prev_available is not None and available != prev_available:
            # Flush previous batch
            values.append({
                "property_id": channex_property_id,
                "room_type_id": channex_room_type_id,
                "date_from": batch_start.isoformat(),
                "date_to": (current - timedelta(days=1)).isoformat(),
                "availability": prev_available,
            })
            batch_start = current

        prev_available = available
        current = next_day

    # Flush last batch
    if prev_available is not None:
        values.append({
            "property_id": channex_property_id,
            "room_type_id": channex_room_type_id,
            "date_from": batch_start.isoformat(),
            "date_to": (current - timedelta(days=1)).isoformat(),
            "availability": prev_available,
        })

    if not values:
        return

    try:
        await channex_service.push_availability(api_key, values)
        logger.info(
            "Pushed availability for room type %s (%d ranges)",
            room_type_id, len(values),
        )
    except Exception as e:
        logger.error(
            "Failed to push availability for room type %s: %s",
            room_type_id, e,
        )


# ── ARI Push: Restrictions (rates + rules) ───────────────────────────

def _build_restriction_entry(
    room_type: dict,
    check_date: date,
    plan_name: str = "standard",
    markup_pct: Decimal = Decimal(0),
) -> dict:
    """Build a restriction snapshot for a single date.
    Returns dict with rate, min_stay_arrival, max_stay, stop_sell, CTA, CTD."""
    base_rate, non_refundable_rate = RoomTypeRepository.resolve_rate(room_type, check_date)

    # Use non-refundable rate/discount for non_refundable plans
    if plan_name == "non_refundable":
        if non_refundable_rate:
            rate = non_refundable_rate
        else:
            discount = room_type.get("non_refundable_discount", 5) or 5
            rate = round(base_rate * (1 - discount / 100), 2)
    else:
        rate = base_rate

    # Apply channel markup (direct is always 0%)
    if markup_pct:
        rate = round(float(rate) * (1 + float(markup_pct) / 100), 2)

    # stop_sell: true if the date falls outside all operating periods
    in_operating = RoomTypeRepository.is_date_in_operating_periods(room_type, check_date)
    stop_sell = not in_operating

    return {
        "rate": rate,
        "min_stay_arrival": room_type.get("min_stay", 1) or 1,
        "max_stay": room_type.get("max_stay", 0) or 0,
        "stop_sell": stop_sell,
        "closed_to_arrival": bool(room_type.get("closed_to_arrival", False)),
        "closed_to_departure": bool(room_type.get("closed_to_departure", False)),
    }


def _restrictions_equal(a: dict, b: dict) -> bool:
    """Check if two restriction snapshots are identical (for batching)."""
    return (
        a["rate"] == b["rate"]
        and a["min_stay_arrival"] == b["min_stay_arrival"]
        and a["max_stay"] == b["max_stay"]
        and a["stop_sell"] == b["stop_sell"]
        and a["closed_to_arrival"] == b["closed_to_arrival"]
        and a["closed_to_departure"] == b["closed_to_departure"]
    )


def _restriction_to_value(
    restr: dict,
    channex_property_id: str,
    channex_rate_plan_id: str,
    date_from: date,
    date_to: date,
) -> dict:
    """Convert a restriction snapshot into a Channex API value entry."""
    entry = {
        "property_id": channex_property_id,
        "rate_plan_id": channex_rate_plan_id,
        "date_from": date_from.isoformat(),
        "date_to": date_to.isoformat(),
        "rate": str(restr["rate"]),
        "min_stay_arrival": restr["min_stay_arrival"],
    }
    if restr["max_stay"] > 0:
        entry["max_stay"] = restr["max_stay"]
    if restr["stop_sell"]:
        entry["stop_sell"] = 1
    if restr["closed_to_arrival"]:
        entry["closed_to_arrival"] = 1
    if restr["closed_to_departure"]:
        entry["closed_to_departure"] = 1
    return entry


async def push_restrictions_for_rate_plan(
    hotel_id: str,
    room_type_id: str,
    channex_rate_plan_id: str,
    plan_name: str = "standard",
    channel: str = "direct",
    markup_pct: Optional[Decimal] = None,
    start_date: Optional[date] = None,
    end_date: Optional[date] = None,
) -> None:
    """Calculate and push rates + restrictions for a single rate plan to Channex."""
    conn = await ChannexConnectionRepository.get_by_hotel_id(hotel_id)
    if not conn or not conn["is_active"] or not conn.get("channex_property_id"):
        return

    room_type = await RoomTypeRepository.get_by_id(room_type_id)
    if not room_type:
        return

    if start_date is None:
        start_date = date.today()
    if end_date is None:
        end_date = start_date + timedelta(days=SYNC_HORIZON_DAYS)

    if markup_pct is None:
        markup_map = await ChannexChannelMarkupRepository.get_markup_map(hotel_id)
        markup_pct = markup_map.get(channel, Decimal(0))

    api_key = channex_service.get_platform_api_key()
    channex_property_id = str(conn["channex_property_id"])

    # Build restriction entries, batching consecutive identical days into ranges
    values = []
    current = start_date
    batch_start = current
    prev_restr = None

    while current <= end_date:
        restr = _build_restriction_entry(room_type, current, plan_name, markup_pct)

        if prev_restr is not None and not _restrictions_equal(prev_restr, restr):
            values.append(_restriction_to_value(
                prev_restr, channex_property_id, channex_rate_plan_id,
                batch_start, current - timedelta(days=1),
            ))
            batch_start = current

        prev_restr = restr
        current = current + timedelta(days=1)

    if prev_restr is not None:
        values.append(_restriction_to_value(
            prev_restr, channex_property_id, channex_rate_plan_id,
            batch_start, current - timedelta(days=1),
        ))

    if not values:
        return

    try:
        await channex_service.push_restrictions(api_key, values)
        logger.info(
            "Pushed restrictions for room type %s rate plan %s (%d ranges)",
            room_type_id, channex_rate_plan_id, len(values),
        )
    except Exception as e:
        logger.error(
            "Failed to push restrictions for room type %s: %s",
            room_type_id, e,
        )


# ── Cancellation policy push ─────────────────────────────────────────
#
# Maps a room type's flexible-rate cancellation settings onto each Channex
# flexible rate plan so OTA guests see the correct refund terms. The
# non_refundable plan keeps its own (separate) policy and is left alone.
#
# Airbnb caveat: Airbnb only accepts a fixed set of preset cancellation
# policies (Flexible / Moderate / Strict / etc.) which Channex exposes via
# the channel iframe rather than the rate-plan API. We skip Airbnb mappings
# here; hosts continue to manage Airbnb's policy through the iframe.

def _build_cancellation_policy(
    room_type: dict,
    channel: str,
) -> Optional[List[dict]]:
    """Build Channex cancellation_policies entries for a flexible rate plan.

    Returns a list of policy entries, or None if the channel can't accept a
    custom policy (currently: airbnb).
    """
    if channel == "airbnb":
        return None

    cancel_type = room_type.get("flexible_cancellation_type") or "free"

    if cancel_type == "partial_refund":
        window = int(room_type.get("partial_refund_cancel_window_days") or 30)
        refund_pct = int(room_type.get("partial_refund_amount_percent") or 50)
        # Channex penalty_value is the amount KEPT, not refunded.
        penalty_pct = max(0, min(100, 100 - refund_pct))
        return [
            # Free refund up to `window` days before arrival.
            {
                "days_before_arrival": window,
                "penalty_type": "percent",
                "penalty_value": 0,
            },
            # Inside the window: keep `penalty_pct`, refund the rest.
            {
                "days_before_arrival": 0,
                "penalty_type": "percent",
                "penalty_value": penalty_pct,
            },
        ]

    # "free" — refund anytime up to arrival.
    return [
        {
            "days_before_arrival": 0,
            "penalty_type": "percent",
            "penalty_value": 0,
        },
    ]


async def push_cancellation_policy_for_room_type(
    hotel_id: str,
    room_type_id: str,
) -> None:
    """Push the room type's flexible-rate cancellation policy to every
    matching Channex rate plan. Skips non_refundable plans and airbnb."""
    conn = await ChannexConnectionRepository.get_by_hotel_id(hotel_id)
    if not conn or not conn["is_active"] or not conn.get("channex_property_id"):
        return

    room_type = await RoomTypeRepository.get_by_id(room_type_id)
    if not room_type:
        return

    rate_plans = await ChannexRatePlanMappingRepository.list_by_room_type_id(room_type_id)
    if not rate_plans:
        return

    api_key = channex_service.get_platform_api_key()

    for rp in rate_plans:
        if rp.get("plan_name", "standard") != "standard":
            continue
        channel = rp.get("channel", "direct")
        policies = _build_cancellation_policy(room_type, channel)
        if policies is None:
            logger.info(
                "Skipping cancellation policy push for room type %s on %s "
                "(channel uses preset policies)",
                room_type_id, channel,
            )
            continue

        rate_plan_id = str(rp["channex_rate_plan_id"])
        try:
            await channex_service.update_rate_plan_cancellation_policy(
                api_key, rate_plan_id, policies=policies,
            )
            logger.info(
                "Pushed cancellation policy for room type %s rate plan %s (%s)",
                room_type_id, rate_plan_id, channel,
            )
        except Exception as e:
            logger.error(
                "Failed to push cancellation policy for room type %s rate plan %s: %s",
                room_type_id, rate_plan_id, e,
            )


# ── Full ARI sync for a hotel ────────────────────────────────────────

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
                hotel_id, room_type_id,
                str(rp["channex_rate_plan_id"]),
                plan_name=rp.get("plan_name", "standard"),
                channel=channel,
                markup_pct=markup_map.get(channel, Decimal(0)),
            )

    await ChannexConnectionRepository.update_last_ari_sync(
        hotel_id, datetime.now(timezone.utc)
    )
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
            hotel_id, room_type_id,
            start_date=booking["check_in"],
            end_date=booking["check_out"],
        )
    except Exception as e:
        logger.error("Failed to push ARI for booking %s: %s", booking_id, e)


# ── Inbound bookings ────────────────────────────────────────────────

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
                import asyncio
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
    guest_name = f"{first_name} {last_name}".strip()

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
    import asyncio
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


# ── Outbound cancellation ───────────────────────────────────────────

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
            hotel_id, room_type_id,
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
            booking_id, e,
        )


# ── Helpers ──────────────────────────────────────────────────────────

CHANNEX_SYNC_REASON = "channex_sync"


async def _count_local_blocks(
    room_type_id: str, start_date: date, end_date: date
) -> int:
    """Count blocked rooms excluding channex_sync blocks (to avoid circular push)."""
    count = await Database.fetchval(
        """
        SELECT COALESCE(SUM(blocked_count), 0) FROM room_blocks
        WHERE room_type_id = $1
          AND start_date < $3
          AND end_date > $2
          AND reason != $4
        """,
        room_type_id, start_date, end_date, CHANNEX_SYNC_REASON,
    )
    return count or 0
