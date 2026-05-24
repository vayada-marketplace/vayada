import json
import logging
from datetime import date

from app.database import Database

logger = logging.getLogger(__name__)


class RoomTypeRepository:
    @staticmethod
    async def list_by_hotel_id(hotel_id: str, *, active_only: bool = False) -> list[dict]:
        where = "WHERE hotel_id = $1"
        if active_only:
            where += " AND is_active = true"
        rows = await Database.fetch(
            f"SELECT * FROM room_types {where} ORDER BY sort_order, name", hotel_id
        )
        return [dict(r) for r in rows]

    @staticmethod
    async def get_by_id(room_type_id: str) -> dict | None:
        row = await Database.fetchrow("SELECT * FROM room_types WHERE id = $1", room_type_id)
        return dict(row) if row else None

    @staticmethod
    async def create(hotel_id: str, data: dict) -> dict:
        row = await Database.fetchrow(
            """
            INSERT INTO room_types (
                hotel_id, name, category, description, short_description,
                max_occupancy, max_adults, max_children, bedrooms, bathrooms, size,
                base_rate, non_refundable_rate, currency,
                amenities, images, bed_type, features, benefits,
                total_rooms, is_active, sort_order, monthly_rates, daily_rates,
                operating_periods, seasons, weekend_surcharge,
                cancellation_policy, flexible_rate_enabled, non_refundable_discount,
                non_refundable_enabled, last_minute_discount,
                minimum_advance_days, rate_payment_methods,
                non_refundable_cancellation_policy,
                flexible_cancellation_type,
                partial_refund_cancel_window_days,
                partial_refund_amount_percent,
                partial_refund_tiers,
                meal_plans
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                $12, $13, $14,
                $15::jsonb, $16::jsonb, $17, $18::jsonb, $19::jsonb,
                $20, $21, $22, $23::jsonb, $24::jsonb,
                $25::jsonb, $26::jsonb, $27, $28, $29, $30,
                $31, $32::jsonb, $33, $34::jsonb, $35,
                $36, $37, $38, $39::jsonb, $40::jsonb
            ) RETURNING *
            """,
            hotel_id,
            data["name"],
            data.get("category", ""),
            data.get("description", ""),
            data.get("short_description", ""),
            data.get("max_occupancy", 2),
            data.get("max_adults"),
            data.get("max_children"),
            data.get("bedrooms", 1),
            data.get("bathrooms", 1),
            data.get("size", 0),
            data.get("base_rate", 0),
            data.get("non_refundable_rate"),
            data.get("currency", "EUR"),
            json.dumps(data.get("amenities", [])),
            json.dumps(data.get("images", [])),
            data.get("bed_type", ""),
            json.dumps(data.get("features", [])),
            json.dumps(data.get("benefits", [])),
            data.get("total_rooms", 1),
            data.get("is_active", True),
            data.get("sort_order", 0),
            json.dumps(data.get("monthly_rates", {})),
            json.dumps(data.get("daily_rates", {})),
            json.dumps(data.get("operating_periods", [])),
            json.dumps(data.get("seasons", [])),
            data.get("weekend_surcharge", "+0%"),
            data.get("cancellation_policy", "Free until 7 days before"),
            data.get("flexible_rate_enabled", True),
            data.get("non_refundable_discount", 5),
            data.get("non_refundable_enabled", False),
            json.dumps(data.get("last_minute_discount"))
            if data.get("last_minute_discount")
            else None,
            data.get("minimum_advance_days", 0),
            json.dumps(data.get("rate_payment_methods"))
            if data.get("rate_payment_methods")
            else None,
            data.get("non_refundable_cancellation_policy", "Non-refundable from booking"),
            data.get("flexible_cancellation_type", "free"),
            data.get("partial_refund_cancel_window_days", 30),
            data.get("partial_refund_amount_percent", 50),
            json.dumps(data.get("partial_refund_tiers", [])),
            json.dumps(data.get("meal_plans", [])),
        )
        return dict(row)

    @staticmethod
    async def update(room_type_id: str, updates: dict) -> dict | None:
        if not updates:
            return await RoomTypeRepository.get_by_id(room_type_id)

        set_clauses = []
        values = []
        idx = 1
        for col, val in updates.items():
            if col in (
                "amenities",
                "images",
                "features",
                "benefits",
                "monthly_rates",
                "daily_rates",
                "operating_periods",
                "seasons",
                "last_minute_discount",
                "rate_payment_methods",
                "meal_plans",
                "partial_refund_tiers",
            ):
                set_clauses.append(f"{col} = ${idx}::jsonb")
                values.append(json.dumps(val))
            else:
                set_clauses.append(f"{col} = ${idx}")
                values.append(val)
            idx += 1

        set_clauses.append("updated_at = now()")
        query = f"UPDATE room_types SET {', '.join(set_clauses)} WHERE id = ${idx} RETURNING *"
        values.append(room_type_id)
        row = await Database.fetchrow(query, *values)
        return dict(row) if row else None

    @staticmethod
    async def delete(room_type_id: str) -> bool:
        # Remove terminal-state bookings so the FK constraint doesn't block deletion
        await Database.execute(
            "DELETE FROM bookings WHERE room_type_id = $1 AND status IN ('cancelled', 'declined', 'withdrawn', 'expired')",
            room_type_id,
        )
        result = await Database.execute("DELETE FROM room_types WHERE id = $1", room_type_id)
        return result == "DELETE 1"

    @staticmethod
    async def count_booked(room_type_id: str, check_in: date, check_out: date) -> int:
        """Sum the rooms held by overlapping non-cancelled bookings.

        VAY-403: a multi-room booking (number_of_rooms > 1) consumes that
        many physical rooms of inventory, not one. Summing number_of_rooms
        instead of counting rows is what stops the second room of a 2-room
        booking from staying open for sale (silent double-booking).

        Excludes pending bookings with unpaid payment older than 30 min
        (abandoned or failed payment attempts).
        """
        count = await Database.fetchval(
            """
            SELECT COALESCE(SUM(COALESCE(number_of_rooms, 1)), 0) FROM bookings
            WHERE room_type_id = $1
              AND status IN ('pending', 'confirmed')
              AND check_in < $3
              AND check_out > $2
              AND NOT (
                status = 'pending'
                AND payment_status = 'unpaid'
                AND created_at < NOW() - INTERVAL '30 minutes'
              )
            """,
            room_type_id,
            check_in,
            check_out,
        )
        return count or 0

    @staticmethod
    async def count_blocked(room_type_id: str, start_date: date, end_date: date) -> int:
        """Sum blocked_count for overlapping room blocks."""
        count = await Database.fetchval(
            """
            SELECT COALESCE(SUM(blocked_count), 0) FROM room_blocks
            WHERE room_type_id = $1
              AND start_date < $3
              AND end_date > $2
            """,
            room_type_id,
            start_date,
            end_date,
        )
        return count or 0

    @staticmethod
    def is_date_in_operating_periods(room: dict, check_date: date) -> bool:
        """Check if a date falls within any operating period (MM-DD, recurring yearly)."""
        periods = room.get("operating_periods") or []
        if isinstance(periods, str):
            periods = json.loads(periods)
        if not periods:
            return True  # No periods defined = always open
        mmdd = f"{check_date.month:02d}-{check_date.day:02d}"
        for p in periods:
            p_from = p.get("from", "")
            p_to = p.get("to", "")
            if not p_from or not p_to:
                continue
            # Handle cross-year periods (e.g. 11-01 to 02-28)
            if p_from > p_to:
                if mmdd >= p_from or mmdd <= p_to:
                    return True
            else:
                if p_from <= mmdd <= p_to:
                    return True
        return False

    @staticmethod
    def _parse_seasons(room: dict) -> list:
        seasons = room.get("seasons") or []
        if isinstance(seasons, str):
            seasons = json.loads(seasons)
        return seasons

    @staticmethod
    def _find_season_rate(seasons: list, check_in: date, adults: int | None = None) -> float | None:
        """Find the season rate that covers the check-in date. Seasons repeat yearly.
        If adults is provided and the season has occupancyRates, use the per-occupancy rate."""
        for season in seasons:
            rate = season.get("rate")
            if not rate:
                continue
            season_from = season.get("from")
            season_to = season.get("to")
            if not season_from or not season_to:
                continue
            try:
                # Seasons may be stored as MM-DD or YYYY-MM-DD
                if len(season_from) <= 5:
                    s_from = date(check_in.year, int(season_from[:2]), int(season_from[3:]))
                else:
                    s_from = date.fromisoformat(season_from)
                    s_from = s_from.replace(year=check_in.year)
                if len(season_to) <= 5:
                    s_to = date(check_in.year, int(season_to[:2]), int(season_to[3:]))
                else:
                    s_to = date.fromisoformat(season_to)
                    s_to = s_to.replace(year=check_in.year)
                # Handle seasons crossing year boundary (e.g., Nov-Feb)
                matched = False
                if s_from > s_to:
                    matched = check_in >= s_from or check_in <= s_to
                else:
                    matched = s_from <= check_in <= s_to
                if matched:
                    if adults is not None:
                        occupancy_rates = season.get("occupancyRates") or {}
                        occ_rate = occupancy_rates.get(str(adults))
                        if occ_rate is not None:
                            return float(occ_rate)
                    return float(rate)
            except (ValueError, TypeError):
                continue
        return None

    @staticmethod
    def _find_season_min_stay(seasons: list, check_in: date) -> int | None:
        """Return the minStay configured on the season covering check_in, if any."""
        for season in seasons:
            season_from = season.get("from")
            season_to = season.get("to")
            if not season_from or not season_to:
                continue
            try:
                if len(season_from) <= 5:
                    s_from = date(check_in.year, int(season_from[:2]), int(season_from[3:]))
                else:
                    s_from = date.fromisoformat(season_from).replace(year=check_in.year)
                if len(season_to) <= 5:
                    s_to = date(check_in.year, int(season_to[:2]), int(season_to[3:]))
                else:
                    s_to = date.fromisoformat(season_to).replace(year=check_in.year)
                if s_from > s_to:
                    matched = check_in >= s_from or check_in <= s_to
                else:
                    matched = s_from <= check_in <= s_to
                if matched:
                    raw = season.get("minStay")
                    if raw is None:
                        return None
                    try:
                        return int(raw)
                    except (ValueError, TypeError):
                        return None
            except (ValueError, TypeError):
                continue
        return None

    @staticmethod
    def _get_lowest_season_rate(seasons: list) -> float | None:
        """Return the lowest non-zero season rate (for display when no dates selected)."""
        rates = []
        for season in seasons:
            rate = season.get("rate")
            if rate:
                try:
                    r = float(rate)
                    if r > 0:
                        rates.append(r)
                except (ValueError, TypeError):
                    continue
        return min(rates) if rates else None

    @staticmethod
    def _parse_weekend_surcharge(raw: str) -> float:
        """Parse weekend surcharge string like '+15%' into a multiplier (e.g. 0.15)."""
        if not raw:
            return 0.0
        s = raw.strip().replace("+", "").replace("%", "")
        try:
            return float(s) / 100
        except (ValueError, TypeError):
            return 0.0

    @staticmethod
    def resolve_rate(
        room: dict, check_in: date, adults: int | None = None
    ) -> tuple[float, float | None]:
        """Return (base_rate, non_refundable_rate) using daily override, then season, then base.
        If adults is provided, uses per-occupancy rates from seasons when available.
        Applies weekend surcharge for Friday/Saturday nights."""
        # 1. Check daily rate override first (highest priority) — no surcharge on explicit overrides
        daily_rates = room.get("daily_rates") or {}
        if isinstance(daily_rates, str):
            daily_rates = json.loads(daily_rates)
        daily_override = daily_rates.get(check_in.isoformat())
        if daily_override is not None:
            nr = room.get("non_refundable_rate")
            return (float(daily_override), float(nr) if nr is not None else None)

        # 2. Check seasons (with occupancy support)
        seasons = RoomTypeRepository._parse_seasons(room)
        season_rate = RoomTypeRepository._find_season_rate(seasons, check_in, adults)

        if season_rate is not None:
            base_rate = season_rate
        else:
            # Fallback: use base_rate, or lowest season rate if base_rate is 0
            base_rate = float(room["base_rate"])
            if base_rate == 0 and seasons:
                lowest = RoomTypeRepository._get_lowest_season_rate(seasons)
                if lowest is not None:
                    base_rate = lowest
                logger.warning(
                    "Check-in date %s falls in a gap between seasons for room %s — "
                    "using lowest season rate %.2f",
                    check_in.isoformat(),
                    room.get("id", "unknown"),
                    base_rate,
                )

        # 3. Apply weekend surcharge (Friday=4, Saturday=5)
        if check_in.weekday() in (4, 5):
            surcharge = RoomTypeRepository._parse_weekend_surcharge(
                room.get("weekend_surcharge") or ""
            )
            if surcharge > 0:
                base_rate = round(base_rate * (1 + surcharge), 2)

        nr = room.get("non_refundable_rate")
        return (base_rate, float(nr) if nr is not None else None)
