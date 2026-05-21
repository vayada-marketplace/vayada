"""
Tests for affiliate click tracking — public click endpoint + admin stats.
"""

from app.database import Database

from tests.conftest import (
    create_test_affiliate,
    create_test_booking,
    create_test_hotel,
    create_test_room_type,
    create_test_user,
    get_auth_headers,
)

# ── Public click endpoint ───────────────────────────────────────


class TestAffiliateClickEndpoint:
    async def test_record_click(self, client, cleanup_database):
        """POST click for approved affiliate returns 204 and inserts row."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        aff = await create_test_affiliate(str(hotel["id"]))
        # Approve the affiliate
        await Database.execute(
            "UPDATE affiliates SET status = 'approved' WHERE id = $1",
            aff["id"],
        )

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/affiliates/{aff['referral_code']}/click",
        )
        assert resp.status_code == 204

        # Verify row exists in database
        count = await Database.fetchval(
            "SELECT COUNT(*) FROM affiliate_clicks WHERE affiliate_id = $1",
            aff["id"],
        )
        assert count == 1

    async def test_record_click_captures_headers(self, client, cleanup_database):
        """Click endpoint stores IP and user-agent."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        aff = await create_test_affiliate(str(hotel["id"]))
        await Database.execute(
            "UPDATE affiliates SET status = 'approved' WHERE id = $1",
            aff["id"],
        )

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/affiliates/{aff['referral_code']}/click",
            headers={
                "x-forwarded-for": "1.2.3.4",
                "user-agent": "TestBrowser/1.0",
            },
        )
        assert resp.status_code == 204

        row = await Database.fetchrow(
            "SELECT ip_address, user_agent FROM affiliate_clicks WHERE affiliate_id = $1",
            aff["id"],
        )
        assert row["ip_address"] == "1.2.3.4"
        assert row["user_agent"] == "TestBrowser/1.0"

    async def test_record_multiple_clicks(self, client, cleanup_database):
        """Multiple clicks create separate rows."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        aff = await create_test_affiliate(str(hotel["id"]))
        await Database.execute(
            "UPDATE affiliates SET status = 'approved' WHERE id = $1",
            aff["id"],
        )

        for _ in range(3):
            resp = await client.post(
                f"/api/hotels/{hotel['slug']}/affiliates/{aff['referral_code']}/click",
            )
            assert resp.status_code == 204

        count = await Database.fetchval(
            "SELECT COUNT(*) FROM affiliate_clicks WHERE affiliate_id = $1",
            aff["id"],
        )
        assert count == 3

    async def test_click_pending_affiliate_returns_404(self, client, cleanup_database):
        """Pending (not approved) affiliate click returns 404."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        aff = await create_test_affiliate(str(hotel["id"]))
        # Default status is 'pending'

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/affiliates/{aff['referral_code']}/click",
        )
        assert resp.status_code == 404

    async def test_click_rejected_affiliate_returns_404(self, client, cleanup_database):
        """Rejected affiliate click returns 404."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        aff = await create_test_affiliate(str(hotel["id"]))
        await Database.execute(
            "UPDATE affiliates SET status = 'rejected' WHERE id = $1",
            aff["id"],
        )

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/affiliates/{aff['referral_code']}/click",
        )
        assert resp.status_code == 404

    async def test_click_suspended_affiliate_returns_404(self, client, cleanup_database):
        """Suspended affiliate click returns 404."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        aff = await create_test_affiliate(str(hotel["id"]))
        await Database.execute(
            "UPDATE affiliates SET status = 'suspended' WHERE id = $1",
            aff["id"],
        )

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/affiliates/{aff['referral_code']}/click",
        )
        assert resp.status_code == 404

    async def test_click_unknown_hotel_returns_404(self, client, init_database):
        resp = await client.post(
            "/api/hotels/nonexistent-hotel-xyz/affiliates/abcd1234/click",
        )
        assert resp.status_code == 404

    async def test_click_unknown_referral_code_returns_404(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/affiliates/badcode1/click",
        )
        assert resp.status_code == 404


