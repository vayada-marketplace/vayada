"""
Tests for /admin endpoints — profile, setup status, property settings, design settings.
"""
from tests.conftest import (
    create_test_booking_hotel,
    create_test_user,
    get_auth_headers,
)


class TestAdminMe:
    async def test_me_success(self, client, hotel_user):
        resp = await client.get(
            "/admin/me",
            headers=get_auth_headers(hotel_user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["id"] == str(hotel_user["id"])
        assert body["email"] == hotel_user["email"]
        assert body["name"] == hotel_user["name"]
        assert body["type"] == "hotel"
        assert body["status"] == "verified"
        assert "created_at" in body

    async def test_me_no_auth(self, client):
        resp = await client.get("/admin/me")
        assert resp.status_code == 403

    async def test_me_non_hotel_user(self, client, cleanup_database):
        user = await create_test_user(user_type="admin")
        resp = await client.get(
            "/admin/me",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 403


class TestSetupStatus:
    async def test_setup_status_no_hotel(self, client, hotel_user):
        resp = await client.get(
            "/admin/settings/setup-status",
            headers=get_auth_headers(hotel_user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["setup_complete"] is False
        assert len(body["missing_fields"]) > 0
        assert body["prefill_data"] is None

    async def test_setup_status_fully_set_up(self, client, hotel_with_property):
        user = hotel_with_property["user"]
        resp = await client.get(
            "/admin/settings/setup-status",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["setup_complete"] is True
        assert body["missing_fields"] == []

    async def test_setup_status_partial(self, client, cleanup_database):
        user = await create_test_user()
        # Create a hotel with several fields empty or at default values
        await create_test_booking_hotel(
            str(user["id"]),
            name="Partial Hotel",
            contact_email="",
            contact_phone="",
            contact_address="",
            hero_image="",
            branding_primary_color="",
            branding_accent_color="",
            branding_font_pairing="",
            timezone_val="UTC",
            currency="EUR",
        )
        resp = await client.get(
            "/admin/settings/setup-status",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["setup_complete"] is False
        assert len(body["missing_fields"]) > 0


class TestPropertySettings:
    async def test_get_defaults_no_hotel(self, client, hotel_user):
        resp = await client.get(
            "/admin/settings/property",
            headers=get_auth_headers(hotel_user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["property_name"] == ""
        assert body["reservation_email"] == ""
        assert body["timezone"] == "UTC"
        assert body["default_currency"] == "EUR"

    async def test_get_after_create(self, client, hotel_with_property):
        user = hotel_with_property["user"]
        resp = await client.get(
            "/admin/settings/property",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["property_name"] == "Test Hotel"
        assert body["reservation_email"] == "hotel@test.com"
        assert body["timezone"] == "Europe/Berlin"

    async def test_patch_upsert_creates_hotel(self, client, hotel_user):
        resp = await client.patch(
            "/admin/settings/property",
            json={
                "property_name": "New Hotel",
                "reservation_email": "new@hotel.com",
                "timezone": "America/New_York",
            },
            headers=get_auth_headers(hotel_user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["property_name"] == "New Hotel"
        assert body["reservation_email"] == "new@hotel.com"
        assert body["timezone"] == "America/New_York"

    async def test_patch_update_existing(self, client, hotel_with_property):
        user = hotel_with_property["user"]
        resp = await client.patch(
            "/admin/settings/property",
            json={"property_name": "Updated Hotel Name"},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["property_name"] == "Updated Hotel Name"
        # Other fields should remain unchanged
        assert body["reservation_email"] == "hotel@test.com"

    async def test_patch_currency_persists(self, client, hotel_with_property):
        """Currency change must survive a round-trip (PATCH then GET)."""
        user = hotel_with_property["user"]
        headers = get_auth_headers(user["token"])

        # Update currency
        resp = await client.patch(
            "/admin/settings/property",
            json={"default_currency": "CNY"},
            headers=headers,
        )
        assert resp.status_code == 200
        assert resp.json()["default_currency"] == "CNY"

        # Re-fetch and verify it persisted
        resp = await client.get("/admin/settings/property", headers=headers)
        assert resp.status_code == 200
        assert resp.json()["default_currency"] == "CNY"

    async def test_patch_full_payload_preserves_currency(self, client, hotel_with_property):
        """Sending a full settings payload (as the frontend does) must persist currency."""
        user = hotel_with_property["user"]
        headers = get_auth_headers(user["token"])

        # First get the current settings
        resp = await client.get("/admin/settings/property", headers=headers)
        assert resp.status_code == 200
        settings = resp.json()

        # Change currency and send the full payload back (mimics frontend handleSave)
        settings["default_currency"] = "JPY"
        resp = await client.patch(
            "/admin/settings/property",
            json=settings,
            headers=headers,
        )
        assert resp.status_code == 200
        assert resp.json()["default_currency"] == "JPY"

        # Re-fetch and verify
        resp = await client.get("/admin/settings/property", headers=headers)
        assert resp.status_code == 200
        assert resp.json()["default_currency"] == "JPY"


class TestDesignSettings:
    async def test_get_defaults_no_hotel(self, client, hotel_user):
        resp = await client.get(
            "/admin/settings/design",
            headers=get_auth_headers(hotel_user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["hero_image"] == ""
        assert body["hero_heading"] == ""
        assert body["hero_subtext"] == ""
        assert body["primary_color"] == ""
        assert body["accent_color"] == ""
        assert body["font_pairing"] == ""

    async def test_get_after_create(self, client, hotel_with_property):
        user = hotel_with_property["user"]
        resp = await client.get(
            "/admin/settings/design",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["hero_heading"] == "Test Hotel"
        assert body["primary_color"] == "#336699"

    async def test_patch_success(self, client, hotel_with_property):
        user = hotel_with_property["user"]
        resp = await client.patch(
            "/admin/settings/design",
            json={
                "hero_heading": "Welcome to Paradise",
                "primary_color": "#FF0000",
            },
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["hero_heading"] == "Welcome to Paradise"
        assert body["primary_color"] == "#FF0000"

    async def test_patch_no_hotel(self, client, hotel_user):
        resp = await client.patch(
            "/admin/settings/design",
            json={"hero_heading": "test"},
            headers=get_auth_headers(hotel_user["token"]),
        )
        assert resp.status_code == 404
        assert "No hotel found" in resp.json()["detail"]
