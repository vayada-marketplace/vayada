import json
import logging
from typing import Optional, List
from datetime import date

from app.database import Database
from app.repositories.room_type_repo import RoomTypeRepository
from app.services.availability_service import remaining_for_stay
from app.models.room_type import RoomTypeResponse
from app.utils import parse_jsonb

logger = logging.getLogger(__name__)


def resolve_last_minute_discount(
    hotel_config: Optional[dict],
    room_config: Optional[dict],
    days_before: int,
) -> Optional[int]:
    """Return the last-minute discount percent for the given days-before-check-in,
    or None if no discount applies.

    The hotel-level ``enabled`` flag is the master switch — when it is off (or
    no hotel config exists), no discount applies anywhere, regardless of any
    per-room config. Per-room configs can still opt a room out (``enabled``
    false) or override the tier table when the master switch is on.
    """
    if not hotel_config or not hotel_config.get("enabled"):
        return None
    if room_config is not None and not room_config.get("enabled", True):
        return None
    room_tiers = (room_config or {}).get("tiers") or []
    tiers = room_tiers if room_tiers else (hotel_config.get("tiers") or [])
    for tier in tiers:
        tier_min = tier.get("daysBeforeMin", 0)
        tier_max = tier.get("daysBeforeMax")
        pct = tier.get("discountPercent", 0)
        if pct <= 0:
            continue
        if days_before >= tier_min and (tier_max is None or days_before <= tier_max):
            return int(pct)
    return None


async def get_hotel_id_by_slug(slug: str) -> Optional[str]:
    row = await Database.fetchrow(
        "SELECT id FROM hotels WHERE slug = $1", slug
    )
    return str(row["id"]) if row else None


async def get_rooms_for_guest(
    slug: str,
    check_in: Optional[date] = None,
    check_out: Optional[date] = None,
    adults: Optional[int] = None,
) -> List[RoomTypeResponse]:
    hotel_id = await get_hotel_id_by_slug(slug)
    if not hotel_id:
        return []

    # Load global benefits and last-minute discount config from hotel
    hotel_row = await Database.fetchrow(
        "SELECT benefits, last_minute_discount FROM hotels WHERE id = $1", hotel_id
    )
    hotel_benefits = parse_jsonb(hotel_row["benefits"]) if hotel_row else []
    hotel_lm_config = None
    if hotel_row and hotel_row.get("last_minute_discount"):
        raw = hotel_row["last_minute_discount"]
        hotel_lm_config = json.loads(raw) if isinstance(raw, str) else raw

    rooms = await RoomTypeRepository.list_by_hotel_id(hotel_id, active_only=True)
    result = []

    for room in rooms:
        # Skip rooms that require more advance notice than available
        min_advance = room.get("minimum_advance_days") or 0
        if check_in and min_advance > 0:
            days_until = (check_in - date.today()).days
            if days_until < min_advance:
                continue

        total = room["total_rooms"]
        if check_in and check_out:
            if not RoomTypeRepository.is_date_in_operating_periods(room, check_in):
                remaining = 0
            else:
                remaining = await remaining_for_stay(
                    str(room["id"]), total, check_in, check_out
                )
        else:
            remaining = total

        if check_in:
            base_rate, nr_rate = RoomTypeRepository.resolve_rate(room, check_in, adults)
        else:
            base_rate = float(room["base_rate"])
            nr = room.get("non_refundable_rate")
            nr_rate = float(nr) if nr is not None else None
            # If base_rate is 0, try to use the lowest season rate for display
            if base_rate == 0:
                seasons = RoomTypeRepository._parse_seasons(room)
                season_rate = RoomTypeRepository._get_lowest_season_rate(seasons)
                if season_rate is not None:
                    base_rate = season_rate

        # Only provide NR rate when non-refundable is enabled
        if not room.get("non_refundable_enabled", False):
            nr_rate = None
        elif room.get("flexible_rate_enabled", True):
            # Flexible + NR: calculate NR rate from discount percentage
            discount_pct = room.get("non_refundable_discount")
            if discount_pct is not None and discount_pct > 0:
                nr_rate = round(base_rate * (1 - discount_pct / 100), 2)
            elif nr_rate is None or nr_rate == 0:
                nr_rate = base_rate
        else:
            # NR only (no flexible): non-refundable rate is the base rate
            nr_rate = base_rate

        # Apply last-minute discount (booking-time concern, not rate-definition)
        original_rate = None
        lm_discount_pct = None
        if check_in:
            days_before = (check_in - date.today()).days
            room_lm_raw = room.get("last_minute_discount")
            room_lm_config = None
            if room_lm_raw:
                room_lm_config = json.loads(room_lm_raw) if isinstance(room_lm_raw, str) else room_lm_raw
            pct = resolve_last_minute_discount(hotel_lm_config, room_lm_config, days_before)
            if pct and pct > 0:
                lm_discount_pct = pct
                original_rate = base_rate
                base_rate = round(base_rate * (1 - pct / 100), 2)
                if nr_rate is not None:
                    nr_rate = round(nr_rate * (1 - pct / 100), 2)

        result.append(
            RoomTypeResponse(
                id=str(room["id"]),
                name=room["name"],
                category=room.get("category", ""),
                description=room["description"],
                short_description=room["short_description"],
                max_occupancy=room["max_occupancy"],
                bedrooms=room.get("bedrooms", 1),
                bathrooms=room.get("bathrooms", 1),
                size=room["size"],
                base_rate=base_rate,
                non_refundable_rate=nr_rate,
                original_rate=original_rate,
                last_minute_discount_percent=lm_discount_pct,
                currency=room["currency"],
                amenities=parse_jsonb(room["amenities"]),
                images=parse_jsonb(room["images"]),
                bed_type=room["bed_type"],
                remaining_rooms=remaining,
                features=parse_jsonb(room["features"]),
                benefits=hotel_benefits,
                flexible_rate_enabled=room.get("flexible_rate_enabled", True),
                cancellation_policy=room.get("cancellation_policy") or "Free until 7 days before",
                flexible_cancellation_type=room.get("flexible_cancellation_type") or "free",
                partial_refund_cancel_window_days=room.get("partial_refund_cancel_window_days", 30),
                partial_refund_amount_percent=room.get("partial_refund_amount_percent", 50),
                non_refundable_cancellation_policy=room.get("non_refundable_cancellation_policy") or "Non-refundable from booking",
                rate_payment_methods=(lambda v: v if isinstance(v, dict) else None)(parse_jsonb(room.get("rate_payment_methods"))),
            )
        )

    return result
