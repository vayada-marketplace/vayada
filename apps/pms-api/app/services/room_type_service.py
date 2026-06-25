import json
import logging
from datetime import date

from app.database import Database
from app.models.room_type import RoomTypeResponse
from app.repositories.hotel_repo import HotelRepository
from app.repositories.room_type_repo import RoomTypeRepository
from app.services import hotel_identity_service
from app.services.availability_service import compute_stay_pricing, remaining_for_stay
from app.services.calendar_auto_open_service import is_stay_sellable
from app.services.occupancy import room_allows_guest_mix
from app.services.same_day_booking import is_same_day_booking_closed, property_today
from app.utils import parse_jsonb

logger = logging.getLogger(__name__)


def resolve_last_minute_discount(
    hotel_config: dict | None,
    room_config: dict | None,
    days_before: int,
) -> int | None:
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


async def get_hotel_id_by_slug(slug: str) -> str | None:
    row = await Database.fetchrow("SELECT id FROM hotels WHERE slug = $1", slug)
    return str(row["id"]) if row else None


async def get_rooms_for_guest(
    slug: str,
    check_in: date | None = None,
    check_out: date | None = None,
    adults: int | None = None,
    children: int | None = None,
) -> list[RoomTypeResponse]:
    hotel_id = await get_hotel_id_by_slug(slug)
    if not hotel_id:
        return []

    # Load global benefits, property timezone, and booking rule config from hotel.
    hotel_row = await Database.fetchrow(
        "SELECT benefits, last_minute_discount, timezone, "
        "same_day_bookings_enabled, same_day_booking_cutoff_time "
        "FROM hotels WHERE id = $1",
        hotel_id,
    )
    pms_benefits = parse_jsonb(hotel_row["benefits"]) if hotel_row else []
    booking_engine_benefits = await hotel_identity_service.get_benefits(hotel_id)
    hotel_benefits = (
        booking_engine_benefits if booking_engine_benefits is not None else pms_benefits
    )
    hotel_lm_config = None
    if hotel_row and hotel_row.get("last_minute_discount"):
        raw = hotel_row["last_minute_discount"]
        hotel_lm_config = json.loads(raw) if isinstance(raw, str) else raw
    hotel_timezone = hotel_row.get("timezone") if hotel_row else None
    today = property_today(hotel_timezone)
    same_day_closed = bool(
        check_in
        and is_same_day_booking_closed(
            check_in,
            same_day_bookings_enabled=bool(
                hotel_row.get("same_day_bookings_enabled", True) if hotel_row else True
            ),
            same_day_booking_cutoff_time=hotel_row.get("same_day_booking_cutoff_time")
            if hotel_row
            else None,
            timezone=hotel_timezone,
        )
    )

    rooms = await RoomTypeRepository.list_by_hotel_id(hotel_id, active_only=True)
    calendar_settings = await HotelRepository.get_calendar_settings(hotel_id)
    result = []

    for room in rooms:
        # Capacity gate scales by total_rooms (VAY-492): a 4-cap room with
        # 2 units in inventory should still appear for a 6-guest search, so
        # the guest can book 2 of them. Per-stay availability is shown via
        # remaining_rooms below — sold-out room types still surface so the
        # frontend can render the "Sold Out" badge.
        if not room_allows_guest_mix(
            room, adults, children, units=int(room.get("total_rooms") or 1)
        ):
            continue

        # Skip rooms that require more advance notice than available
        min_advance = room.get("minimum_advance_days") or 0
        if check_in and min_advance > 0:
            days_until = (check_in - today).days
            if days_until < min_advance:
                continue

        total = room["total_rooms"]
        if check_in and check_out:
            stay_open = is_stay_sellable(check_in, check_out, room, calendar_settings)
            seasons = RoomTypeRepository._parse_seasons(room)
            max_stay = RoomTypeRepository._find_stay_max_stay(seasons, check_in, check_out)
            nights = (check_out - check_in).days
            if (
                same_day_closed
                or not RoomTypeRepository.is_date_in_operating_periods(room, check_in)
                or not stay_open
                or (max_stay is not None and nights > max_stay)
            ):
                remaining = 0
            else:
                remaining = await remaining_for_stay(str(room["id"]), total, check_in, check_out)
        else:
            remaining = total

        nights = (check_out - check_in).days if check_in and check_out else 0
        nightly_rates: list[float] = []
        non_refundable_nightly_rates: list[float] = []
        original_nightly_rates: list[float] = []

        if check_in and check_out and nights > 0:
            flexible_pricing = compute_stay_pricing(room, check_in, check_out, adults, "flexible")
            nightly_rates = flexible_pricing.nightly_rates
            base_rate = flexible_pricing.average_nightly_rate
            nr_rate = None
            if room.get("non_refundable_enabled", False):
                nr_pricing = compute_stay_pricing(
                    room,
                    check_in,
                    check_out,
                    adults,
                    "nonrefundable",
                )
                non_refundable_nightly_rates = nr_pricing.nightly_rates
                nr_rate = nr_pricing.average_nightly_rate
        elif check_in:
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
            non_refundable_nightly_rates = []
        elif room.get("flexible_rate_enabled", True):
            # Flexible + NR: calculate NR rate from discount percentage
            discount_pct = room.get("non_refundable_discount")
            if non_refundable_nightly_rates:
                nr_rate = round(
                    sum(non_refundable_nightly_rates) / len(non_refundable_nightly_rates),
                    2,
                )
            elif discount_pct is not None and discount_pct > 0:
                nr_rate = round(base_rate * (1 - discount_pct / 100), 2)
                non_refundable_nightly_rates = [
                    round(rate * (1 - discount_pct / 100), 2) for rate in nightly_rates
                ]
            elif nr_rate is None or nr_rate == 0:
                nr_rate = base_rate
                if not non_refundable_nightly_rates:
                    non_refundable_nightly_rates = nightly_rates.copy()
        else:
            # NR only (no flexible): non-refundable rate is the base rate
            nr_rate = base_rate
            if not non_refundable_nightly_rates:
                non_refundable_nightly_rates = nightly_rates.copy()

        # Apply last-minute discount (booking-time concern, not rate-definition)
        original_rate = None
        lm_discount_pct = None
        if check_in:
            days_before = (check_in - today).days
            room_lm_raw = room.get("last_minute_discount")
            room_lm_config = None
            if room_lm_raw:
                room_lm_config = (
                    json.loads(room_lm_raw) if isinstance(room_lm_raw, str) else room_lm_raw
                )
            pct = resolve_last_minute_discount(hotel_lm_config, room_lm_config, days_before)
            if pct and pct > 0:
                lm_discount_pct = pct
                original_rate = base_rate
                original_nightly_rates = nightly_rates.copy()
                base_rate = round(base_rate * (1 - pct / 100), 2)
                nightly_rates = [round(rate * (1 - pct / 100), 2) for rate in nightly_rates]
                if nightly_rates:
                    base_rate = round(sum(nightly_rates) / len(nightly_rates), 2)
                if nr_rate is not None:
                    nr_rate = round(nr_rate * (1 - pct / 100), 2)
                    non_refundable_nightly_rates = [
                        round(rate * (1 - pct / 100), 2) for rate in non_refundable_nightly_rates
                    ]
                    if non_refundable_nightly_rates:
                        nr_rate = round(
                            sum(non_refundable_nightly_rates) / len(non_refundable_nightly_rates),
                            2,
                        )

        result.append(
            RoomTypeResponse(
                id=str(room["id"]),
                name=room["name"],
                category=room.get("category", ""),
                description=room["description"],
                short_description=room["short_description"],
                max_occupancy=room["max_occupancy"],
                max_adults=room.get("max_adults"),
                max_children=room.get("max_children"),
                bedrooms=room.get("bedrooms", 1),
                bathrooms=room.get("bathrooms", 1),
                size=room["size"],
                base_rate=base_rate,
                non_refundable_rate=nr_rate,
                nightly_rates=nightly_rates,
                non_refundable_nightly_rates=non_refundable_nightly_rates,
                original_nightly_rates=original_nightly_rates,
                original_rate=original_rate,
                last_minute_discount_percent=lm_discount_pct,
                currency=room["currency"],
                location_address=room.get("location_address", "") or "",
                latitude=float(room["latitude"]) if room.get("latitude") is not None else None,
                longitude=float(room["longitude"]) if room.get("longitude") is not None else None,
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
                partial_refund_tiers=parse_jsonb(room.get("partial_refund_tiers", [])),
                non_refundable_cancellation_policy=room.get("non_refundable_cancellation_policy")
                or "Non-refundable from booking",
                rate_payment_methods=(lambda v: v if isinstance(v, dict) else None)(
                    parse_jsonb(room.get("rate_payment_methods"))
                ),
                rate_deposit_settings=(lambda v: v if isinstance(v, dict) else None)(
                    parse_jsonb(room.get("rate_deposit_settings"))
                ),
            )
        )

    return result
