"""
Tests for multi-hotel support — GET /admin/hotels, X-Hotel-Id header routing,
fallback behaviour, and cross-hotel isolation.
"""

import json
import uuid
from unittest.mock import AsyncMock, patch

from app.database import Database

from tests.conftest import (
    create_test_booking_hotel,
    create_test_user,
    generate_test_slug,
    get_auth_headers,
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
        assert resp.status_code == 401

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


# ── Duplicate property names (VAY-341) ───────────────────────────


class TestDuplicatePropertyNames:
    """Two unrelated users must be able to launch hotels with identical
    property names — name is not unique, slug is. The setup wizard used
    to 409 on slug collision; now the backend silently disambiguates."""

    async def test_two_users_same_property_name(self, client, cleanup_database):
        user_a = await create_test_user()
        user_b = await create_test_user()
        # Unique-to-this-test name so we don't collide with leftover state
        # from other tests / dev data.
        name = f"Shared Hotel Name {uuid.uuid4().hex[:8]}"
        payload = {
            "property_name": name,
            "reservation_email": "owner@example.com",
        }

        resp_a = await client.post(
            "/admin/hotels",
            json=payload,
            headers=get_auth_headers(user_a["token"]),
        )
        resp_b = await client.post(
            "/admin/hotels",
            json=payload,
            headers=get_auth_headers(user_b["token"]),
        )

        assert resp_a.status_code == 201, resp_a.text
        assert resp_b.status_code == 201, resp_b.text
        assert resp_a.json()["property_name"] == name
        assert resp_b.json()["property_name"] == name
        # Slugs must differ — that's the URL-level uniqueness we still need.
        assert resp_a.json()["slug"] != resp_b.json()["slug"]

    async def test_same_user_same_property_name(self, client, cleanup_database):
        """Same user creating two hotels with the same name also works
        (e.g. franchise owner with two locations sharing a brand name)."""
        user = await create_test_user()
        name = f"My Brand {uuid.uuid4().hex[:8]}"
        payload = {
            "property_name": name,
            "reservation_email": "owner@example.com",
        }

        resp_first = await client.post(
            "/admin/hotels",
            json=payload,
            headers=get_auth_headers(user["token"]),
        )
        resp_second = await client.post(
            "/admin/hotels",
            json=payload,
            headers=get_auth_headers(user["token"]),
        )

        assert resp_first.status_code == 201, resp_first.text
        assert resp_second.status_code == 201, resp_second.text
        assert resp_first.json()["slug"] != resp_second.json()["slug"]


# ── Custom domain on the no-header fallback path (VAY-401) ───────────


class TestCustomDomainNoHeaderFallback:
    """Regression for VAY-401: a single-property owner whose admin UI
    never sets X-Hotel-Id hits the fallback path in get_current_hotel.
    That path must still return a full hotel record (incl. custom_domain),
    otherwise the status endpoint reports "not configured" and remove
    404s, leaving the property permanently stuck on the old domain."""

    async def test_status_and_remove_without_x_hotel_id(self, client, cleanup_database):
        user = await create_test_user()
        uid = str(user["id"])
        hotel = await create_test_booking_hotel(uid, name="Solo Villa")
        domain = "www.villasoleagili.com"
        await Database.execute(
            "UPDATE booking_hotels SET custom_domain = $1 WHERE id = $2",
            domain,
            hotel["id"],
        )

        cf_status = {"status": "active", "ssl_status": "active"}
        with (
            patch(
                "app.routers.admin.custom_domain.cloudflare_service.get_hostname_status",
                new=AsyncMock(return_value=cf_status),
            ),
            patch(
                "app.routers.admin.custom_domain.cloudflare_service.delete_custom_hostname",
                new=AsyncMock(return_value=None),
            ) as mock_delete,
        ):
            # Status must reflect the configured domain even with no header.
            status_resp = await client.get(
                "/admin/settings/custom-domain/status",
                headers=get_auth_headers(user["token"]),
            )
            assert status_resp.status_code == 200
            body = status_resp.json()
            assert body["configured"] is True
            assert body["domain"] == domain

            # Remove must actually clear the mapping, not 404.
            del_resp = await client.delete(
                "/admin/settings/custom-domain",
                headers=get_auth_headers(user["token"]),
            )
            assert del_resp.status_code == 200, del_resp.text
            assert del_resp.json() == {"removed": domain}
            mock_delete.assert_awaited_once_with(domain)

        # DB mapping is gone; subsequent status reports not configured.
        cleared = await Database.fetchval(
            "SELECT custom_domain FROM booking_hotels WHERE id = $1",
            hotel["id"],
        )
        assert cleared is None
