"""
Tests for affiliate endpoints — public registration + admin management.
"""
from tests.conftest import (
    create_test_user,
    create_test_hotel,
    create_test_affiliate,
    get_auth_headers,
)


# ── Public affiliate registration ────────────────────────────────


class TestAffiliateRegistration:
    async def test_register_affiliate(self, client, cleanup_database):
        """Successfully register as an affiliate."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/affiliates",
            json={
                "fullName": "Jane Blogger",
                "email": "jane@blog.com",
                "socialMedia": "https://instagram.com/jane",
                "userType": "creator",
                "paymentMethod": "paypal",
                "paypalEmail": "jane@paypal.com",
            },
        )
        assert resp.status_code == 201
        body = resp.json()
        assert body["fullName"] == "Jane Blogger"
        assert body["email"] == "jane@blog.com"
        assert body["socialMedia"] == "https://instagram.com/jane"
        assert body["userType"] == "creator"
        assert body["status"] == "pending"
        assert len(body["referralCode"]) == 8
        assert "id" in body

    async def test_register_affiliate_minimal(self, client, cleanup_database):
        """Register with only required fields."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/affiliates",
            json={
                "fullName": "Simple Affiliate",
                "email": "simple@test.com",
            },
        )
        assert resp.status_code == 201
        body = resp.json()
        assert body["userType"] == "guest"
        assert body["paymentMethod"] == "stripe"

    async def test_register_affiliate_duplicate_email(self, client, cleanup_database):
        """Same email for same hotel → 409."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))

        payload = {"fullName": "First", "email": "dupe@test.com"}
        resp1 = await client.post(
            f"/api/hotels/{hotel['slug']}/affiliates", json=payload
        )
        assert resp1.status_code == 201

        resp2 = await client.post(
            f"/api/hotels/{hotel['slug']}/affiliates", json=payload
        )
        assert resp2.status_code == 409

    async def test_register_affiliate_unknown_hotel(self, client, init_database):
        resp = await client.post(
            "/api/hotels/nonexistent-hotel-xyz/affiliates",
            json={"fullName": "Nobody", "email": "nobody@test.com"},
        )
        assert resp.status_code == 404

    async def test_register_affiliate_invalid_email(self, client, cleanup_database):
        """Invalid email format → 422."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/affiliates",
            json={"fullName": "Bad Email", "email": "not-an-email"},
        )
        assert resp.status_code == 422

    async def test_register_affiliate_different_hotels(self, client, cleanup_database):
        """Same email can register as affiliate for different hotels."""
        user_a = await create_test_user()
        hotel_a = await create_test_hotel(str(user_a["id"]), name="Hotel A")
        user_b = await create_test_user()
        hotel_b = await create_test_hotel(str(user_b["id"]), name="Hotel B")

        email = "shared@test.com"
        resp_a = await client.post(
            f"/api/hotels/{hotel_a['slug']}/affiliates",
            json={"fullName": "Aff A", "email": email},
        )
        assert resp_a.status_code == 201

        resp_b = await client.post(
            f"/api/hotels/{hotel_b['slug']}/affiliates",
            json={"fullName": "Aff B", "email": email},
        )
        assert resp_b.status_code == 201


# ── Admin affiliate list ─────────────────────────────────────────


