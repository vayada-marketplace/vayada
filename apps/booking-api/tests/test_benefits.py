"""
Tests for /admin/benefits — hotel-level Book Direct Benefits.

Storage moved from pms.hotels.benefits to booking_hotels.benefits in
VAY-157 so that the canonical id used by both admin frontends
(booking_hotels.id) keys the lookup. Previously a pre-unification hotel
where booking_hotels.id != pms.hotels.id silently returned [] for both
the owner and the marketplace superadmin view.
"""

from app.database import AuthDatabase, Database

from tests.conftest import (
    create_test_booking_hotel,
    create_test_user,
    get_auth_headers,
)


async def _make_superadmin(user):
    await AuthDatabase.execute("UPDATE users SET is_superadmin = true WHERE id = $1", user["id"])


class TestGetBenefits:
    async def test_empty_by_default(self, client, hotel_with_property):
        user = hotel_with_property["user"]
        resp = await client.get(
            "/admin/benefits",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        assert resp.json() == {"benefits": []}

    async def test_returns_saved(self, client, hotel_with_property):
        user = hotel_with_property["user"]
        await client.put(
            "/admin/benefits",
            json={"benefits": ["Welcome Drink on Arrival", "Daily Breakfast Included"]},
            headers=get_auth_headers(user["token"]),
        )
        resp = await client.get(
            "/admin/benefits",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.json() == {"benefits": ["Welcome Drink on Arrival", "Daily Breakfast Included"]}

    async def test_no_auth(self, client):
        resp = await client.get("/admin/benefits")
        assert resp.status_code == 401


class TestUpdateBenefits:
    async def test_persists_to_booking_hotels(self, client, hotel_with_property):
        user = hotel_with_property["user"]
        hotel = hotel_with_property["hotel"]
        await client.put(
            "/admin/benefits",
            json={"benefits": ["Welcome Drink on Arrival"]},
            headers=get_auth_headers(user["token"]),
        )
        # Read straight from booking_hotels — should be the canonical store
        row = await Database.fetchrow(
            "SELECT benefits FROM booking_hotels WHERE id = $1", hotel["id"]
        )
        import json

        stored = row["benefits"]
        if isinstance(stored, str):
            stored = json.loads(stored)
        assert stored == ["Welcome Drink on Arrival"]

    async def test_replaces_previous_list(self, client, hotel_with_property):
        user = hotel_with_property["user"]
        await client.put(
            "/admin/benefits",
            json={"benefits": ["Welcome Drink on Arrival", "Free Airport Transfer"]},
            headers=get_auth_headers(user["token"]),
        )
        await client.put(
            "/admin/benefits",
            json={"benefits": ["Daily Breakfast Included"]},
            headers=get_auth_headers(user["token"]),
        )
        resp = await client.get(
            "/admin/benefits",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.json() == {"benefits": ["Daily Breakfast Included"]}

    async def test_custom_string_round_trips(self, client, hotel_with_property):
        """Owner-typed benefits (not in the predefined list) must round-trip
        verbatim — the marketplace admin needs to see them too."""
        user = hotel_with_property["user"]
        await client.put(
            "/admin/benefits",
            json={"benefits": ["Complimentary sunset cocktail"]},
            headers=get_auth_headers(user["token"]),
        )
        resp = await client.get(
            "/admin/benefits",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.json() == {"benefits": ["Complimentary sunset cocktail"]}


class TestSuperadminAcrossOwners:
    """The bug from VAY-157: a superadmin viewing another user's hotel
    in the marketplace admin saw an empty Benefits tab even though the
    owner had saved selections. Reproduces by writing as the owner and
    reading as a superadmin via X-Hotel-Id."""

    async def test_superadmin_sees_owner_benefits(self, client, cleanup_database):
        owner = await create_test_user()
        hotel = await create_test_booking_hotel(str(owner["id"]))

        admin = await create_test_user()
        await _make_superadmin(admin)

        await client.put(
            "/admin/benefits",
            json={"benefits": ["Welcome Drink on Arrival", "Daily Breakfast Included"]},
            headers={
                **get_auth_headers(owner["token"]),
                "X-Hotel-Id": str(hotel["id"]),
            },
        )

        resp = await client.get(
            "/admin/benefits",
            headers={
                **get_auth_headers(admin["token"]),
                "X-Hotel-Id": str(hotel["id"]),
            },
        )
        assert resp.status_code == 200
        assert resp.json() == {"benefits": ["Welcome Drink on Arrival", "Daily Breakfast Included"]}

    async def test_superadmin_writes_visible_to_owner(self, client, cleanup_database):
        owner = await create_test_user()
        hotel = await create_test_booking_hotel(str(owner["id"]))

        admin = await create_test_user()
        await _make_superadmin(admin)

        await client.put(
            "/admin/benefits",
            json={"benefits": ["Free Airport Transfer"]},
            headers={
                **get_auth_headers(admin["token"]),
                "X-Hotel-Id": str(hotel["id"]),
            },
        )

        resp = await client.get(
            "/admin/benefits",
            headers={
                **get_auth_headers(owner["token"]),
                "X-Hotel-Id": str(hotel["id"]),
            },
        )
        assert resp.json() == {"benefits": ["Free Airport Transfer"]}
