"""
Tests for /admin/benefits — hotel-level Book Direct Benefits.
"""

from app.database import Database

from tests.conftest import (
    get_auth_headers,
)


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


