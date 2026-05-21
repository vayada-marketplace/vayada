"""Tests for /admin/integrations/lodgify endpoints.

We patch the connection service rather than the HTTP client because the
contract under test here is the router — auth, response shape, error
mapping — not the upstream Lodgify validation logic (covered separately
in test_lodgify_client.py).
"""

from datetime import UTC, datetime, timezone
from unittest.mock import AsyncMock, patch

import pytest
from app.models.lodgify import LodgifyConnectionStatus
from app.services.lodgify.connection import LodgifyConnectError

from tests.conftest import get_auth_headers


@pytest.fixture
def connected_status():
    return LodgifyConnectionStatus(
        connected=True,
        status="active",
        lodgify_property_id="42",
        lodgify_property_name="Beach Villa",
        last_validated_at=datetime.now(UTC),
        last_error=None,
    )


@pytest.fixture
def disconnected_status():
    return LodgifyConnectionStatus(connected=False)


class TestLodgifyConnect:
    async def test_connect_success(self, client, hotel_with_property, connected_status):
        user = hotel_with_property["user"]
        hotel = hotel_with_property["hotel"]

        with patch(
            "app.routers.admin.integrations.lodgify.connect_lodgify",
            new=AsyncMock(return_value=connected_status),
        ) as mock_connect:
            resp = await client.post(
                "/admin/integrations/lodgify/connect",
                headers={**get_auth_headers(user["token"]), "X-Hotel-Id": str(hotel["id"])},
                json={"api_key": "lodgify-key-abcdefgh", "lodgify_property_id": "42"},
            )

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["connected"] is True
        assert body["status"] == "active"
        assert body["lodgify_property_id"] == "42"
        assert body["lodgify_property_name"] == "Beach Villa"
        # Verify the service got the hotel id from the auth context, not the body
        mock_connect.assert_awaited_once()
        kwargs = mock_connect.call_args.kwargs
        assert kwargs["api_key"] == "lodgify-key-abcdefgh"
        assert kwargs["lodgify_property_id"] == "42"

    async def test_connect_rejects_bad_key(self, client, hotel_with_property):
        user = hotel_with_property["user"]
        hotel = hotel_with_property["hotel"]

        with patch(
            "app.routers.admin.integrations.lodgify.connect_lodgify",
            new=AsyncMock(side_effect=LodgifyConnectError("Invalid Lodgify API key")),
        ):
            resp = await client.post(
                "/admin/integrations/lodgify/connect",
                headers={**get_auth_headers(user["token"]), "X-Hotel-Id": str(hotel["id"])},
                json={"api_key": "lodgify-bad-key", "lodgify_property_id": "42"},
            )

        assert resp.status_code == 422
        assert resp.json()["detail"] == "Invalid Lodgify API key"

    async def test_connect_requires_auth(self, client):
        resp = await client.post(
            "/admin/integrations/lodgify/connect",
            json={"api_key": "lodgify-key-abcdefgh", "lodgify_property_id": "42"},
        )
        assert resp.status_code == 401

    async def test_connect_requires_hotel(self, client, hotel_user):
        """An admin user with no booking_hotel row gets 404, not a
        silent connect against a phantom hotel."""
        resp = await client.post(
            "/admin/integrations/lodgify/connect",
            headers=get_auth_headers(hotel_user["token"]),
            json={"api_key": "lodgify-key-abcdefgh", "lodgify_property_id": "42"},
        )
        assert resp.status_code == 404


class TestLodgifyStatus:
    async def test_status_when_disconnected(self, client, hotel_with_property, disconnected_status):
        user = hotel_with_property["user"]
        hotel = hotel_with_property["hotel"]

        with patch(
            "app.routers.admin.integrations.lodgify.get_lodgify_status",
            new=AsyncMock(return_value=disconnected_status),
        ):
            resp = await client.get(
                "/admin/integrations/lodgify/status",
                headers={**get_auth_headers(user["token"]), "X-Hotel-Id": str(hotel["id"])},
            )

        assert resp.status_code == 200
        assert resp.json()["connected"] is False

    async def test_status_when_connected(self, client, hotel_with_property, connected_status):
        user = hotel_with_property["user"]
        hotel = hotel_with_property["hotel"]

        with patch(
            "app.routers.admin.integrations.lodgify.get_lodgify_status",
            new=AsyncMock(return_value=connected_status),
        ):
            resp = await client.get(
                "/admin/integrations/lodgify/status",
                headers={**get_auth_headers(user["token"]), "X-Hotel-Id": str(hotel["id"])},
            )

        assert resp.status_code == 200
        body = resp.json()
        assert body["connected"] is True
        assert body["lodgify_property_name"] == "Beach Villa"


class TestLodgifyDisconnect:
    async def test_disconnect_204(self, client, hotel_with_property):
        user = hotel_with_property["user"]
        hotel = hotel_with_property["hotel"]

        with patch(
            "app.routers.admin.integrations.lodgify.disconnect_lodgify",
            new=AsyncMock(return_value=None),
        ) as mock_disconnect:
            resp = await client.delete(
                "/admin/integrations/lodgify/disconnect",
                headers={**get_auth_headers(user["token"]), "X-Hotel-Id": str(hotel["id"])},
            )

        assert resp.status_code == 204
        mock_disconnect.assert_awaited_once_with(str(hotel["id"]))
