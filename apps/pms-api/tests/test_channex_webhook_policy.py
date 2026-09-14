from types import SimpleNamespace

import pytest
from app.config import settings
from app.routers import admin_channex
from fastapi import HTTPException


async def _allow_setup(*_args, **_kwargs):
    return None


def _configure_setup(monkeypatch, event_masks="message,booking,review,updated_review"):
    monkeypatch.setattr(admin_channex, "guard_channex_admin_route", _allow_setup)
    monkeypatch.setattr(settings, "CHANNEX_API_KEY", "test-api-key")
    monkeypatch.setattr(settings, "CHANNEX_WEBHOOK_SECRET", "test-webhook-secret")
    monkeypatch.setattr(settings, "CHANNEX_WEBHOOK_EVENT_MASKS", event_masks)


@pytest.mark.asyncio
async def test_webhook_setup_creates_current_c1_event_policy(monkeypatch):
    _configure_setup(monkeypatch)
    created = []

    async def list_webhooks(_api_key):
        return []

    async def create_webhook(api_key, **payload):
        created.append((api_key, payload))
        return {"id": f"webhook-{payload['event_mask']}"}

    monkeypatch.setattr(admin_channex.channex_service, "list_webhooks", list_webhooks)
    monkeypatch.setattr(admin_channex.channex_service, "create_webhook", create_webhook)

    result = await admin_channex.channex_webhook_setup(
        SimpleNamespace(),
        callback_url="https://next-api.vayada.com/webhooks/channex",
        user_id="admin-id",
    )

    assert result["event_masks"] == ["message", "booking", "review", "updated_review"]
    assert [payload["event_mask"] for _, payload in created] == result["event_masks"]
    assert all(api_key == "test-api-key" for api_key, _ in created)
    assert all(payload["is_global"] is True for _, payload in created)
    assert all(payload["send_data"] is True for _, payload in created)
    assert all(payload["is_active"] is True for _, payload in created)
    assert all(
        payload["headers"] == {"X-Vayada-Webhook-Token": "test-webhook-secret"}
        for _, payload in created
    )
    assert [row["status"] for row in result["webhooks"]] == ["created"] * 4


@pytest.mark.asyncio
async def test_webhook_setup_updates_existing_mask_and_creates_missing_mask(monkeypatch):
    _configure_setup(monkeypatch, "message,booking")
    updated = []
    created = []

    async def list_webhooks(_api_key):
        return [
            {
                "id": "legacy-message",
                "attributes": {
                    "callback_url": "https://pms-api.vayada.com/webhooks/channex",
                    "event_mask": "message",
                    "is_global": True,
                },
            }
        ]

    async def update_webhook(api_key, webhook_id, payload):
        updated.append((api_key, webhook_id, payload))
        return {"id": webhook_id}

    async def create_webhook(api_key, **payload):
        created.append((api_key, payload))
        return {"id": "new-booking"}

    monkeypatch.setattr(admin_channex.channex_service, "list_webhooks", list_webhooks)
    monkeypatch.setattr(admin_channex.channex_service, "update_webhook", update_webhook)
    monkeypatch.setattr(admin_channex.channex_service, "create_webhook", create_webhook)

    result = await admin_channex.channex_webhook_setup(
        SimpleNamespace(),
        callback_url="https://next-api.vayada.com/webhooks/channex",
        user_id="admin-id",
    )

    assert updated == [
        (
            "test-api-key",
            "legacy-message",
            {
                "callback_url": "https://next-api.vayada.com/webhooks/channex",
                "event_mask": "message",
                "is_global": True,
                "is_active": True,
                "send_data": True,
                "headers": {"X-Vayada-Webhook-Token": "test-webhook-secret"},
            },
        )
    ]
    assert [payload["event_mask"] for _, payload in created] == ["booking"]
    assert [row["status"] for row in result["webhooks"]] == ["updated", "created"]


