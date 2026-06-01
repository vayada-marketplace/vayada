from app.database import Database

from tests.conftest import create_test_hotel, get_auth_headers


async def _get(client, token, hotel_id: str | None = None):
    headers = get_auth_headers(token)
    if hotel_id:
        headers["X-Hotel-Id"] = hotel_id
    return await client.get("/admin/module-activations", headers=headers)


async def _patch(client, token, module_id: str, is_active: bool, hotel_id: str | None = None):
    headers = get_auth_headers(token)
    if hotel_id:
        headers["X-Hotel-Id"] = hotel_id
    return await client.patch(
        f"/admin/module-activations/{module_id}",
        json={"moduleId": module_id, "isActive": is_active},
        headers=headers,
    )


class TestModuleActivations:
    async def test_new_property_defaults_to_no_active_modules(self, client, hotel_user):
        hotel = await create_test_hotel(str(hotel_user["id"]))

        resp = await _get(client, hotel_user["token"])

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["hotelId"] == str(hotel["id"])
        assert body["activeModules"] == []
        assert body["activations"] == []

    async def test_activation_persists_and_reads_back(self, client, hotel_user):
        hotel = await create_test_hotel(str(hotel_user["id"]))
        token = hotel_user["token"]

        activate = await _patch(client, token, "financials", True)

        assert activate.status_code == 200, activate.text
        assert activate.json()["moduleId"] == "financials"
        assert activate.json()["isActive"] is True
        assert activate.json()["activatedAt"] is not None
        assert activate.json()["deactivatedAt"] is None

        row = await Database.fetchrow(
            """
            SELECT is_active
            FROM property_module_activations
            WHERE hotel_id = $1 AND module_id = 'financials'
            """,
            hotel["id"],
        )
        assert row["is_active"] is True

        resp = await _get(client, token)
        assert resp.json()["activeModules"] == ["financials"]

    async def test_deactivation_preserves_row_and_sets_deactivated_at(self, client, hotel_user):
        await create_test_hotel(str(hotel_user["id"]))
        token = hotel_user["token"]
        await _patch(client, token, "inbox", True)

        deactivate = await _patch(client, token, "inbox", False)

        assert deactivate.status_code == 200, deactivate.text
        body = deactivate.json()
        assert body["moduleId"] == "inbox"
        assert body["isActive"] is False
        assert body["activatedAt"] is None
        assert body["deactivatedAt"] is not None

        resp = await _get(client, token)
        assert resp.json()["activeModules"] == []
        assert resp.json()["activations"][0]["moduleId"] == "inbox"

    async def test_activation_state_is_scoped_by_selected_hotel_header(
        self,
        client,
        hotel_user,
    ):
        user = hotel_user
        first_hotel = await create_test_hotel(str(user["id"]))
        second_hotel = await create_test_hotel(str(user["id"]))

        await _patch(client, user["token"], "affiliates", True, str(first_hotel["id"]))

        first = await _get(client, user["token"], str(first_hotel["id"]))
        second = await _get(client, user["token"], str(second_hotel["id"]))

        assert first.json()["activeModules"] == ["affiliates"]
        assert second.json()["activeModules"] == []

    async def test_requires_auth(self, client):
        resp = await client.get("/admin/module-activations")
        assert resp.status_code == 401
