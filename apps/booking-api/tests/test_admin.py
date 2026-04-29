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


class TestFixedPlanProjection:
    """compute_fixed_plan_projected_fee: €30 base + €5 per extra room (1 included)."""

    def test_zero_rooms(self):
        from app.services.billing_service import compute_fixed_plan_projected_fee
        assert compute_fixed_plan_projected_fee(30, 1, 5, 0) == 30.0

    def test_included_count_only(self):
        from app.services.billing_service import compute_fixed_plan_projected_fee
        # 1 room included → 1 active room → no extras → base only
        assert compute_fixed_plan_projected_fee(30, 1, 5, 1) == 30.0

    def test_scales_with_extras(self):
        from app.services.billing_service import compute_fixed_plan_projected_fee
        # 8 rooms, 1 included → 7 extras × €5 = €35 + €30 base
        assert compute_fixed_plan_projected_fee(30, 1, 5, 8) == 65.0

    def test_no_negative_on_shrink(self):
        from app.services.billing_service import compute_fixed_plan_projected_fee
        # 2 included but 0 active → clamp to base, no refund
        assert compute_fixed_plan_projected_fee(30, 2, 5, 0) == 30.0

    def test_custom_rates(self):
        from app.services.billing_service import compute_fixed_plan_projected_fee
        # Larger hotel on a special deal
        assert compute_fixed_plan_projected_fee(100, 5, 3, 20) == 145.0


class TestBillingPlanSwitch:
    """Setting billing_pending_switch must auto-compute billing_switch_effective_date."""

    async def test_setting_pending_switch_auto_schedules_first_of_next_month(
        self, client, hotel_with_property
    ):
        from datetime import date
        user = hotel_with_property["user"]
        headers = get_auth_headers(user["token"])

        resp = await client.patch(
            "/admin/settings/property",
            json={"billing_pending_switch": "fixed"},
            headers=headers,
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["billing_pending_switch"] == "fixed"

        effective = date.fromisoformat(body["billing_switch_effective_date"])
        today = date.today()
        expected_year = today.year + (1 if today.month == 12 else 0)
        expected_month = 1 if today.month == 12 else today.month + 1
        assert effective == date(expected_year, expected_month, 1)

    async def test_clearing_pending_switch_clears_effective_date(
        self, client, hotel_with_property
    ):
        user = hotel_with_property["user"]
        headers = get_auth_headers(user["token"])

        await client.patch(
            "/admin/settings/property",
            json={"billing_pending_switch": "fixed"},
            headers=headers,
        )
        resp = await client.patch(
            "/admin/settings/property",
            json={"billing_pending_switch": ""},
            headers=headers,
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["billing_pending_switch"] is None
        assert body["billing_switch_effective_date"] is None


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
