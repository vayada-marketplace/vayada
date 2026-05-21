"""
Dashboard repository — queries PMS database for booking stats
and booking_events table for funnel/page-view analytics.
"""
import logging
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from app.database import Database, PmsDatabase
from app.config import settings
from app.repositories.event_repo import EventRepository

logger = logging.getLogger(__name__)


def _today_in_tz(tz_name: str | None) -> tuple[date, str]:
    """Return (today-in-property-tz, resolved-tz-name).

    Falls back to UTC if the stored timezone is missing or unknown so a
    misconfigured row never 500s the dashboard."""
    name = tz_name or "UTC"
    try:
        return datetime.now(ZoneInfo(name)).date(), name
    except ZoneInfoNotFoundError:
        return datetime.now(ZoneInfo("UTC")).date(), "UTC"


def _date_range(range_key: str) -> tuple[date, date, date, date]:
    """Return (start, end, prev_start, prev_end) for a time range."""
    today = date.today()
    if range_key == "week":
        start = today - timedelta(days=today.weekday())
        end = today
        prev_start = start - timedelta(days=7)
        prev_end = start - timedelta(days=1)
    elif range_key == "month":
        start = today - timedelta(days=29)
        end = today
        prev_start = start - timedelta(days=30)
        prev_end = start - timedelta(days=1)
    else:  # today
        start = today
        end = today
        prev_start = today - timedelta(days=1)
        prev_end = today - timedelta(days=1)
    return start, end, prev_start, prev_end