class TestAdminAffiliateList:
    async def test_list_affiliates_empty(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        resp = await client.get(
            "/admin/affiliates",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["affiliates"] == []
        assert body["total"] == 0

    async def test_list_affiliates(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        await create_test_affiliate(str(hotel["id"]), full_name="Aff One")
        await create_test_affiliate(str(hotel["id"]), full_name="Aff Two")

        resp = await client.get(
            "/admin/affiliates",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["total"] == 2
        assert len(body["affiliates"]) == 2

    async def test_list_affiliates_filter_by_status(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        aff = await create_test_affiliate(str(hotel["id"]))

        # Default status is 'pending', filter for 'approved' should return 0
        resp = await client.get(
            "/admin/affiliates?status=approved",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.json()["total"] == 0

        resp2 = await client.get(
            "/admin/affiliates?status=pending",
            headers=get_auth_headers(user["token"]),
        )
        assert resp2.json()["total"] == 1

    async def test_list_affiliates_pagination(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        for i in range(3):
            await create_test_affiliate(str(hotel["id"]), full_name=f"Aff {i}")

        resp = await client.get(
            "/admin/affiliates?limit=2&offset=0",
            headers=get_auth_headers(user["token"]),
        )
        body = resp.json()
        assert body["total"] == 3
        assert len(body["affiliates"]) == 2
        assert body["limit"] == 2

        resp2 = await client.get(
            "/admin/affiliates?limit=2&offset=2",
            headers=get_auth_headers(user["token"]),
        )
        assert len(resp2.json()["affiliates"]) == 1

    async def test_list_affiliates_isolation(self, client, cleanup_database):
        """User A cannot see User B's affiliates."""
        user_a = await create_test_user()
        hotel_a = await create_test_hotel(str(user_a["id"]))
        await create_test_affiliate(str(hotel_a["id"]), full_name="Aff A")

        user_b = await create_test_user()
        await create_test_hotel(str(user_b["id"]))

        resp = await client.get(
            "/admin/affiliates",
            headers=get_auth_headers(user_b["token"]),
        )
        assert resp.json()["total"] == 0

    async def test_list_affiliates_requires_auth(self, client):
        resp = await client.get("/admin/affiliates")
        assert resp.status_code == 401


# ── Admin affiliate detail ───────────────────────────────────────


class TestAdminAffiliateDetail:
    async def test_get_affiliate(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        aff = await create_test_affiliate(str(hotel["id"]), full_name="Detail Aff")

        resp = await client.get(
            f"/admin/affiliates/{aff['id']}",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["fullName"] == "Detail Aff"
        assert body["bookingCount"] == 0
        assert body["totalRevenue"] == 0.0
        assert body["totalCommission"] == 0.0

    async def test_get_affiliate_not_found(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        resp = await client.get(
            "/admin/affiliates/00000000-0000-0000-0000-000000000000",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 404

    async def test_get_affiliate_other_user(self, client, cleanup_database):
        """Cannot view another user's affiliate."""
        user_a = await create_test_user()
        hotel_a = await create_test_hotel(str(user_a["id"]))
        aff = await create_test_affiliate(str(hotel_a["id"]))

        user_b = await create_test_user()
        await create_test_hotel(str(user_b["id"]))

        resp = await client.get(
            f"/admin/affiliates/{aff['id']}",
            headers=get_auth_headers(user_b["token"]),
        )
        assert resp.status_code == 404


# ── Admin affiliate status update ────────────────────────────────


class TestAdminAffiliateStatus:
    async def test_approve_affiliate(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        aff = await create_test_affiliate(str(hotel["id"]))

        resp = await client.patch(
            f"/admin/affiliates/{aff['id']}/status",
            json={"status": "approved"},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "approved"

    async def test_reject_affiliate(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        aff = await create_test_affiliate(str(hotel["id"]))

        resp = await client.patch(
            f"/admin/affiliates/{aff['id']}/status",
            json={"status": "rejected"},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "rejected"

    async def test_suspend_affiliate(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        aff = await create_test_affiliate(str(hotel["id"]))

        resp = await client.patch(
            f"/admin/affiliates/{aff['id']}/status",
            json={"status": "suspended"},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "suspended"

    async def test_invalid_status(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        aff = await create_test_affiliate(str(hotel["id"]))

        resp = await client.patch(
            f"/admin/affiliates/{aff['id']}/status",
            json={"status": "invalid_value"},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 400

    async def test_status_update_not_found(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        resp = await client.patch(
            "/admin/affiliates/00000000-0000-0000-0000-000000000000/status",
            json={"status": "approved"},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 404

    async def test_status_update_other_user(self, client, cleanup_database):
        user_a = await create_test_user()
        hotel_a = await create_test_hotel(str(user_a["id"]))
        aff = await create_test_affiliate(str(hotel_a["id"]))

        user_b = await create_test_user()
        await create_test_hotel(str(user_b["id"]))

        resp = await client.patch(
            f"/admin/affiliates/{aff['id']}/status",
            json={"status": "approved"},
            headers=get_auth_headers(user_b["token"]),
        )
        assert resp.status_code == 404


# ── Admin affiliate commission update ────────────────────────────


class TestAdminAffiliateCommission:
    async def test_update_commission(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        aff = await create_test_affiliate(str(hotel["id"]))

        resp = await client.patch(
            f"/admin/affiliates/{aff['id']}/commission",
            json={"commissionPct": 15.0},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        assert resp.json()["effectiveCommissionPct"] == 15.0
        assert resp.json()["commissionPctOverride"] == 15.0

    async def test_commission_zero(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        aff = await create_test_affiliate(str(hotel["id"]))

        resp = await client.patch(
            f"/admin/affiliates/{aff['id']}/commission",
            json={"commissionPct": 0},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        assert resp.json()["effectiveCommissionPct"] == 0.0
        assert resp.json()["commissionPctOverride"] == 0.0

    async def test_commission_100(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        aff = await create_test_affiliate(str(hotel["id"]))

        resp = await client.patch(
            f"/admin/affiliates/{aff['id']}/commission",
            json={"commissionPct": 100},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        assert resp.json()["effectiveCommissionPct"] == 100.0
        assert resp.json()["commissionPctOverride"] == 100.0

    async def test_commission_over_100(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        aff = await create_test_affiliate(str(hotel["id"]))

        resp = await client.patch(
            f"/admin/affiliates/{aff['id']}/commission",
            json={"commissionPct": 150},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 400

    async def test_commission_negative(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        aff = await create_test_affiliate(str(hotel["id"]))

        resp = await client.patch(
            f"/admin/affiliates/{aff['id']}/commission",
            json={"commissionPct": -5},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 400

    async def test_commission_not_found(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        resp = await client.patch(
            "/admin/affiliates/00000000-0000-0000-0000-000000000000/commission",
            json={"commissionPct": 10},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 404

    async def test_commission_other_user(self, client, cleanup_database):
        user_a = await create_test_user()
        hotel_a = await create_test_hotel(str(user_a["id"]))
        aff = await create_test_affiliate(str(hotel_a["id"]))

        user_b = await create_test_user()
        await create_test_hotel(str(user_b["id"]))

        resp = await client.patch(
            f"/admin/affiliates/{aff['id']}/commission",
            json={"commissionPct": 20},
            headers=get_auth_headers(user_b["token"]),
        )
        assert resp.status_code == 404

    async def test_commission_null_clears_override(self, client, cleanup_database):
        """Setting commissionPct=null reverts the affiliate to the hotel default."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        aff = await create_test_affiliate(str(hotel["id"]))

        # First set a custom rate
        await client.patch(
            f"/admin/affiliates/{aff['id']}/commission",
            json={"commissionPct": 12.5},
            headers=get_auth_headers(user["token"]),
        )

        # Then clear it
        resp = await client.patch(
            f"/admin/affiliates/{aff['id']}/commission",
            json={"commissionPct": None},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["commissionPctOverride"] is None
        # Reverts to hotel default (5.0)
        assert body["effectiveCommissionPct"] == 5.0

    async def test_commission_tracks_hotel_default_when_no_override(
        self, client, cleanup_database
    ):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        await create_test_affiliate(str(hotel["id"]))

        # Change the hotel's default
        await client.patch(
            "/admin/affiliates/default-commission",
            json={"defaultCommissionPct": 8.0},
            headers=get_auth_headers(user["token"]),
        )

        # List affiliates — the one without an override should show 8%
        resp = await client.get(
            "/admin/affiliates?status=pending",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        affiliates = resp.json()["affiliates"]
        assert len(affiliates) == 1
        assert affiliates[0]["defaultCommissionPct"] == 8.0
        assert affiliates[0]["commissionPctOverride"] is None
        assert affiliates[0]["effectiveCommissionPct"] == 8.0

    async def test_default_commission_get_initial(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        resp = await client.get(
            "/admin/affiliates/default-commission",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        assert resp.json()["defaultCommissionPct"] == 5.0

    async def test_default_commission_update(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        resp = await client.patch(
            "/admin/affiliates/default-commission",
            json={"defaultCommissionPct": 7.5},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        assert resp.json()["defaultCommissionPct"] == 7.5

        get_resp = await client.get(
            "/admin/affiliates/default-commission",
            headers=get_auth_headers(user["token"]),
        )
        assert get_resp.json()["defaultCommissionPct"] == 7.5

    async def test_default_commission_over_100(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        resp = await client.patch(
            "/admin/affiliates/default-commission",
            json={"defaultCommissionPct": 150},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 400

    async def test_default_commission_negative(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        resp = await client.patch(
            "/admin/affiliates/default-commission",
            json={"defaultCommissionPct": -1},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 400
