"""
Tests for multi-hotel support — GET /admin/hotels, X-Hotel-Id header routing,
fallback behaviour, and cross-hotel isolation.
"""
import json
from tests.conftest import (
    create_test_booking_hotel,
    create_test_user,
    get_auth_headers,
    generate_test_slug,
)


# ── GET /admin/hotels ────────────────────────────────────────────


class TestListHotels:
    async def test_list_hotels_empty(self, client, hotel_user):
        """No hotels → empty list."""
        resp = await client.get(
            "/admin/hotels",
            headers=get_auth_headers(hotel_user["token"]),
        )
        assert resp.status_code == 200
        assert resp.json() == []

    async def test_list_hotels_single(self, client, hotel_with_property):
        """One hotel → list with one entry."""
        user = hotel_with_property["user"]
        resp = await client.get(
            "/admin/hotels",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        hotels = resp.json()
        assert len(hotels) == 1
        assert hotels[0]["name"] == "Test Hotel"
        assert "id" in hotels[0]
        assert "slug" in hotels[0]

    async def test_list_hotels_multiple(self, client, cleanup_database):
        """Two hotels → list ordered by created_at ASC."""
        user = await create_test_user()
        uid = str(user["id"])
        await create_test_booking_hotel(uid, name="First Hotel")
        await create_test_booking_hotel(uid, name="Second Hotel")

        resp = await client.get(
            "/admin/hotels",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        hotels = resp.json()
        assert len(hotels) == 2
        assert hotels[0]["name"] == "First Hotel"
        assert hotels[1]["name"] == "Second Hotel"

    async def test_list_hotels_requires_auth(self, client):
        resp = await client.get("/admin/hotels")
        assert resp.status_code == 403

    async def test_list_hotels_non_hotel_user(self, client, cleanup_database):
        user = await create_test_user(user_type="admin")
        resp = await client.get(
            "/admin/hotels",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 403

    async def test_list_hotels_returns_summary_fields(self, client, hotel_with_property):
        """Response includes id, name, slug, location, country."""
        user = hotel_with_property["user"]
        resp = await client.get(
            "/admin/hotels",
            headers=get_auth_headers(user["token"]),
        )
        hotel = resp.json()[0]
        for field in ("id", "name", "slug", "location", "country"):
            assert field in hotel

    async def test_list_hotels_isolation(self, client, cleanup_database):
        """User A cannot see User B's hotels."""
        user_a = await create_test_user()
        user_b = await create_test_user()
        await create_test_booking_hotel(str(user_a["id"]), name="Hotel A")
        await create_test_booking_hotel(str(user_b["id"]), name="Hotel B")

        resp = await client.get(
            "/admin/hotels",
            headers=get_auth_headers(user_a["token"]),
        )
        hotels = resp.json()
        assert len(hotels) == 1
        assert hotels[0]["name"] == "Hotel A"


# ── X-Hotel-Id header routing ────────────────────────────────────


class TestHotelIdHeader:
    async def test_property_settings_with_header(self, client, cleanup_database):
        """X-Hotel-Id header selects the correct hotel."""
        user = await create_test_user()
        uid = str(user["id"])
        hotel_a = await create_test_booking_hotel(uid, name="Hotel Alpha")
        hotel_b = await create_test_booking_hotel(uid, name="Hotel Beta")

        # Request Hotel B specifically
        resp = await client.get(
            "/admin/settings/property",
            headers={
                **get_auth_headers(user["token"]),
                "X-Hotel-Id": str(hotel_b["id"]),
            },
        )
        assert resp.status_code == 200
        assert resp.json()["property_name"] == "Hotel Beta"

        # Request Hotel A specifically
        resp_a = await client.get(
            "/admin/settings/property",
            headers={
                **get_auth_headers(user["token"]),
                "X-Hotel-Id": str(hotel_a["id"]),
            },
        )
        assert resp_a.status_code == 200
        assert resp_a.json()["property_name"] == "Hotel Alpha"

    async def test_wrong_hotel_id_returns_403(self, client, cleanup_database):
        """X-Hotel-Id belonging to another user → 403."""
        user_a = await create_test_user()
        user_b = await create_test_user()
        hotel_b = await create_test_booking_hotel(str(user_b["id"]), name="Other Hotel")

        resp = await client.get(
            "/admin/settings/property",
            headers={
                **get_auth_headers(user_a["token"]),
                "X-Hotel-Id": str(hotel_b["id"]),
            },
        )
        assert resp.status_code == 403

    async def test_nonexistent_hotel_id_returns_403(self, client, hotel_user):
        """X-Hotel-Id that doesn't exist → 403."""
        resp = await client.get(
            "/admin/settings/property",
            headers={
                **get_auth_headers(hotel_user["token"]),
                "X-Hotel-Id": "00000000-0000-0000-0000-000000000000",
            },
        )
        assert resp.status_code == 403


# ── Fallback (no header) ────────────────────────────────────────


class TestNoHeaderFallback:
    async def test_no_header_uses_first_hotel(self, client, cleanup_database):
        """Without X-Hotel-Id, first hotel (by created_at) is selected."""
        user = await create_test_user()
        uid = str(user["id"])
        await create_test_booking_hotel(uid, name="First Hotel")
        await create_test_booking_hotel(uid, name="Second Hotel")

        resp = await client.get(
            "/admin/settings/property",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        assert resp.json()["property_name"] == "First Hotel"

    async def test_no_header_no_hotel_returns_defaults(self, client, hotel_user):
        """No hotels at all → returns default empty settings."""
        resp = await client.get(
            "/admin/settings/property",
            headers=get_auth_headers(hotel_user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["property_name"] == ""
        assert body["timezone"] == "UTC"


# ── Multi-hotel updates ──────────────────────────────────────────


class TestMultiHotelUpdates:
    async def test_patch_updates_correct_hotel(self, client, cleanup_database):
        """PATCH with X-Hotel-Id updates only the targeted hotel."""
        user = await create_test_user()
        uid = str(user["id"])
        hotel_a = await create_test_booking_hotel(uid, name="Hotel Alpha")
        hotel_b = await create_test_booking_hotel(uid, name="Hotel Beta")

        # Update Hotel B's name
        resp = await client.patch(
            "/admin/settings/property",
            json={"property_name": "Hotel Beta Updated"},
            headers={
                **get_auth_headers(user["token"]),
                "X-Hotel-Id": str(hotel_b["id"]),
            },
        )
        assert resp.status_code == 200
        assert resp.json()["property_name"] == "Hotel Beta Updated"

        # Verify Hotel A is unchanged
        resp_a = await client.get(
            "/admin/settings/property",
            headers={
                **get_auth_headers(user["token"]),
                "X-Hotel-Id": str(hotel_a["id"]),
            },
        )
        assert resp_a.json()["property_name"] == "Hotel Alpha"

    async def test_design_patch_with_header(self, client, cleanup_database):
        """PATCH design settings targets the correct hotel."""
        user = await create_test_user()
        uid = str(user["id"])
        hotel = await create_test_booking_hotel(uid, name="Design Hotel")

        resp = await client.patch(
            "/admin/settings/design",
            json={"primary_color": "#FF0000"},
            headers={
                **get_auth_headers(user["token"]),
                "X-Hotel-Id": str(hotel["id"]),
            },
        )
        assert resp.status_code == 200
        assert resp.json()["primary_color"] == "#FF0000"

    async def test_design_patch_wrong_hotel_403(self, client, cleanup_database):
        """PATCH design for another user's hotel → 403."""
        user_a = await create_test_user()
        user_b = await create_test_user()
        hotel_b = await create_test_booking_hotel(str(user_b["id"]))

        resp = await client.patch(
            "/admin/settings/design",
            json={"primary_color": "#000000"},
            headers={
                **get_auth_headers(user_a["token"]),
                "X-Hotel-Id": str(hotel_b["id"]),
            },
        )
        assert resp.status_code == 403

    async def test_design_get_with_header(self, client, cleanup_database):
        """GET design settings with X-Hotel-Id returns correct hotel's design."""
        user = await create_test_user()
        uid = str(user["id"])
        hotel = await create_test_booking_hotel(uid, name="My Hotel")

        resp = await client.get(
            "/admin/settings/design",
            headers={
                **get_auth_headers(user["token"]),
                "X-Hotel-Id": str(hotel["id"]),
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["hero_heading"] == "My Hotel"


# ── Setup status with multi-hotel ────────────────────────────────


class TestSetupStatusMultiHotel:
    async def test_setup_status_with_header(self, client, cleanup_database):
        """Setup status respects X-Hotel-Id."""
        user = await create_test_user()
        uid = str(user["id"])
        hotel = await create_test_booking_hotel(uid, name="Complete Hotel")

        resp = await client.get(
            "/admin/settings/setup-status",
            headers={
                **get_auth_headers(user["token"]),
                "X-Hotel-Id": str(hotel["id"]),
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["setup_complete"] is True

    async def test_setup_status_wrong_header_403(self, client, cleanup_database):
        """Setup status with another user's hotel → 403."""
        user_a = await create_test_user()
        user_b = await create_test_user()
        hotel_b = await create_test_booking_hotel(str(user_b["id"]))

        resp = await client.get(
            "/admin/settings/setup-status",
            headers={
                **get_auth_headers(user_a["token"]),
                "X-Hotel-Id": str(hotel_b["id"]),
            },
        )
        assert resp.status_code == 403


# ── Create new hotel (upsert) ────────────────────────────────────


class TestCreateNewHotelViaPatch:
    async def test_patch_without_hotel_creates_new(self, client, hotel_user):
        """PATCH property without existing hotel creates a new one."""
        resp = await client.patch(
            "/admin/settings/property",
            json={
                "property_name": "Brand New Hotel",
                "reservation_email": "new@hotel.com",
            },
            headers=get_auth_headers(hotel_user["token"]),
        )
        assert resp.status_code == 200
        assert resp.json()["property_name"] == "Brand New Hotel"

        # Now listing hotels should show it
        list_resp = await client.get(
            "/admin/hotels",
            headers=get_auth_headers(hotel_user["token"]),
        )
        assert len(list_resp.json()) == 1
