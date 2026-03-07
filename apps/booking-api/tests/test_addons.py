"""
Tests for /admin/addons CRUD and /admin/settings/addons display settings.
"""
from tests.conftest import (
    create_test_booking_hotel,
    create_test_user,
    get_auth_headers,
)


class TestListAddons:
    async def test_list_empty(self, client, hotel_with_property):
        user = hotel_with_property["user"]
        resp = await client.get(
            "/admin/addons",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        assert resp.json() == []

    async def test_list_no_hotel_returns_404(self, client, hotel_user):
        resp = await client.get(
            "/admin/addons",
            headers=get_auth_headers(hotel_user["token"]),
        )
        assert resp.status_code == 404

    async def test_list_no_auth(self, client):
        resp = await client.get("/admin/addons")
        assert resp.status_code == 403


class TestCreateAddon:
    async def test_create_success(self, client, hotel_with_property):
        user = hotel_with_property["user"]
        resp = await client.post(
            "/admin/addons",
            json={
                "name": "Airport Transfer",
                "description": "Private car from airport",
                "price": 45.00,
                "currency": "EUR",
                "category": "transport",
            },
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 201
        body = resp.json()
        assert body["name"] == "Airport Transfer"
        assert body["price"] == 45.00
        assert body["category"] == "transport"
        assert "id" in body

    async def test_create_minimal(self, client, hotel_with_property):
        user = hotel_with_property["user"]
        resp = await client.post(
            "/admin/addons",
            json={"name": "Simple Addon", "price": 10.0},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 201
        body = resp.json()
        assert body["name"] == "Simple Addon"
        assert body["currency"] == "EUR"
        assert body["category"] == "experience"

    async def test_create_shows_in_list(self, client, hotel_with_property):
        user = hotel_with_property["user"]
        headers = get_auth_headers(user["token"])

        await client.post(
            "/admin/addons",
            json={"name": "Addon One", "price": 10.0},
            headers=headers,
        )
        await client.post(
            "/admin/addons",
            json={"name": "Addon Two", "price": 20.0},
            headers=headers,
        )

        resp = await client.get("/admin/addons", headers=headers)
        assert resp.status_code == 200
        addons = resp.json()
        assert len(addons) == 2
        names = {a["name"] for a in addons}
        assert "Addon One" in names
        assert "Addon Two" in names


class TestUpdateAddon:
    async def test_update_success(self, client, hotel_with_property):
        user = hotel_with_property["user"]
        headers = get_auth_headers(user["token"])

        create_resp = await client.post(
            "/admin/addons",
            json={"name": "Old Name", "price": 10.0},
            headers=headers,
        )
        addon_id = create_resp.json()["id"]

        resp = await client.patch(
            f"/admin/addons/{addon_id}",
            json={"name": "New Name", "price": 25.0},
            headers=headers,
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["name"] == "New Name"
        assert body["price"] == 25.0

    async def test_update_partial(self, client, hotel_with_property):
        user = hotel_with_property["user"]
        headers = get_auth_headers(user["token"])

        create_resp = await client.post(
            "/admin/addons",
            json={"name": "Spa", "price": 50.0, "category": "wellness"},
            headers=headers,
        )
        addon_id = create_resp.json()["id"]

        resp = await client.patch(
            f"/admin/addons/{addon_id}",
            json={"price": 60.0},
            headers=headers,
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["price"] == 60.0
        assert body["name"] == "Spa"
        assert body["category"] == "wellness"

    async def test_update_not_found(self, client, hotel_with_property):
        user = hotel_with_property["user"]
        resp = await client.patch(
            "/admin/addons/00000000-0000-0000-0000-000000000000",
            json={"name": "X"},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 404


class TestDeleteAddon:
    async def test_delete_success(self, client, hotel_with_property):
        user = hotel_with_property["user"]
        headers = get_auth_headers(user["token"])

        create_resp = await client.post(
            "/admin/addons",
            json={"name": "To Delete", "price": 5.0},
            headers=headers,
        )
        addon_id = create_resp.json()["id"]

        resp = await client.delete(f"/admin/addons/{addon_id}", headers=headers)
        assert resp.status_code == 204

        # Verify it's gone
        list_resp = await client.get("/admin/addons", headers=headers)
        assert all(a["id"] != addon_id for a in list_resp.json())

    async def test_delete_not_found(self, client, hotel_with_property):
        user = hotel_with_property["user"]
        resp = await client.delete(
            "/admin/addons/00000000-0000-0000-0000-000000000000",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 404


class TestAddonSettings:
    async def test_get_defaults(self, client, hotel_with_property):
        user = hotel_with_property["user"]
        resp = await client.get(
            "/admin/settings/addons",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["show_addons_step"] is True
        assert body["group_addons_by_category"] is True

    async def test_update_settings(self, client, hotel_with_property):
        user = hotel_with_property["user"]
        headers = get_auth_headers(user["token"])

        resp = await client.patch(
            "/admin/settings/addons",
            json={"show_addons_step": False},
            headers=headers,
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["show_addons_step"] is False
        assert body["group_addons_by_category"] is True

    async def test_update_both_settings(self, client, hotel_with_property):
        user = hotel_with_property["user"]
        headers = get_auth_headers(user["token"])

        resp = await client.patch(
            "/admin/settings/addons",
            json={"show_addons_step": False, "group_addons_by_category": False},
            headers=headers,
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["show_addons_step"] is False
        assert body["group_addons_by_category"] is False

        # Verify persistence
        get_resp = await client.get("/admin/settings/addons", headers=headers)
        assert get_resp.json()["show_addons_step"] is False
