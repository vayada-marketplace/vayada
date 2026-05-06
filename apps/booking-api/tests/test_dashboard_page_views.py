"""
Tests for the /admin/dashboard/page-views endpoint and the underlying
DashboardRepository.get_page_views_timeline helper.

Covers: default current-week window, week_offset shifts, property-
timezone day boundaries, and the has_previous_data flag when there are
no events in the prior 7-day window.
"""
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from app.database import Database
from app.repositories.dashboard_repo import DashboardRepository
from tests.conftest import (
    create_test_booking_hotel,
    create_test_user,
    get_auth_headers,
)


async def _insert_event(hotel_slug: str, when: datetime, event_type: str = "page_visit"):
    await Database.execute(
        """
        INSERT INTO booking_events (hotel_slug, event_type, session_id, metadata, created_at)
        VALUES ($1, $2, $3, '{}'::jsonb, $4)
        """,
        hotel_slug, event_type, "session-test", when,
    )


async def _purge_events(hotel_slug: str):
    await Database.execute(
        "DELETE FROM booking_events WHERE hotel_slug = $1", hotel_slug,
    )


class TestPageViewsTimelineRepo:
    async def test_default_window_is_seven_days_ending_today(self, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_booking_hotel(str(user["id"]), timezone_val="UTC")
        await _purge_events(hotel["slug"])
        try:
            today = datetime.now(ZoneInfo("UTC")).date()
            # one event per day in the current 7-day window
            for i in range(7):
                day = today - timedelta(days=i)
                await _insert_event(hotel["slug"], datetime.combine(day, datetime.min.time(), tzinfo=timezone.utc) + timedelta(hours=12))

            result = await DashboardRepository.get_page_views_timeline(hotel, week_offset=0)

            assert result["window_end"] == today.isoformat()
            assert result["window_start"] == (today - timedelta(days=6)).isoformat()
            assert len(result["buckets"]) == 7
            assert all(b["count"] == 1 for b in result["buckets"])
            assert result["total"] == 7
            assert result["has_previous_data"] is False
        finally:
            await _purge_events(hotel["slug"])

    async def test_week_offset_shifts_window(self, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_booking_hotel(str(user["id"]), timezone_val="UTC")
        await _purge_events(hotel["slug"])
        try:
            today = datetime.now(ZoneInfo("UTC")).date()
            # 3 events 9 days ago — falls in the offset=1 window
            past_day = today - timedelta(days=9)
            for _ in range(3):
                await _insert_event(
                    hotel["slug"],
                    datetime.combine(past_day, datetime.min.time(), tzinfo=timezone.utc) + timedelta(hours=10),
                )

            result = await DashboardRepository.get_page_views_timeline(hotel, week_offset=1)
            expected_end = today - timedelta(days=7)
            expected_start = expected_end - timedelta(days=6)

            assert result["window_end"] == expected_end.isoformat()
            assert result["window_start"] == expected_start.isoformat()
            assert result["total"] == 3
            # event was on past_day — find it in the bucket list
            matched = next(b for b in result["buckets"] if b["date"] == past_day.isoformat())
            assert matched["count"] == 3
        finally:
            await _purge_events(hotel["slug"])

    async def test_previous_window_total_and_flag(self, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_booking_hotel(str(user["id"]), timezone_val="UTC")
        await _purge_events(hotel["slug"])
        try:
            today = datetime.now(ZoneInfo("UTC")).date()
            # 5 events in current week, 2 events in previous week
            await _insert_event(
                hotel["slug"],
                datetime.combine(today - timedelta(days=2), datetime.min.time(), tzinfo=timezone.utc) + timedelta(hours=12),
            )
            for _ in range(4):
                await _insert_event(
                    hotel["slug"],
                    datetime.combine(today - timedelta(days=1), datetime.min.time(), tzinfo=timezone.utc) + timedelta(hours=12),
                )
            for _ in range(2):
                await _insert_event(
                    hotel["slug"],
                    datetime.combine(today - timedelta(days=10), datetime.min.time(), tzinfo=timezone.utc) + timedelta(hours=12),
                )

            result = await DashboardRepository.get_page_views_timeline(hotel, week_offset=0)
            assert result["total"] == 5
            assert result["previous_total"] == 2
            assert result["has_previous_data"] is True
            assert len(result["previous_buckets"]) == 7
        finally:
            await _purge_events(hotel["slug"])

    async def test_property_timezone_day_boundary(self, cleanup_database):
        """An event at 23:30 UTC near a far-east timezone should bucket to
        the *next* local day, not the UTC day."""
        user = await create_test_user()
        hotel = await create_test_booking_hotel(str(user["id"]), timezone_val="Pacific/Auckland")
        await _purge_events(hotel["slug"])
        try:
            tz = ZoneInfo("Pacific/Auckland")
            local_today = datetime.now(tz).date()
            # An instant that is "yesterday" in UTC but "today" in NZ — i.e.
            # 11pm local two days ago in NZ would be ~10am UTC two days ago.
            # Instead, build it from the local side and convert:
            local_noon_yesterday = datetime.combine(local_today - timedelta(days=1), datetime.min.time(), tzinfo=tz) + timedelta(hours=12)
            await _insert_event(hotel["slug"], local_noon_yesterday.astimezone(timezone.utc))

            result = await DashboardRepository.get_page_views_timeline(hotel, week_offset=0)
            yesterday_iso = (local_today - timedelta(days=1)).isoformat()
            matched = next(b for b in result["buckets"] if b["date"] == yesterday_iso)
            assert matched["count"] == 1
        finally:
            await _purge_events(hotel["slug"])


class TestPageViewsTimelineEndpoint:
    async def test_endpoint_returns_expected_shape(self, client, hotel_with_property):
        user = hotel_with_property["user"]
        hotel = hotel_with_property["hotel"]
        resp = await client.get(
            "/admin/dashboard/page-views",
            headers={**get_auth_headers(user["token"]), "X-Hotel-Id": str(hotel["id"])},
        )
        assert resp.status_code == 200
        body = resp.json()
        for key in (
            "window_start", "window_end", "previous_window_start", "previous_window_end",
            "buckets", "previous_buckets", "total", "previous_total", "has_previous_data",
        ):
            assert key in body
        assert len(body["buckets"]) == 7
        assert len(body["previous_buckets"]) == 7
        assert body["total"] == 0
        assert body["has_previous_data"] is False

    async def test_endpoint_rejects_negative_offset(self, client, hotel_with_property):
        user = hotel_with_property["user"]
        hotel = hotel_with_property["hotel"]
        resp = await client.get(
            "/admin/dashboard/page-views?week_offset=-1",
            headers={**get_auth_headers(user["token"]), "X-Hotel-Id": str(hotel["id"])},
        )
        assert resp.status_code == 422

    async def test_endpoint_requires_auth(self, client):
        resp = await client.get("/admin/dashboard/page-views")
        assert resp.status_code == 401
