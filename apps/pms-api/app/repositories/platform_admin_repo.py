from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from uuid import UUID

from app.database import BookingEngineDatabase, Database

VALID_GRANULARITIES = {"daily", "weekly", "monthly"}


@dataclass(frozen=True)
class Bucket:
    key: str
    label: str
    start: date
    end: date


def _today_utc() -> date:
    return datetime.now(UTC).date()


def _month_start(value: date) -> date:
    return value.replace(day=1)


def _add_months(value: date, months: int) -> date:
    year = value.year + (value.month - 1 + months) // 12
    month = (value.month - 1 + months) % 12 + 1
    return date(year, month, 1)


def _format_month(value: date) -> str:
    return value.strftime("%b")


def _buckets(granularity: str, today: date | None = None) -> list[Bucket]:
    today = today or _today_utc()
    if granularity == "monthly":
        first = _add_months(_month_start(today), -11)
        buckets = []
        for i in range(12):
            start = _add_months(first, i)
            end = _add_months(start, 1) - timedelta(days=1)
            buckets.append(Bucket(start.isoformat(), _format_month(start), start, end))
        return buckets

    if granularity == "weekly":
        current_week_start = today - timedelta(days=today.weekday())
        first = current_week_start - timedelta(weeks=11)
        return [
            Bucket(
                f"W{i + 1}",
                f"W{i + 1}",
                first + timedelta(weeks=i),
                first + timedelta(weeks=i, days=6),
            )
            for i in range(12)
        ]

    start = today - timedelta(days=29)
    return [
        Bucket(
            (start + timedelta(days=i)).isoformat(),
            (start + timedelta(days=i)).strftime("%b %-d"),
            start + timedelta(days=i),
            start + timedelta(days=i),
        )
        for i in range(30)
    ]


def _bucket_key(value: date, granularity: str, buckets: list[Bucket]) -> str | None:
    if granularity == "monthly":
        key = _month_start(value).isoformat()
        return key if any(bucket.key == key for bucket in buckets) else None
    if granularity == "weekly":
        week_start = value - timedelta(days=value.weekday())
        for bucket in buckets:
            if bucket.start == week_start:
                return bucket.key
        return None
    key = value.isoformat()
    return key if any(bucket.key == key for bucket in buckets) else None


def _pct_delta(current: int, previous: int) -> tuple[float | None, str]:
    if previous == 0:
        return (None, "No previous data") if current else (0, "No change")
    delta = round((current - previous) / previous * 100, 1)
    sign = "+" if delta > 0 else ""
    return delta, f"{sign}{delta}% vs prev period"


def _pp_delta(current: float | None, previous: float | None) -> tuple[float | None, str]:
    if current is None or previous is None:
        return None, "No previous data"
    delta = round((current - previous) * 100, 1)
    sign = "+" if delta > 0 else ""
    return delta, f"{sign}{delta}pp vs prev period"


