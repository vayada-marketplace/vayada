"""GET/PUT /admin/check-in-checklist."""

import json

from app.database import Database

from tests.conftest import get_auth_headers


async def _get(client, token):
    return await client.get("/admin/check-in-checklist", headers=get_auth_headers(token))


async def _put(client, token, steps):
    return await client.put(
        "/admin/check-in-checklist",
        json={"steps": steps},
        headers=get_auth_headers(token),
    )


class TestCheckinChecklist:
    async def test_get_returns_editable_defaults_for_new_hotel(self, client, hotel_with_rooms):
        token = hotel_with_rooms["user"]["token"]

        resp = await _get(client, token)

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["updatedAt"] is None
        assert [step["label"] for step in body["steps"]] == [
            "Verify guest IDs / passports",
            "Confirm payment / deposit status",
            "Assign room & hand over keys/access",
        ]
        assert [step["position"] for step in body["steps"]] == [0, 1, 2]
        assert all(step["required"] is True for step in body["steps"])
        assert all(step["system"] is False for step in body["steps"])

    async def test_empty_saved_template_stays_empty(self, client, hotel_with_rooms):
        token = hotel_with_rooms["user"]["token"]

        saved = await _put(client, token, [])
        assert saved.status_code == 200, saved.text
        assert saved.json()["steps"] == []

        resp = await _get(client, token)
        assert resp.status_code == 200
        assert resp.json()["steps"] == []

    async def test_update_normalizes_positions_and_system_flag(self, client, hotel_with_rooms):
        token = hotel_with_rooms["user"]["token"]

        resp = await _put(
            client,
            token,
            [
                {
                    "id": "arrival-tax",
                    "label": "Collect arrival tax",
                    "prompt": "Enter the collected amount.",
                    "type": "amount",
                    "required": False,
                    "system": True,
                    "position": 99,
                }
            ],
        )

        assert resp.status_code == 200, resp.text
        step = resp.json()["steps"][0]
        assert step["position"] == 0
        assert step["system"] is False

        stored = await Database.fetchrow(
            "SELECT steps FROM checkin_checklist_templates WHERE hotel_id = $1",
            hotel_with_rooms["hotel"]["id"],
        )
        assert stored is not None
        steps = json.loads(stored["steps"]) if isinstance(stored["steps"], str) else stored["steps"]
        assert steps[0]["position"] == 0
        assert steps[0]["system"] is False
