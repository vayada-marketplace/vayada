import json
import logging
from typing import Optional, List, Tuple
from datetime import date
from app.database import Database

logger = logging.getLogger(__name__)


class RoomTypeRepository:

    @staticmethod
    async def list_by_hotel_id(hotel_id: str, *, active_only: bool = False) -> List[dict]:
        where = "WHERE hotel_id = $1"
        if active_only:
            where += " AND is_active = true"
        rows = await Database.fetch(
            f"SELECT * FROM room_types {where} ORDER BY sort_order, name", hotel_id
        )
        return [dict(r) for r in rows]

    @staticmethod
    async def get_by_id(room_type_id: str) -> Optional[dict]:
        row = await Database.fetchrow(
            "SELECT * FROM room_types WHERE id = $1", room_type_id
        )
        return dict(row) if row else None

    @staticmethod
    async def create(hotel_id: str, data: dict) -> dict:
        row = await Database.fetchrow(
            """
            INSERT INTO room_types (
                hotel_id, name, category, description, short_description,
                max_occupancy, size, base_rate, non_refundable_rate, currency,
                amenities, images, bed_type, features, benefits,
                total_rooms, is_active, sort_order, monthly_rates, daily_rates,
                operating_periods, seasons, weekend_surcharge,
                cancellation_policy, flexible_rate_enabled, non_refundable_discount,
                non_refundable_enabled
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                $11::jsonb, $12::jsonb, $13, $14::jsonb, $15::jsonb,
                $16, $17, $18, $19::jsonb, $20::jsonb,
                $21::jsonb, $22::jsonb, $23, $24, $25, $26,
                $27
            ) RETURNING *
            """,
            hotel_id,
            data["name"],
            data.get("category", ""),
            data.get("description", ""),
            data.get("short_description", ""),
            data.get("max_occupancy", 2),
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
            data.get("non_refundable_discount", 10),
            data.get("non_refundable_enabled", False),
        )
        return dict(row)

    @staticmethod
    async def update(room_type_id: str, updates: dict) -> Optional[dict]:
        if not updates:
            return await RoomTypeRepository.get_by_id(room_type_id)

        set_clauses = []
        values = []
        idx = 1
        for col, val in updates.items():
            if col in ("amenities", "images", "features", "benefits", "monthly_rates", "daily_rates", "operating_periods", "seasons"):
                set_clauses.append(f"{col} = ${idx}::jsonb")
                values.append(json.dumps(val))
            else:
                set_clauses.append(f"{col} = ${idx}")
                values.append(val)
            idx += 1

        set_clauses.append("updated_at = now()")
        query = (
            f"UPDATE room_types SET {', '.join(set_clauses)} "
            f"WHERE id = ${idx} RETURNING *"
        )
        values.append(room_type_id)
        row = await Database.fetchrow(query, *values)
        return dict(row) if row else None

    @staticmethod
    async def delete(room_type_id: str) -> bool:
        # Remove terminal-state bookings so the FK constraint doesn't block deletion
        await Database.execute(
            "DELETE FROM bookings WHERE room_type_id = $1 AND status IN ('cancelled', 'withdrawn', 'expired')",
            room_type_id,
        )
        result = await Database.execute(
            "DELETE FROM room_types WHERE id = $1", room_type_id
        )
        return result == "DELETE 1"

    @staticmethod
    async def count_booked(
        room_type_id: str, check_in: date, check_out: date
    ) -> int:
        """Count overlapping non-cancelled bookings for a room type.

        Excludes pending bookings with unpaid payment older than 30 min
        (abandoned or failed payment attempts).
        """
        count = await Database.fetchval(
            """
            SELECT COUNT(*) FROM bookings
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
    async def count_blocked(
        room_type_id: str, start_date: date, end_date: date
    ) -> int:
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
    def _find_season_rate(seasons: list, check_in: date) -> Optional[float]:
        """Find the season rate that covers the check-in date. Seasons repeat yearly."""
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
                if s_from > s_to:
                    if check_in >= s_from or check_in <= s_to:
                        return float(rate)
                else:
                    if s_from <= check_in <= s_to:
                        return float(rate)
            except (ValueError, TypeError):
                continue
        return None

    @staticmethod
    def _get_lowest_season_rate(seasons: list) -> Optional[float]:
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
    def resolve_rate(room: dict, check_in: date) -> Tuple[float, Optional[float]]:
        """Return (base_rate, non_refundable_rate) using daily override, then monthly, then season, then base."""
        # 1. Check daily rate override first (highest priority)
        daily_rates = room.get("daily_rates") or {}
        if isinstance(daily_rates, str):
            daily_rates = json.loads(daily_rates)
        daily_override = daily_rates.get(check_in.isoformat())
        if daily_override is not None:
            nr = room.get("non_refundable_rate")
            return (float(daily_override), float(nr) if nr is not None else None)

        # 2. Check monthly override
        monthly_rates = room.get("monthly_rates") or {}
        if isinstance(monthly_rates, str):
            monthly_rates = json.loads(monthly_rates)

        check_in_month = check_in.month
        override = monthly_rates.get(str(check_in_month))
        if override:
            base = override.get("base_rate") if override.get("base_rate") is not None else float(room["base_rate"])
            nr = room.get("non_refundable_rate")
            nr_default = float(nr) if nr is not None else None
            nr_resolved = override.get("non_refundable_rate") if override.get("non_refundable_rate") is not None else nr_default
            return (float(base), float(nr_resolved) if nr_resolved is not None else None)

        # Check seasons
        seasons = RoomTypeRepository._parse_seasons(room)
        season_rate = RoomTypeRepository._find_season_rate(seasons, check_in)
        if season_rate is not None:
            nr = room.get("non_refundable_rate")
            return (season_rate, float(nr) if nr is not None else None)

        if seasons:
            logger.warning(
                "Check-in date %s falls in a gap between seasons for room %s — "
                "falling back to base rate",
                check_in.isoformat(),
                room.get("id", "unknown"),
            )

        nr = room.get("non_refundable_rate")
        return (float(room["base_rate"]), float(nr) if nr is not None else None)
