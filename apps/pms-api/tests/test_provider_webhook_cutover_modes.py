import hashlib
import hmac
import json
import time
from unittest.mock import AsyncMock, patch

import httpx
import pytest
from app.config import settings
from app.main import health
from app.routers import webhooks
from fastapi import HTTPException
from starlette.requests import Request
from stripe import SignatureVerificationError


def _request(path: str, payload: bytes, headers: dict[str, str]) -> Request:
    scope = {
        "type": "http",
        "method": "POST",
        "path": path,
        "headers": [(key.lower().encode(), value.encode()) for key, value in headers.items()],
    }

    async def receive():
        return {"type": "http.request", "body": payload, "more_body": False}

    return Request(scope, receive)


def _set_mode(monkeypatch: pytest.MonkeyPatch, provider: str, mode: str) -> None:
    monkeypatch.setattr(settings, f"PMS_LEGACY_{provider.upper()}_WEBHOOK_MODE", mode)
    monkeypatch.setattr(
        settings,
        f"PMS_{provider.upper()}_WEBHOOK_TARGET_URL",
        f"https://target.example.com/webhooks/{provider}",
    )


@pytest.mark.parametrize("mode", ["ack_only_with_receipt", "proxy_to_target"])
async def test_stripe_cutover_modes_skip_legacy_mutation(monkeypatch, mode):
    _set_mode(monkeypatch, "stripe", mode)
    request = _request("/webhooks/stripe", b"{}", {"stripe-signature": "sig-test"})

    with (
        patch.object(
            webhooks.stripe_service,
            "construct_webhook_event",
            return_value={
                "type": "payment_intent.amount_capturable_updated",
                "data": {"object": {"id": "pi_cutover"}},
            },
        ),
        patch.object(
            webhooks,
            "_materialize_or_get_booking_for_pi",
            new_callable=AsyncMock,
        ) as materialize,
        patch.object(webhooks.PaymentRepository, "update_status", new_callable=AsyncMock) as update,
        patch.object(
            webhooks,
            "_proxy_provider_webhook_to_target",
            new_callable=AsyncMock,
        ) as proxy,
    ):
        proxy.return_value = {"status": "proxied", "mode": "proxy_to_target", "provider": "stripe"}
        response = await webhooks.stripe_webhook(request)

    assert response["mode"] == mode
    assert response["provider"] == "stripe"
    assert response["receipt"].startswith("legacy:stripe:")
    materialize.assert_not_called()
    update.assert_not_called()
    if mode == "proxy_to_target":
        proxy.assert_awaited_once()
    else:
        proxy.assert_not_called()


async def test_connect_webhook_uses_its_own_signing_secret(monkeypatch):
    _set_mode(monkeypatch, "stripe", "ack_only_with_receipt")
    monkeypatch.setattr(settings, "STRIPE_WEBHOOK_SECRET", "whsec_platform")
    monkeypatch.setattr(settings, "STRIPE_CONNECT_WEBHOOK_SECRET", "whsec_connect")
    request = _request("/webhooks/stripe/connect", b"{}", {"stripe-signature": "sig-test"})

    with patch.object(
        webhooks.stripe_service,
        "construct_webhook_event",
        return_value={
            "type": "payment_intent.succeeded",
            "data": {"object": {"id": "pi_connect"}},
        },
    ) as construct:
        response = await webhooks.stripe_connect_webhook(request)

    assert response["mode"] == "ack_only_with_receipt"
    construct.assert_called_once_with(b"{}", "sig-test", "whsec_connect")


@pytest.mark.parametrize("mode", ["ack_only_with_receipt", "proxy_to_target"])
async def test_fixed_plan_webhook_stays_local_during_cutover(monkeypatch, mode):
    _set_mode(monkeypatch, "stripe", mode)
    request = _request("/webhooks/stripe", b"{}", {"stripe-signature": "sig-test"})
    event = {
        "id": "evt_fixed_paid",
        "type": "invoice.paid",
        "data": {
            "object": {
                "subscription": "sub_fixed",
                "metadata": {
                    "hotel_id": "hotel-1",
                    "vayada_payment_kind": "fixed_plan",
                },
            }
        },
    }

    with (
        patch.object(webhooks.stripe_service, "construct_webhook_event", return_value=event),
        patch.object(
            webhooks.HotelPaymentSettingsRepository,
            "claim_billing_webhook_event",
            new=AsyncMock(return_value="claimed"),
        ),
        patch.object(
            webhooks.HotelPaymentSettingsRepository,
            "complete_billing_webhook_event",
            new=AsyncMock(),
        ),
        patch.object(
            webhooks.fixed_plan_billing,
            "activate_subscription",
            new=AsyncMock(),
        ) as activate,
        patch.object(
            webhooks,
            "_proxy_provider_webhook_to_target",
            new_callable=AsyncMock,
        ) as proxy,
    ):
        response = await webhooks.stripe_webhook(request)

    assert response == {"status": "ok"}
    activate.assert_awaited_once_with("hotel-1", "sub_fixed")
    proxy.assert_not_awaited()