class DashboardRepository:

    @staticmethod
    async def get_stats(hotel: dict, range_key: str = "today") -> dict:
        """
        Stats for the given booking_hotels row.

        After the multi-hotel-ids unification, booking_hotels.id ==
        pms.hotels.id, so the same UUID can be used to query both
        databases — no separate _get_pms_hotel_id lookup is needed.
        """
        hotel_id = str(hotel["id"]) if hotel else None
        hotel_slug = hotel.get("slug") if hotel else None
        if not hotel_id:
            return {
                "revenue": 0, "revenue_previous": 0,
                "bookings": 0, "bookings_previous": 0,
                "avg_nightly_rate": 0, "avg_nightly_rate_previous": 0,
                "page_views": 0, "page_views_previous": 0,
                "next_arrival": None, "live_since": None,
            }

        start, end, prev_start, prev_end = _date_range(range_key)

        # Current period stats
        current = await PmsDatabase.fetchrow(
            """
            SELECT
                COALESCE(SUM(total_amount), 0) as revenue,
                COUNT(*) as bookings,
                COALESCE(AVG(nightly_rate), 0) as avg_rate
            FROM bookings
            WHERE hotel_id = $1
              AND status = 'confirmed'
              AND created_at::date >= $2 AND created_at::date <= $3
            """,
            hotel_id, start, end,
        )

        # Previous period stats
        previous = await PmsDatabase.fetchrow(
            """
            SELECT
                COALESCE(SUM(total_amount), 0) as revenue,
                COUNT(*) as bookings,
                COALESCE(AVG(nightly_rate), 0) as avg_rate
            FROM bookings
            WHERE hotel_id = $1
              AND status = 'confirmed'
              AND created_at::date >= $2 AND created_at::date <= $3
            """,
            hotel_id, prev_start, prev_end,
        )

        # Next arrival
        next_arrival_row = await PmsDatabase.fetchrow(
            """
            SELECT check_in FROM bookings
            WHERE hotel_id = $1 AND status = 'confirmed' AND check_in >= $2
            ORDER BY check_in LIMIT 1
            """,
            hotel_id, date.today(),
        )

        # Live since (first booking)
        live_since_row = await PmsDatabase.fetchrow(
            "SELECT MIN(created_at) as first FROM bookings WHERE hotel_id = $1",
            hotel_id,
        )

        # Real page view counts from booking_events
        page_views = 0
        page_views_previous = 0
        if hotel_slug:
            page_views = await EventRepository.count_by_type(hotel_slug, "page_visit", start, end)
            page_views_previous = await EventRepository.count_by_type(hotel_slug, "page_visit", prev_start, prev_end)

        return {
            "revenue": float(current["revenue"]),
            "revenue_previous": float(previous["revenue"]),
            "bookings": current["bookings"],
            "bookings_previous": previous["bookings"],
            "avg_nightly_rate": round(float(current["avg_rate"]), 2),
            "avg_nightly_rate_previous": round(float(previous["avg_rate"]), 2),
            "page_views": page_views,
            "page_views_previous": page_views_previous,
            "next_arrival": str(next_arrival_row["check_in"]) if next_arrival_row and next_arrival_row["check_in"] else None,
            "live_since": str(live_since_row["first"].date()) if live_since_row and live_since_row["first"] else None,
        }

    @staticmethod
    async def get_bookings_by_source(hotel: dict, range_key: str = "month") -> dict:
        hotel_id = str(hotel["id"]) if hotel else None
        if not hotel_id:
            return {"total_revenue": 0, "sources": []}

        start, end, _, _ = _date_range(range_key)

        rows = await PmsDatabase.fetch(
            """
            SELECT
                COALESCE(channel, 'direct') as source,
                COALESCE(SUM(total_amount), 0) as revenue,
                COUNT(*) as count
            FROM bookings
            WHERE hotel_id = $1
              AND status = 'confirmed'
              AND created_at::date >= $2 AND created_at::date <= $3
            GROUP BY COALESCE(channel, 'direct')
            ORDER BY revenue DESC
            """,
            hotel_id, start, end,
        )

        total = sum(float(r["revenue"]) for r in rows)
        sources = []
        for r in rows:
            rev = float(r["revenue"])
            sources.append({
                "source": r["source"],
                "revenue": rev,
                "percentage": round((rev / total * 100) if total > 0 else 0, 1),
                "count": r["count"],
            })

        return {"total_revenue": total, "sources": sources}

    @staticmethod
    async def get_conversion_funnel(hotel: dict, range_key: str = "month") -> dict:
        """Conversion funnel based on real tracked events."""
        hotel_slug = hotel.get("slug") if hotel else None
        if not hotel_slug:
            return {"steps": []}

        start, end, _, _ = _date_range(range_key)

        counts = await EventRepository.count_all_types(hotel_slug, start, end)

        page_visits = counts.get("page_visit", 0)
        viewed_room = counts.get("viewed_room", 0)
        started = counts.get("started_booking", 0)
        completed = counts.get("completed_booking", 0)

        if page_visits == 0:
            return {"steps": [
                {"label": "Page visits", "value": 0, "percentage": 0},
                {"label": "Viewed a room", "value": 0, "percentage": 0},
                {"label": "Started booking", "value": 0, "percentage": 0},
                {"label": "Completed booking", "value": 0, "percentage": 0},
            ]}

        return {"steps": [
            {"label": "Page visits", "value": page_visits, "percentage": 100},
            {"label": "Viewed a room", "value": viewed_room, "percentage": round(viewed_room / page_visits * 100, 1)},
            {"label": "Started booking", "value": started, "percentage": round(started / page_visits * 100, 1)},
            {"label": "Completed booking", "value": completed, "percentage": round(completed / page_visits * 100, 1)},
        ]}

    @staticmethod
    def _sparkline_buckets(range_key: str) -> list[tuple[date, date]]:
        """7 contiguous, non-overlapping date buckets ending today.

        - "today" / "week": one day per bucket, last 7 days
        - "month": four days per bucket, last 28 days

        The previous "month" implementation produced gappy/overlapping
        windows of mixed widths (e.g. bucket 0 was 1 day, others 5–6
        days, with a single-day overlap at every boundary)."""
        today = date.today()
        if range_key == "month":
            return [
                (
                    today - timedelta(days=27 - i * 4),
                    today - timedelta(days=27 - (i + 1) * 4 + 1) if i < 6 else today,
                )
                for i in range(7)
            ]
        return [(today - timedelta(days=6 - i),) * 2 for i in range(7)]

    @staticmethod
    async def get_sparklines(hotel: dict, range_key: str = "today") -> dict:
        """Return 7-point sparkline data for each stat. Two grouped
        queries (bookings, page-view events) instead of the previous 14
        per-bucket round-trips."""
        hotel_id = str(hotel["id"]) if hotel else None
        hotel_slug = hotel.get("slug") if hotel else None
        if not hotel_id:
            return {
                "revenue": [0] * 7,
                "bookings": [0] * 7,
                "avg_rate": [0] * 7,
                "page_views": [0] * 7,
            }

        days = DashboardRepository._sparkline_buckets(range_key)
        window_start = days[0][0]
        window_end = days[-1][1]

        # All bookings in the window, fetched once and bucketed in Python.
        booking_rows = await PmsDatabase.fetch(
            """
            SELECT created_at::date AS d, total_amount, nightly_rate
            FROM bookings
            WHERE hotel_id = $1
              AND status = 'confirmed'
              AND created_at::date >= $2 AND created_at::date <= $3
            """,
            hotel_id, window_start, window_end,
        )

        # Page-view counts in the window — also one query.
        page_view_by_day: dict[date, int] = {}
        if hotel_slug:
            page_view_by_day = await EventRepository.count_by_day(
                hotel_slug, "page_visit", window_start, window_end,
            )

        revenue: list[float] = []
        bookings: list[int] = []
        avg_rate: list[float] = []
        page_views: list[int] = []

        for d_start, d_end in days:
            bucket = [r for r in booking_rows if d_start <= r["d"] <= d_end]
            revenue.append(sum(float(r["total_amount"]) for r in bucket))
            bookings.append(len(bucket))
            rates = [float(r["nightly_rate"]) for r in bucket]
            avg_rate.append(round(sum(rates) / len(rates), 2) if rates else 0)

            pv = sum(c for d, c in page_view_by_day.items() if d_start <= d <= d_end)
            page_views.append(pv)

        return {
            "revenue": revenue,
            "bookings": bookings,
            "avg_rate": avg_rate,
            "page_views": page_views,
        }

    @staticmethod
    async def get_page_views_timeline(hotel: dict, week_offset: int = 0) -> dict:
        """7-day window of page-view counts plus the directly preceding
        7-day window for comparison. `week_offset` shifts both windows
        back by ``7 * week_offset`` days; ``0`` = current week.

        Day boundaries follow the property's IANA timezone so a hotel in
        Bali doesn't see Berlin-day rollovers in its own dashboard.

        Returns the bucketed data plus the bounding dates so the client
        can render labels without re-deriving them and accidentally
        drifting from server time."""
        hotel_slug = hotel.get("slug") if hotel else None
        today, tz_name = _today_in_tz(hotel.get("timezone") if hotel else None)

        if week_offset < 0:
            week_offset = 0

        window_end = today - timedelta(days=7 * week_offset)
        window_start = window_end - timedelta(days=6)
        previous_window_end = window_start - timedelta(days=1)
        previous_window_start = previous_window_end - timedelta(days=6)

        empty_buckets = [
            {"date": (window_start + timedelta(days=i)).isoformat(), "count": 0}
            for i in range(7)
        ]
        empty_previous = [
            {"date": (previous_window_start + timedelta(days=i)).isoformat(), "count": 0}
            for i in range(7)
        ]
        if not hotel_slug:
            return {
                "window_start": window_start.isoformat(),
                "window_end": window_end.isoformat(),
                "previous_window_start": previous_window_start.isoformat(),
                "previous_window_end": previous_window_end.isoformat(),
                "buckets": empty_buckets,
                "previous_buckets": empty_previous,
                "total": 0,
                "previous_total": 0,
                "has_previous_data": False,
            }

        # Single query covers both windows (14 contiguous days) so the
        # comparison metric doesn't double the round-trip count.
        counts = await EventRepository.count_by_day_in_tz(
            hotel_slug, "page_visit", previous_window_start, window_end, tz_name,
        )

        buckets = [
            {
                "date": (window_start + timedelta(days=i)).isoformat(),
                "count": counts.get(window_start + timedelta(days=i), 0),
            }
            for i in range(7)
        ]
        previous_buckets = [
            {
                "date": (previous_window_start + timedelta(days=i)).isoformat(),
                "count": counts.get(previous_window_start + timedelta(days=i), 0),
            }
            for i in range(7)
        ]
        total = sum(b["count"] for b in buckets)
        previous_total = sum(b["count"] for b in previous_buckets)

        return {
            "window_start": window_start.isoformat(),
            "window_end": window_end.isoformat(),
            "previous_window_start": previous_window_start.isoformat(),
            "previous_window_end": previous_window_end.isoformat(),
            "buckets": buckets,
            "previous_buckets": previous_buckets,
            "total": total,
            "previous_total": previous_total,
            "has_previous_data": previous_total > 0,
        }
