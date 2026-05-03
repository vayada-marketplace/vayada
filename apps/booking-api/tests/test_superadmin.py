"""
Tests for /admin/superadmin endpoints — check, list hotels, create hotel, set password.
"""
from tests.conftest import (
    create_test_booking_hotel,
    create_test_user,
    get_auth_headers,
)


class TestSuperadminCheck:
    async def test_superadmin_check_success(self, client, cleanup_database):
        user = await create_test_user()
        # Promote to superadmin
        from app.database import AuthDatabase
        await AuthDatabase.execute(
            "UPDATE users SET is_superadmin = true WHERE id = $1", user["id"]
        )
        # Need a fresh token since is_superadmin is checked from DB
        resp = await client.get(
            "/admin/superadmin/check",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        assert resp.json()["is_superadmin"] is True

    async def test_superadmin_check_non_superadmin(self, client, hotel_user):
        resp = await client.get(
            "/admin/superadmin/check",
            headers=get_auth_headers(hotel_user["token"]),
        )
        assert resp.status_code == 403

    async def test_superadmin_check_no_auth(self, client):
        resp = await client.get("/admin/superadmin/check")
        assert resp.status_code == 401


async def _make_superadmin(user):
    """Promote a test user to superadmin."""
    from app.database import AuthDatabase
    await AuthDatabase.execute(
        "UPDATE users SET is_superadmin = true WHERE id = $1", user["id"]
    )


class TestSuperadminListHotels:
    async def test_list_hotels(self, client, cleanup_database):
        admin = await create_test_user()
        await _make_superadmin(admin)

        owner = await create_test_user()
        await create_test_booking_hotel(str(owner["id"]), name="Listed Hotel")

        resp = await client.get(
            "/admin/superadmin/hotels",
            headers=get_auth_headers(admin["token"]),
        )
        assert resp.status_code == 200
        hotels = resp.json()
        assert any(h["name"] == "Listed Hotel" for h in hotels)
        # Each entry should include owner info
        listed = next(h for h in hotels if h["name"] == "Listed Hotel")
        assert listed["owner_email"] == owner["email"]

    async def test_list_hotels_non_superadmin(self, client, hotel_user):
        resp = await client.get(
            "/admin/superadmin/hotels",
            headers=get_auth_headers(hotel_user["token"]),
        )
        assert resp.status_code == 403


class TestSuperadminCreateHotel:
    async def test_create_hotel(self, client, cleanup_database):
        admin = await create_test_user()
        await _make_superadmin(admin)

        target = await create_test_user()

        resp = await client.post(
            "/admin/superadmin/hotels",
            json={"user_id": str(target["id"]), "name": "SA Created Hotel"},
            headers=get_auth_headers(admin["token"]),
        )
        assert resp.status_code == 201
        body = resp.json()
        assert body["name"] == "SA Created Hotel"
        assert "id" in body
        assert "slug" in body

    async def test_create_hotel_auto_name(self, client, cleanup_database):
        admin = await create_test_user()
        await _make_superadmin(admin)

        target = await create_test_user(name="Auto Name Hotel")

        resp = await client.post(
            "/admin/superadmin/hotels",
            json={"user_id": str(target["id"])},
            headers=get_auth_headers(admin["token"]),
        )
        assert resp.status_code == 201
        assert resp.json()["name"] == "Auto Name Hotel"

    async def test_create_hotel_duplicate(self, client, cleanup_database):
        admin = await create_test_user()
        await _make_superadmin(admin)

        target = await create_test_user()
        await create_test_booking_hotel(str(target["id"]), name="Existing")

        resp = await client.post(
            "/admin/superadmin/hotels",
            json={"user_id": str(target["id"])},
            headers=get_auth_headers(admin["token"]),
        )
        assert resp.status_code == 201
        assert "already exists" in resp.json()["message"]

    async def test_create_hotel_non_superadmin(self, client, hotel_user):
        resp = await client.post(
            "/admin/superadmin/hotels",
            json={"user_id": "some-id"},
            headers=get_auth_headers(hotel_user["token"]),
        )
        assert resp.status_code == 403

    async def test_create_hotel_missing_user_id(self, client, cleanup_database):
        admin = await create_test_user()
        await _make_superadmin(admin)

        resp = await client.post(
            "/admin/superadmin/hotels",
            json={"name": "No User"},
            headers=get_auth_headers(admin["token"]),
        )
        assert resp.status_code == 422


class TestSuperadminSetPassword:
    async def test_set_password(self, client, cleanup_database):
        admin = await create_test_user()
        await _make_superadmin(admin)

        target = await create_test_user(password="OldPass123!")

        resp = await client.post(
            "/admin/superadmin/set-password",
            json={"email": target["email"], "password": "NewSuperPass123!"},
            headers=get_auth_headers(admin["token"]),
        )
        assert resp.status_code == 200
        assert "Password updated" in resp.json()["message"]

        # Verify login with new password
        login_resp = await client.post(
            "/auth/login",
            json={"email": target["email"], "password": "NewSuperPass123!"},
        )
        assert login_resp.status_code == 200

    async def test_set_password_user_not_found(self, client, cleanup_database):
        admin = await create_test_user()
        await _make_superadmin(admin)

        resp = await client.post(
            "/admin/superadmin/set-password",
            json={"email": "nobody@example.com", "password": "NewPass123!"},
            headers=get_auth_headers(admin["token"]),
        )
        assert resp.status_code == 404

    async def test_set_password_missing_fields(self, client, cleanup_database):
        admin = await create_test_user()
        await _make_superadmin(admin)

        resp = await client.post(
            "/admin/superadmin/set-password",
            json={"email": "test@example.com"},
            headers=get_auth_headers(admin["token"]),
        )
        assert resp.status_code == 422

    async def test_set_password_short_password(self, client, cleanup_database):
        admin = await create_test_user()
        await _make_superadmin(admin)

        resp = await client.post(
            "/admin/superadmin/set-password",
            json={"email": "test@example.com", "password": "short"},
            headers=get_auth_headers(admin["token"]),
        )
        assert resp.status_code == 422

    async def test_set_password_non_superadmin(self, client, hotel_user):
        resp = await client.post(
            "/admin/superadmin/set-password",
            json={"email": "x@x.com", "password": "Pass1234!"},
            headers=get_auth_headers(hotel_user["token"]),
        )
        assert resp.status_code == 403


class TestSuperadminCommissionOverride:
    """VAY-319: Commission rate override + audit log."""

    async def test_update_commission_writes_audit_row(self, client, cleanup_database):
        admin = await create_test_user()
        await _make_superadmin(admin)
        owner = await create_test_user()
        hotel = await create_test_booking_hotel(str(owner["id"]))

        resp = await client.patch(
            f"/admin/superadmin/hotels/{hotel['id']}/billing",
            json={
                "booking_engine_fee_pct": 4.0,
                "commission_note": "Negotiated rate for partner",
            },
            headers=get_auth_headers(admin["token"]),
        )
        assert resp.status_code == 200

        history_resp = await client.get(
            f"/admin/superadmin/hotels/{hotel['id']}/commission-history",
            headers=get_auth_headers(admin["token"]),
        )
        assert history_resp.status_code == 200
        history = history_resp.json()
        assert len(history) == 1
        assert history[0]["new_value"] == 4.0
        assert history[0]["note"] == "Negotiated rate for partner"
        assert history[0]["admin_user_id"] == str(admin["id"])

    async def test_update_commission_rejects_out_of_range(self, client, cleanup_database):
        admin = await create_test_user()
        await _make_superadmin(admin)
        owner = await create_test_user()
        hotel = await create_test_booking_hotel(str(owner["id"]))

        resp = await client.patch(
            f"/admin/superadmin/hotels/{hotel['id']}/billing",
            json={"booking_engine_fee_pct": 51},
            headers=get_auth_headers(admin["token"]),
        )
        assert resp.status_code == 400

    async def test_update_commission_no_op_skips_audit(self, client, cleanup_database):
        admin = await create_test_user()
        await _make_superadmin(admin)
        owner = await create_test_user()
        hotel = await create_test_booking_hotel(str(owner["id"]))

        # First write changes the rate — should record one history row.
        await client.patch(
            f"/admin/superadmin/hotels/{hotel['id']}/billing",
            json={"booking_engine_fee_pct": 6.5},
            headers=get_auth_headers(admin["token"]),
        )
        # Same value again — should NOT record a second history row.
        await client.patch(
            f"/admin/superadmin/hotels/{hotel['id']}/billing",
            json={"booking_engine_fee_pct": 6.5},
            headers=get_auth_headers(admin["token"]),
        )

        history_resp = await client.get(
            f"/admin/superadmin/hotels/{hotel['id']}/commission-history",
            headers=get_auth_headers(admin["token"]),
        )
        assert history_resp.status_code == 200
        assert len(history_resp.json()) == 1

    async def test_commission_history_requires_superadmin(self, client, hotel_user, cleanup_database):
        owner = await create_test_user()
        hotel = await create_test_booking_hotel(str(owner["id"]))
        resp = await client.get(
            f"/admin/superadmin/hotels/{hotel['id']}/commission-history",
            headers=get_auth_headers(hotel_user["token"]),
        )
        assert resp.status_code == 403
