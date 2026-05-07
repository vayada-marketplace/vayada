"""Channex provisioning — first-time creation of a property + room types
+ rate plans for a hotel."""
import logging

from app.database import Database
from app.repositories.channex_mapping_repo import (
    ChannexConnectionRepository,
    ChannexRoomTypeMappingRepository,
    ChannexRatePlanMappingRepository,
)
from app.services import channex_service
from app.services.hotel_identity_service import get_currency as get_be_currency

from app.services.channex._common import (
    _CHANNEL_LABELS,
    _CHANNELS_WITH_NON_REFUNDABLE,
    _CHANNELS_WITH_MEAL_PLANS,
    MEAL_PLAN_LABELS,
)
from app.utils import parse_jsonb

logger = logging.getLogger(__name__)

# Channex rate plan titles must fit a 255-char column. Long room-type names
# combined with channel + meal-plan suffixes have hit that limit in the wild
# and surfaced as a 422 with a useless URL.
RATE_PLAN_TITLE_MAX_LENGTH = 255


async def _preflight_check(hotel_id: str, currency: str, room_types: list) -> None:
    """Reject provisioning before calling Channex if the hotel is missing
    data Channex requires. Raises ValueError with an actionable message —
    the router maps it to a 400 with that message in the detail."""
    if not currency:
        raise ValueError(
            "Channel manager can't be enabled yet: hotel currency isn't set. "
            "Set it in Settings → General before enabling."
        )
    if not room_types:
        raise ValueError(
            "Channel manager can't be enabled yet: no active room types. "
            "Add at least one room type before enabling."
        )
    for rt in room_types:
        name = rt.get("name") or "Unnamed room"
        if not rt.get("total_rooms") or int(rt["total_rooms"]) < 1:
            raise ValueError(
                f"Channel manager can't be enabled yet: room type '{name}' has no rooms. "
                "Set total_rooms ≥ 1 before enabling."
            )
        if not rt.get("max_occupancy") or int(rt["max_occupancy"]) < 1:
            raise ValueError(
                f"Channel manager can't be enabled yet: room type '{name}' has no occupancy. "
                "Set max_occupancy ≥ 1 before enabling."
            )


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

    # Pre-flight: validate the data Channex requires before we burn an API
    # round-trip on a guaranteed 422. Lets us return an actionable 400
    # instead of "Channex rejected rate_plans: ..." when the gap is on our
    # side (e.g. hotel currency missing).
    room_types = await Database.fetch(
        """
        SELECT * FROM room_types
        WHERE hotel_id = $1 AND is_active = true
        ORDER BY sort_order, name
        """,
        hotel_id,
    )
    await _preflight_check(hotel_id, currency, room_types)

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

    # Step 1b: Install Channex Messaging & Reviews app so OTA guest messages
    # flow into the unified inbox. Idempotent — re-checks on each provision.
    if not conn.get("messaging_app_installed"):
        try:
            already = await channex_service.is_messaging_app_installed(
                api_key, channex_property_id,
            )
            if not already:
                await channex_service.install_messaging_app(api_key, channex_property_id)
                logger.info(
                    "Installed Channex messaging app on property %s",
                    channex_property_id,
                )
            await ChannexConnectionRepository.set_messaging_app_installed(hotel_id, True)
        except Exception as e:
            # Non-fatal: provisioning continues without messaging. Backfill
            # endpoint can retry later. Most likely cause is a plan-tier or
            # paid-add-on restriction.
            logger.warning(
                "Failed to install Channex messaging app for hotel %s: %s",
                hotel_id, e,
            )

    # Step 2: Create room types + rate plans for each vayada room type.
    # `room_types` was loaded above for pre-flight; reuse it.

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

        # Create rate plans — one per (channel, plan_name, meal_plan_code) combination:
        #   direct        → standard (+ non_refundable if enabled), room-only meal_plan_code 0
        #   booking_com   → standard (+ non_refundable if enabled), per enabled meal plan
        #   airbnb        → standard only (Airbnb API allows one rate plan per listing)
        existing_rates = await ChannexRatePlanMappingRepository.list_by_room_type_id(room_type_id)
        existing_combos = {
            (
                r.get("channel", "direct"),
                r.get("plan_name", "standard"),
                int(r.get("meal_plan_code") or 0),
            )
            for r in existing_rates
        }
        default_occ = min(2, rt["max_occupancy"])

        meal_plans = parse_jsonb(rt.get("meal_plans") or [])
        meal_codes = [0] + [int(m["code"]) for m in meal_plans if m.get("code")]

        plans_to_create = []
        for channel, label in _CHANNEL_LABELS.items():
            channel_prefix = f"{label} " if label else ""
            channel_meal_codes = (
                meal_codes if channel in _CHANNELS_WITH_MEAL_PLANS else [0]
            )
            for meal_code in channel_meal_codes:
                meal_label = MEAL_PLAN_LABELS.get(meal_code, "")
                meal_suffix = f" ({meal_label})" if meal_label else ""
                plans_to_create.append((
                    channel,
                    "standard",
                    meal_code,
                    f"{rt['name']} - {channel_prefix}Standard{meal_suffix}",
                ))
                if rt.get("non_refundable_enabled") and channel in _CHANNELS_WITH_NON_REFUNDABLE:
                    plans_to_create.append((
                        channel,
                        "non_refundable",
                        meal_code,
                        f"{rt['name']} - {channel_prefix}Non-Refundable{meal_suffix}",
                    ))

        for channel, plan_name, meal_code, plan_title in plans_to_create:
            if (channel, plan_name, meal_code) in existing_combos:
                continue
            # Cap to Channex's 255-char column. Long room-type names + suffix
            # combos have hit the limit and surfaced as a 422.
            safe_title = plan_title[:RATE_PLAN_TITLE_MAX_LENGTH]
            channex_rp = await channex_service.create_rate_plan(
                api_key,
                property_id=channex_property_id,
                room_type_id=channex_room_type_id,
                title=safe_title,
                sell_mode="per_room",
                # Fall back to property currency when the room type itself
                # has none — Channex requires currency on the rate plan and
                # null caused the original 422 in VAY-386.
                currency=rt.get("currency") or currency,
                options=[{"occupancy": default_occ, "is_primary": True}],
                meal_plan_code=meal_code,
            )
            await ChannexRatePlanMappingRepository.create(
                hotel_id=hotel_id,
                room_type_id=room_type_id,
                channex_rate_plan_id=channex_rp["id"],
                channex_room_type_id=channex_room_type_id,
                sell_mode="per_room",
                plan_name=plan_name,
                channel=channel,
                meal_plan_code=meal_code,
            )
            rates_created += 1
            logger.info(
                "Created Channex rate plan %s (%s/%s/meal=%d) for %s",
                channex_rp["id"], channel, plan_name, meal_code, rt["name"],
            )

    return {
        "channex_property_id": channex_property_id,
        "rooms_created": rooms_created,
        "rates_created": rates_created,
    }