@pytest.mark.asyncio
async def test_webhook_setup_supports_message_only_rollback_policy(monkeypatch):
    _configure_setup(monkeypatch, " message, message ")
    updated = []

    async def list_webhooks(_api_key):
        managed_webhooks = [
            {
                "id": event_mask,
                "attributes": {
                    "callback_url": "https://next-api.vayada.com/webhooks/channex",
                    "event_mask": event_mask,
                    "is_global": True,
                    "is_active": True,
                },
            }
            for event_mask in ("message", "booking", "review", "updated_review")
        ]
        return managed_webhooks + [
            {
                "id": "unrelated-global",
                "attributes": {
                    "callback_url": "https://partner.example/webhooks/channex",
                    "event_mask": "booking",
                    "is_global": True,
                    "is_active": True,
                },
            },
            {
                "id": "property-scoped",
                "attributes": {
                    "callback_url": "https://next-api.vayada.com/webhooks/channex",
                    "event_mask": "review",
                    "is_global": False,
                    "is_active": True,
                },
            },
        ]

    async def update_webhook(api_key, webhook_id, payload):
        updated.append((api_key, webhook_id, payload))
        return {"id": webhook_id}

    monkeypatch.setattr(admin_channex.channex_service, "list_webhooks", list_webhooks)
    monkeypatch.setattr(admin_channex.channex_service, "update_webhook", update_webhook)

    result = await admin_channex.channex_webhook_setup(
        SimpleNamespace(),
        callback_url="https://pms-api.vayada.com/webhooks/channex",
        user_id="admin-id",
    )

    assert result["event_masks"] == ["message"]
    assert [(webhook_id, payload) for _, webhook_id, payload in updated[:3]] == [
        ("booking", {"is_active": False}),
        ("review", {"is_active": False}),
        ("updated_review", {"is_active": False}),
    ]
    assert updated[3][1] == "message"
    assert updated[3][2]["callback_url"] == "https://pms-api.vayada.com/webhooks/channex"
    assert updated[3][2]["is_active"] is True
    assert {webhook_id for _, webhook_id, _ in updated} == {
        "message",
        "booking",
        "review",
        "updated_review",
    }
    assert [row["status"] for row in result["webhooks"]] == [
        "disabled",
        "disabled",
        "disabled",
        "updated",
    ]


@pytest.mark.asyncio
async def test_webhook_setup_fails_closed_for_duplicate_global_masks(monkeypatch):
    _configure_setup(monkeypatch, "message,booking")
    updated = []

    async def list_webhooks(_api_key):
        return [
            {"id": "message", "attributes": {"event_mask": "message", "is_global": True}},
            {"id": "one", "attributes": {"event_mask": "booking", "is_global": True}},
            {"id": "two", "attributes": {"event_mask": "booking", "is_global": True}},
        ]

    async def update_webhook(*args):
        updated.append(args)

    monkeypatch.setattr(admin_channex.channex_service, "list_webhooks", list_webhooks)
    monkeypatch.setattr(admin_channex.channex_service, "update_webhook", update_webhook)

    with pytest.raises(HTTPException) as exc_info:
        await admin_channex.channex_webhook_setup(
            SimpleNamespace(),
            callback_url="https://next-api.vayada.com/webhooks/channex",
            user_id="admin-id",
        )

    assert exc_info.value.status_code == 409
    assert "event mask booking" in exc_info.value.detail
    assert updated == []


@pytest.mark.asyncio
async def test_webhook_setup_respects_cutover_guard(monkeypatch):
    sentinel = object()

    async def block_setup(*_args, **_kwargs):
        return sentinel

    monkeypatch.setattr(admin_channex, "guard_channex_admin_route", block_setup)

    result = await admin_channex.channex_webhook_setup(
        SimpleNamespace(),
        callback_url="https://next-api.vayada.com/webhooks/channex",
        user_id="admin-id",
    )

    assert result is sentinel