async def test_fixed_plan_failed_renewal_notifies_vayada_and_keeps_subscription():
    request = _request("/webhooks/stripe", b"{}", {"stripe-signature": "sig-test"})
    event = {
        "id": "evt_fixed_failed",
        "type": "invoice.payment_failed",
        "data": {
            "object": {
                "subscription": "sub_fixed",
                "metadata": {
                    "hotel_id": "hotel-1",
                    "vayada_payment_kind": "fixed_plan",
                },
            }
        },
    }
    payment_settings = {
        "hotel_id": "hotel-1",
        "stripe_billing_status": "active",
    }

    with (
        patch.object(webhooks.stripe_service, "construct_webhook_event", return_value=event),
        patch.object(
            webhooks.HotelPaymentSettingsRepository,
            "claim_billing_webhook_event",
            new=AsyncMock(return_value="claimed"),
        ),
        patch.object(
            webhooks.HotelPaymentSettingsRepository,
            "complete_billing_webhook_event",
            new=AsyncMock(),
        ),
        patch.object(
            webhooks.fixed_plan_billing,
            "mark_payment_failed",
            new=AsyncMock(return_value=payment_settings),
        ) as mark_failed,
        patch.object(
            webhooks.hotel_identity_service,
            "get_name",
            new=AsyncMock(return_value="Hotel Test"),
        ),
        patch.object(
            webhooks,
            "send_fixed_plan_payment_failed_notification",
            new=AsyncMock(),
        ) as notify,
        patch.object(
            webhooks.fixed_plan_billing,
            "end_subscription",
            new=AsyncMock(),
        ) as end_subscription,
    ):
        response = await webhooks.stripe_webhook(request)

    assert response == {"status": "ok"}
    mark_failed.assert_awaited_once_with("sub_fixed")
    notify.assert_awaited_once_with(
        hotel_id="hotel-1",
        hotel_name="Hotel Test",
        subscription_id="sub_fixed",
    )
    end_subscription.assert_not_awaited()


async def test_deleted_fixed_plan_subscription_reverts_to_commission():
    request = _request("/webhooks/stripe", b"{}", {"stripe-signature": "sig-test"})
    event = {
        "id": "evt_fixed_deleted",
        "type": "customer.subscription.deleted",
        "data": {
            "object": {
                "id": "sub_fixed",
                "metadata": {
                    "hotel_id": "hotel-1",
                    "vayada_payment_kind": "fixed_plan",
                },
            }
        },
    }

    with (
        patch.object(webhooks.stripe_service, "construct_webhook_event", return_value=event),
        patch.object(
            webhooks.HotelPaymentSettingsRepository,
            "claim_billing_webhook_event",
            new=AsyncMock(return_value="claimed"),
        ),
        patch.object(
            webhooks.HotelPaymentSettingsRepository,
            "complete_billing_webhook_event",
            new=AsyncMock(),
        ),
        patch.object(
            webhooks.fixed_plan_billing,
            "end_subscription",
            new=AsyncMock(),
        ) as end_subscription,
    ):
        response = await webhooks.stripe_webhook(request)

    assert response == {"status": "ok"}
    end_subscription.assert_awaited_once_with("sub_fixed", "hotel-1")


async def test_in_progress_fixed_plan_event_returns_retryable_error():
    with patch.object(
        webhooks.HotelPaymentSettingsRepository,
        "claim_billing_webhook_event",
        new=AsyncMock(return_value="in_progress"),
    ):
        with pytest.raises(HTTPException) as exc_info:
            await webhooks._handle_fixed_plan_event(
                {"id": "evt_in_progress"},
                "invoice.paid",
                {"subscription": "sub_fixed"},
                "hotel-1",
                "sub_fixed",
            )

    assert exc_info.value.status_code == 503


