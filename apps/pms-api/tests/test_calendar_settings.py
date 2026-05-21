"""GET/PATCH /admin/calendar-settings — auto-rearrange opt-out toggle."""
from app.database import Database
from tests.conftest import get_auth_headers


async def _get(client, token):
    return await client.get(
        "/admin/calendar-settings", headers=get_auth_headers(token)
    )


async def _patch(client, token, enabled: bool):
    return await client.patch(
        "/admin/calendar-settings",
        json={"autoRearrangeEnabled": enabled},
        headers=get_auth_headers(token),
    )


class TestCalendarSettings:
    async def test_default_is_enabled_for_new_hotel(
        self, client, hotel_with_rooms
    ):
        token = hotel_with_rooms["user"]["token"]
        resp = await _get(client, token)
        assert resp.status_code == 200, resp.text
        assert resp.json()["autoRearrangeEnabled"] is True

    async def test_patch_disables_then_reads_back(
        self, client, hotel_with_rooms
    ):
        token = hotel_with_rooms["user"]["token"]
        resp = await _patch(client, token, False)
        assert resp.status_code == 200, resp.text
        assert resp.json()["autoRearrangeEnabled"] is False

        # Confirm the column was actually written.
        row = await Database.fetchrow(
            "SELECT auto_rearrange_enabled FROM hotels WHERE id = $1",
            hotel_with_rooms["hotel"]["id"],
        )
        assert row["auto_rearrange_enabled"] is False

        # GET reflects the new state.
        resp = await _get(client, token)
        assert resp.json()["autoRearrangeEnabled"] is False

    async def test_patch_re_enables(self, client, hotel_with_rooms):
        token = hotel_with_rooms["user"]["token"]
        await _patch(client, token, False)
        resp = await _patch(client, token, True)
        assert resp.status_code == 200
        assert resp.json()["autoRearrangeEnabled"] is True

    async def test_requires_auth(self, client, hotel_with_rooms):
        resp = await client.get("/admin/calendar-settings")
        assert resp.status_code == 401
