"""
Dashboard repository — queries PMS database for booking stats
and booking_events table for funnel/page-view analytics.
"""
import logging
from datetime import date, timedelta
from app.database import Database, PmsDatabase
from app.config import settings
from app.repositories.event_repo import EventRepository

logger = logging.getLogger(__name__)


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
    async def _get_pms_hotel_id(user_id: str):
        """Find the PMS hotel_id (UUID) for a given user."""
        if not settings.PMS_DATABASE_URL:
            return None
        row = await PmsDatabase.fetchrow(
            "SELECT id FROM hotels WHERE user_id = $1 LIMIT 1", user_id
        )
        return row["id"] if row else None

    @staticmethod
    async def _get_hotel_slug(user_id: str) -> str | None:
        """Find the booking engine hotel slug for a given user."""
        row = await Database.fetchrow(
            "SELECT slug FROM booking_hotels WHERE user_id = $1 LIMIT 1", user_id
        )
        return row["slug"] if row else None

    @staticmethod
    async def get_stats(user_id: str, range_key: str = "today") -> dict:
        hotel_id = await DashboardRepository._get_pms_hotel_id(user_id)
        hotel_slug = await DashboardRepository._get_hotel_slug(user_id)
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
    async def get_bookings_by_source(user_id: str, range_key: str = "month") -> dict:
        hotel_id = await DashboardRepository._get_pms_hotel_id(user_id)
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
    async def get_conversion_funnel(user_id: str, range_key: str = "month") -> dict:
        """Conversion funnel based on real tracked events."""
        hotel_slug = await DashboardRepository._get_hotel_slug(user_id)
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
    async def get_sparklines(user_id: str, range_key: str = "today") -> dict:
        """Return 7-point sparkline data for each stat."""
        hotel_id = await DashboardRepository._get_pms_hotel_id(user_id)
        hotel_slug = await DashboardRepository._get_hotel_slug(user_id)
        if not hotel_id:
            return {
                "revenue": [0] * 7,
                "bookings": [0] * 7,
                "avg_rate": [0] * 7,
                "page_views": [0] * 7,
            }

        today = date.today()
        days = []
        if range_key == "month":
            for i in range(7):
                d_start = today - timedelta(days=29 - i * 4)
                d_end = today - timedelta(days=max(0, 29 - (i + 1) * 4 + 1))
                days.append((d_start, d_end))
        elif range_key == "week":
            for i in range(7):
                d = today - timedelta(days=6 - i)
                days.append((d, d))
        else:
            for i in range(7):
                d = today - timedelta(days=6 - i)
                days.append((d, d))

        revenue = []
        bookings = []
        avg_rate = []
        page_views = []

        for d_start, d_end in days:
            row = await PmsDatabase.fetchrow(
                """
                SELECT
                    COALESCE(SUM(total_amount), 0) as rev,
                    COUNT(*) as cnt,
                    COALESCE(AVG(nightly_rate), 0) as rate
                FROM bookings
                WHERE hotel_id = $1
                  AND status = 'confirmed'
                  AND created_at::date >= $2 AND created_at::date <= $3
                """,
                hotel_id, d_start, d_end,
            )
            revenue.append(float(row["rev"]))
            bookings.append(row["cnt"])
            avg_rate.append(round(float(row["rate"]), 2))

            pv = 0
            if hotel_slug:
                pv = await EventRepository.count_by_type(hotel_slug, "page_visit", d_start, d_end)
            page_views.append(pv)

        return {
            "revenue": revenue,
            "bookings": bookings,
            "avg_rate": avg_rate,
            "page_views": page_views,
        }