class PlatformAdminRepository:
    @staticmethod
    async def list_properties() -> list[dict]:
        rows = await BookingEngineDatabase.fetch(
            """
            SELECT id, name, slug, platform_status, created_at
            FROM booking_hotels
            ORDER BY name ASC
            """
        )
        return [
            {
                "id": str(row["id"]),
                "name": row["name"],
                "slug": row["slug"],
                "status": row["platform_status"],
                "created_at": row["created_at"].isoformat(),
            }
            for row in rows
        ]

    @staticmethod
    async def update_property_status(property_id: str, status: str) -> dict:
        row = await BookingEngineDatabase.fetchrow(
            """
            UPDATE booking_hotels
            SET platform_status = $2, updated_at = now()
            WHERE id = $1
            RETURNING id, name, slug, platform_status, created_at
            """,
            UUID(property_id),
            status,
        )
        if status == "test":
            await Database.execute(
                "UPDATE bookings SET is_test_booking = TRUE WHERE hotel_id = $1",
                UUID(property_id),
            )
        if not row:
            return {}
        return {
            "id": str(row["id"]),
            "name": row["name"],
            "slug": row["slug"],
            "status": row["platform_status"],
            "created_at": row["created_at"].isoformat(),
        }

    @staticmethod
    async def get_growth_dashboard(
        *,
        granularity: str = "weekly",
        exclude_test_data: bool = True,
        property_ids: list[str] | None = None,
        booking_property_id: str | None = None,
    ) -> dict:
        if granularity not in VALID_GRANULARITIES:
            granularity = "weekly"

        properties = await PlatformAdminRepository.list_properties()
        available_ids = {p["id"] for p in properties}
        if property_ids:
            selected_ids = [pid for pid in property_ids if pid in available_ids]
        else:
            selected_ids = [
                p["id"] for p in properties if not exclude_test_data or p["status"] == "live"
            ]

        selected_properties = [p for p in properties if p["id"] in selected_ids]
        metric_properties = (
            [p for p in selected_properties if p["status"] == "live"]
            if exclude_test_data
            else selected_properties
        )
        metric_ids = [p["id"] for p in metric_properties]
        metric_slugs = [p["slug"] for p in metric_properties]

        today = _today_utc()
        current_start = today - timedelta(days=29)
        previous_start = current_start - timedelta(days=30)
        previous_end = current_start - timedelta(days=1)

        current_page_views = await PlatformAdminRepository._count_page_views(
            metric_slugs, current_start, today
        )
        previous_page_views = await PlatformAdminRepository._count_page_views(
            metric_slugs, previous_start, previous_end
        )
        current_bookings = await PlatformAdminRepository._count_bookings(
            metric_ids, current_start, today, exclude_test_data
        )
        previous_bookings = await PlatformAdminRepository._count_bookings(
            metric_ids, previous_start, previous_end, exclude_test_data
        )

        current_conversion = (
            current_bookings / current_page_views if current_page_views > 0 else None
        )
        previous_conversion = (
            previous_bookings / previous_page_views if previous_page_views > 0 else None
        )
        page_delta = _pct_delta(current_page_views, previous_page_views)
        booking_delta = _pct_delta(current_bookings, previous_bookings)
        conversion_delta = _pp_delta(current_conversion, previous_conversion)
        live_this_month = sum(
            1
            for p in selected_properties
            if p["status"] == "live"
            and datetime.fromisoformat(p["created_at"]).date() >= _month_start(today)
        )

        chart_buckets = _buckets(granularity, today)
        booking_ids = metric_ids
        if booking_property_id and booking_property_id in metric_ids:
            booking_ids = [booking_property_id]

        return {
            "properties": properties,
            "selected_property_ids": selected_ids,
            "exclude_test_data": exclude_test_data,
            "granularity": granularity,
            "booking_property_id": booking_property_id if booking_property_id in metric_ids else None,
            "metrics": [
                {
                    "key": "live_properties",
                    "label": "Live properties",
                    "value": str(len([p for p in selected_properties if p["status"] == "live"])),
                    "raw_value": len([p for p in selected_properties if p["status"] == "live"]),
                    "delta": {"value": live_this_month, "label": f"+{live_this_month} this month"},
                },
                {
                    "key": "page_views",
                    "label": "Page views (30d)",
                    "value": f"{current_page_views:,}",
                    "raw_value": current_page_views,
                    "delta": {"value": page_delta[0], "label": page_delta[1]},
                },
                {
                    "key": "booking_requests",
                    "label": "Booking requests (30d)",
                    "value": f"{current_bookings:,}",
                    "raw_value": current_bookings,
                    "delta": {"value": booking_delta[0], "label": booking_delta[1]},
                },
                {
                    "key": "conversion_rate",
                    "label": "Conversion rate",
                    "value": "N/A"
                    if current_conversion is None
                    else f"{current_conversion * 100:.1f}%",
                    "raw_value": current_conversion,
                    "delta": {"value": conversion_delta[0], "label": conversion_delta[1]},
                },
            ],
            "page_views": await PlatformAdminRepository._page_view_timeline(
                metric_slugs, chart_buckets, granularity
            ),
            "booking_requests": await PlatformAdminRepository._booking_timeline(
                booking_ids, chart_buckets, granularity, exclude_test_data
            ),
            "live_properties": PlatformAdminRepository._live_property_timeline(
                selected_properties, chart_buckets
            ),
            "empty_message": None if metric_ids else "Select at least one property.",
        }

    @staticmethod
    async def _count_page_views(slugs: list[str], start: date, end: date) -> int:
        if not slugs:
            return 0
        return (
            await BookingEngineDatabase.fetchval(
                """
                SELECT COUNT(*)
                FROM booking_events
                WHERE hotel_slug = ANY($1::text[])
                  AND event_type = 'page_visit'
                  AND created_at::date >= $2
                  AND created_at::date <= $3
                """,
                slugs,
                start,
                end,
            )
            or 0
        )

    @staticmethod
    async def _count_bookings(
        hotel_ids: list[str], start: date, end: date, exclude_test_data: bool
    ) -> int:
        if not hotel_ids:
            return 0
        return (
            await Database.fetchval(
                """
                SELECT COUNT(*)
                FROM bookings
                WHERE hotel_id = ANY($1::uuid[])
                  AND created_at::date >= $2
                  AND created_at::date <= $3
                  AND ($4::boolean = FALSE OR is_test_booking = FALSE)
                """,
                [UUID(hid) for hid in hotel_ids],
                start,
                end,
                exclude_test_data,
            )
            or 0
        )

    @staticmethod
    async def _page_view_timeline(
        slugs: list[str], buckets: list[Bucket], granularity: str
    ) -> list[dict]:
        values = {bucket.key: 0 for bucket in buckets}
        if slugs:
            rows = await BookingEngineDatabase.fetch(
                """
                SELECT created_at::date AS d, COUNT(*) AS count
                FROM booking_events
                WHERE hotel_slug = ANY($1::text[])
                  AND event_type = 'page_visit'
                  AND created_at::date >= $2
                  AND created_at::date <= $3
                GROUP BY created_at::date
                """,
                slugs,
                buckets[0].start,
                buckets[-1].end,
            )
            for row in rows:
                key = _bucket_key(row["d"], granularity, buckets)
                if key:
                    values[key] += row["count"]
        return [{"key": b.key, "label": b.label, "value": values[b.key]} for b in buckets]

    @staticmethod
    async def _booking_timeline(
        hotel_ids: list[str], buckets: list[Bucket], granularity: str, exclude_test_data: bool
    ) -> list[dict]:
        values = {bucket.key: 0 for bucket in buckets}
        if hotel_ids:
            rows = await Database.fetch(
                """
                SELECT created_at::date AS d, COUNT(*) AS count
                FROM bookings
                WHERE hotel_id = ANY($1::uuid[])
                  AND created_at::date >= $2
                  AND created_at::date <= $3
                  AND ($4::boolean = FALSE OR is_test_booking = FALSE)
                GROUP BY created_at::date
                """,
                [UUID(hid) for hid in hotel_ids],
                buckets[0].start,
                buckets[-1].end,
                exclude_test_data,
            )
            for row in rows:
                key = _bucket_key(row["d"], granularity, buckets)
                if key:
                    values[key] += row["count"]
        return [{"key": b.key, "label": b.label, "value": values[b.key]} for b in buckets]

    @staticmethod
    def _live_property_timeline(properties: list[dict], buckets: list[Bucket]) -> list[dict]:
        live_months: dict[str, int] = defaultdict(int)
        for prop in properties:
            if prop["status"] != "live":
                continue
            created_month = _month_start(datetime.fromisoformat(prop["created_at"]).date())
            live_months[created_month.isoformat()] += 1

        running = 0
        points = []
        for bucket in buckets:
            month_key = _month_start(bucket.start).isoformat()
            running += live_months[month_key]
            points.append({"key": bucket.key, "label": bucket.label, "value": running})
        return points