@pytest.mark.parametrize("mode", ["ack_only_with_receipt", "proxy_to_target"])
async def test_xendit_cutover_modes_skip_legacy_mutation(monkeypatch, mode):
    _set_mode(monkeypatch, "xendit", mode)
    payload = json.dumps(
        {"event": "payout.succeeded", "data": {"id": "disb_cutover", "status": "SUCCEEDED"}}
    ).encode()
    request = _request(
        "/webhooks/xendit",
        payload,
        {
            "x-callback-token": settings.XENDIT_WEBHOOK_SECRET,
            "content-type": "application/json",
        },
    )

    with (
        patch.object(webhooks.PayoutRepository, "update_status", new_callable=AsyncMock) as update,
        patch.object(
            webhooks,
            "_proxy_provider_webhook_to_target",
            new_callable=AsyncMock,
        ) as proxy,
    ):
        proxy.return_value = {"status": "proxied", "mode": "proxy_to_target", "provider": "xendit"}
        response = await webhooks.xendit_webhook(request)

    assert response["mode"] == mode
    assert response["provider"] == "xendit"
    assert response["receipt"].startswith("legacy:xendit:")
    update.assert_not_called()
    if mode == "proxy_to_target":
        proxy.assert_awaited_once()
    else:
        proxy.assert_not_called()


@pytest.mark.parametrize("mode", ["ack_only_with_receipt", "proxy_to_target"])
async def test_channex_cutover_modes_skip_legacy_receipt_and_processing(monkeypatch, mode):
    _set_mode(monkeypatch, "channex", mode)
    monkeypatch.setattr(settings, "CHANNEX_WEBHOOK_SECRET", "channex-secret")
    payload = json.dumps(
        {
            "event": "message",
            "property_id": "prop-cutover",
            "payload": {"property_id": "prop-cutover", "message_thread_id": "thread-1"},
        }
    ).encode()
    request = _request(
        "/webhooks/channex",
        payload,
        {
            "x-vayada-webhook-token": "channex-secret",
            "content-type": "application/json",
        },
    )

    with (
        patch.object(
            webhooks.ChannexWebhookEventRepository,
            "insert",
            new_callable=AsyncMock,
        ) as insert,
        patch.object(
            webhooks.ChannexWebhookEventRepository,
            "mark_processed",
            new_callable=AsyncMock,
        ) as mark_processed,
        patch(
            "app.services.channex.messaging.process_inbound_message_event",
            new_callable=AsyncMock,
        ) as process,
        patch.object(
            webhooks,
            "_proxy_provider_webhook_to_target",
            new_callable=AsyncMock,
        ) as proxy,
    ):
        insert.return_value = "channex-receipt-1"
        proxy.return_value = {"status": "proxied", "mode": "proxy_to_target", "provider": "channex"}
        response = await webhooks.channex_webhook(request)

    assert response["mode"] == mode
    assert response["provider"] == "channex"
    assert response["receipt"].startswith("legacy:channex:")
    insert.assert_not_called()
    mark_processed.assert_not_called()
    process.assert_not_called()
    if mode == "proxy_to_target":
        proxy.assert_awaited_once()
    else:
        proxy.assert_not_called()


async def test_health_exposes_provider_webhook_cutover_modes(monkeypatch):
    _set_mode(monkeypatch, "stripe", "ack_only_with_receipt")
    _set_mode(monkeypatch, "xendit", "proxy_to_target")
    _set_mode(monkeypatch, "channex", "mutating")

    response = await health()

    modes = response["cutover"]["legacyProviderWebhooks"]
    assert modes["stripe"]["mode"] == "ack_only_with_receipt"
    assert modes["xendit"]["mode"] == "proxy_to_target"
    assert modes["channex"]["mode"] == "mutating"
    assert modes["xendit"]["proxyTargetConfigured"] is True


def _stripe_signature(payload: bytes, secret: str) -> str:
    timestamp = str(int(time.time()))
    signature = hmac.new(
        secret.encode(), timestamp.encode() + b"." + payload, hashlib.sha256
    ).hexdigest()
    return f"t={timestamp},v1={signature}"