# ── Admin click stats ──────────────────────────────────────────


class TestAdminAffiliateClickStats:
    async def test_list_includes_click_count(self, client, cleanup_database):
        """Admin list returns clickCount for affiliates with clicks."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        aff = await create_test_affiliate(str(hotel["id"]))
        await Database.execute(
            "UPDATE affiliates SET status = 'approved' WHERE id = $1",
            aff["id"],
        )

        # Record 2 clicks
        for _ in range(2):
            await client.post(
                f"/api/hotels/{hotel['slug']}/affiliates/{aff['referral_code']}/click",
            )

        resp = await client.get(
            "/admin/affiliates",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert len(body["affiliates"]) == 1
        assert body["affiliates"][0]["clickCount"] == 2

    async def test_list_zero_clicks(self, client, cleanup_database):
        """Affiliate with no clicks shows clickCount=0 and conversionRate=0."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        await create_test_affiliate(str(hotel["id"]))

        resp = await client.get(
            "/admin/affiliates",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        aff_data = resp.json()["affiliates"][0]
        assert aff_data["clickCount"] == 0
        assert aff_data["conversionRate"] == 0.0

    async def test_conversion_rate_calculation(self, client, cleanup_database):
        """Conversion rate = bookings / clicks * 100."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        aff = await create_test_affiliate(str(hotel["id"]))
        await Database.execute(
            "UPDATE affiliates SET status = 'approved' WHERE id = $1",
            aff["id"],
        )

        # Record 4 clicks
        for _ in range(4):
            await client.post(
                f"/api/hotels/{hotel['slug']}/affiliates/{aff['referral_code']}/click",
            )

        # Create 1 booking attributed to this affiliate
        booking = await create_test_booking(
            str(hotel["id"]),
            str(room["id"]),
        )
        await Database.execute(
            "UPDATE bookings SET affiliate_id = $1 WHERE id = $2",
            aff["id"],
            booking["id"],
        )

        resp = await client.get(
            "/admin/affiliates",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        aff_data = resp.json()["affiliates"][0]
        assert aff_data["clickCount"] == 4
        assert aff_data["bookingCount"] == 1
        # 1/4 * 100 = 25.0
        assert aff_data["conversionRate"] == 25.0

    async def test_detail_includes_click_stats(self, client, cleanup_database):
        """GET /admin/affiliates/{id} returns clickCount and conversionRate."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        aff = await create_test_affiliate(str(hotel["id"]))
        await Database.execute(
            "UPDATE affiliates SET status = 'approved' WHERE id = $1",
            aff["id"],
        )

        # Record 5 clicks
        for _ in range(5):
            await client.post(
                f"/api/hotels/{hotel['slug']}/affiliates/{aff['referral_code']}/click",
            )

        resp = await client.get(
            f"/admin/affiliates/{aff['id']}",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["clickCount"] == 5
        assert body["conversionRate"] == 0.0  # No bookings, so 0%

    async def test_conversion_rate_zero_clicks(self, client, cleanup_database):
        """With bookings but zero clicks, conversion rate is 0 (no divide-by-zero)."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        aff = await create_test_affiliate(str(hotel["id"]))

        # Create a booking attributed to affiliate (but no clicks)
        booking = await create_test_booking(
            str(hotel["id"]),
            str(room["id"]),
        )
        await Database.execute(
            "UPDATE bookings SET affiliate_id = $1 WHERE id = $2",
            aff["id"],
            booking["id"],
        )

        resp = await client.get(
            "/admin/affiliates",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        aff_data = resp.json()["affiliates"][0]
        assert aff_data["bookingCount"] == 1
        assert aff_data["clickCount"] == 0
        assert aff_data["conversionRate"] == 0.0