@pytest.mark.parametrize("connect", [False, True])
@pytest.mark.parametrize("explicit_target", [False, True])
async def test_stripe_proxy_preserves_endpoint_and_signed_bytes(
    monkeypatch, connect, explicit_target
):
    _set_mode(monkeypatch, "stripe", "proxy_to_target")
    monkeypatch.setattr(settings, "STRIPE_WEBHOOK_SECRET", "whsec_platform_synthetic")
    monkeypatch.setattr(settings, "STRIPE_CONNECT_WEBHOOK_SECRET", "whsec_connect_synthetic")
    monkeypatch.setattr(settings, "PMS_WEBHOOK_TARGET_BASE_URL", "https://target.example.com/")
    monkeypatch.setattr(settings, "PMS_STRIPE_CONNECT_WEBHOOK_TARGET_URL", "")
    # Keep a conflicting platform override even when Connect uses the base URL.
    monkeypatch.setattr(
        settings, "PMS_STRIPE_WEBHOOK_TARGET_URL", "https://platform.example.com/hook"
    )
    endpoint = "stripe/connect" if connect else "stripe"
    secret = settings.STRIPE_CONNECT_WEBHOOK_SECRET if connect else settings.STRIPE_WEBHOOK_SECRET
    other_secret = (
        settings.STRIPE_WEBHOOK_SECRET if connect else settings.STRIPE_CONNECT_WEBHOOK_SECRET
    )
    expected_url = (
        "https://target.example.com/webhooks/stripe/connect"
        if connect
        else settings.PMS_STRIPE_WEBHOOK_TARGET_URL
    )
    if explicit_target:
        expected_url = f"https://explicit.example.com/webhooks/{endpoint}"
        monkeypatch.setattr(
            settings,
            "PMS_STRIPE_CONNECT_WEBHOOK_TARGET_URL" if connect else "PMS_STRIPE_WEBHOOK_TARGET_URL",
            expected_url,
        )
    payload = b'{ "id": "evt_synthetic", "type": "payment_intent.succeeded", "data": {"object": {"id": "pi_synthetic"}} }'
    signature = _stripe_signature(payload, secret)
    request = _request(
        f"/webhooks/{endpoint}",
        payload,
        {
            "stripe-signature": signature,
            "host": "legacy.example.com",
            "content-type": "application/json",
        },
    )
    forwarded = []

    def target(incoming):
        forwarded.append(incoming)
        assert str(incoming.url) == expected_url
        assert incoming.headers["host"] != "legacy.example.com"
        assert incoming.content == payload
        assert incoming.headers["stripe-signature"] == signature
        assert (
            webhooks.stripe_service.construct_webhook_event(
                incoming.content,
                incoming.headers["stripe-signature"],
                secret,
            )["id"]
            == "evt_synthetic"
        )
        with pytest.raises(SignatureVerificationError):
            webhooks.stripe_service.construct_webhook_event(
                incoming.content, signature, other_secret
            )
        return httpx.Response(200)

    client = httpx.AsyncClient(transport=httpx.MockTransport(target))
    with (
        patch.object(webhooks.httpx, "AsyncClient", return_value=client),
        patch.object(
            webhooks, "_materialize_or_get_booking_for_pi", new_callable=AsyncMock
        ) as mutate,
    ):
        handler = webhooks.stripe_connect_webhook if connect else webhooks.stripe_webhook
        response = await handler(request)

    assert len(forwarded) == 1
    assert response["provider"] == "stripe"
    assert response["mode"] == "proxy_to_target"
    mutate.assert_not_awaited()


async def test_connect_proxy_does_not_fall_back_to_platform_target(monkeypatch):
    _set_mode(monkeypatch, "stripe", "proxy_to_target")
    monkeypatch.setattr(settings, "STRIPE_CONNECT_WEBHOOK_SECRET", "whsec_connect_synthetic")
    monkeypatch.setattr(
        settings, "PMS_STRIPE_WEBHOOK_TARGET_URL", "https://platform.example.com/hook"
    )
    monkeypatch.setattr(settings, "PMS_WEBHOOK_TARGET_BASE_URL", "")
    monkeypatch.setattr(settings, "PMS_STRIPE_CONNECT_WEBHOOK_TARGET_URL", "")
    payload = b'{"type":"test.synthetic","data":{"object":{}}}'
    request = _request(
        "/webhooks/stripe/connect",
        payload,
        {
            "stripe-signature": _stripe_signature(payload, settings.STRIPE_CONNECT_WEBHOOK_SECRET),
        },
    )
    with patch.object(webhooks.httpx, "AsyncClient") as client:
        with pytest.raises(HTTPException) as error:
            await webhooks.stripe_connect_webhook(request)
    assert error.value.status_code == 503
    client.assert_not_called()


@pytest.mark.parametrize("connect", [False, True])
async def test_stripe_proxy_rejects_other_endpoint_signature_before_forwarding(
    monkeypatch, connect
):
    _set_mode(monkeypatch, "stripe", "proxy_to_target")
    monkeypatch.setattr(settings, "STRIPE_WEBHOOK_SECRET", "whsec_platform_synthetic")
    monkeypatch.setattr(settings, "STRIPE_CONNECT_WEBHOOK_SECRET", "whsec_connect_synthetic")
    payload = b'{"type":"test.synthetic","data":{"object":{}}}'
    other_secret = (
        settings.STRIPE_WEBHOOK_SECRET if connect else settings.STRIPE_CONNECT_WEBHOOK_SECRET
    )
    request = _request(
        "/webhooks/stripe/connect" if connect else "/webhooks/stripe",
        payload,
        {
            "stripe-signature": _stripe_signature(payload, other_secret),
        },
    )
    with patch.object(webhooks.httpx, "AsyncClient") as client:
        with pytest.raises(HTTPException) as error:
            handler = webhooks.stripe_connect_webhook if connect else webhooks.stripe_webhook
            await handler(request)
    assert error.value.status_code == 400
    client.assert_not_called()
