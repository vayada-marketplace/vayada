from unittest.mock import patch

import httpx
import pytest
from app.config import settings
from app.routers import webhooks
from fastapi import HTTPException
from starlette.requests import Request


@pytest.mark.parametrize("provider", ["stripe", "channex"])
@pytest.mark.parametrize("target_status", [200, 202, 204, 299, 301, 302, 307, 308, 400, 429, 500])
async def test_relay_acknowledges_only_successful_target_delivery(
    monkeypatch, provider, target_status
):
    target_url = f"https://target.example.com/webhooks/{provider}"
    monkeypatch.setattr(settings, f"PMS_{provider.upper()}_WEBHOOK_TARGET_URL", target_url)
    payload = b'{"id":"synthetic-relay-event"}'
    request = Request({"type": "http", "headers": [(b"content-type", b"application/json")]})
    deliveries = []

    def target(incoming):
        deliveries.append(incoming)
        return httpx.Response(
            target_status,
            headers={"location": "https://redirect.example.com/not-a-webhook"},
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(target))
    with patch.object(webhooks.httpx, "AsyncClient", return_value=client):
        if 200 <= target_status < 300:
            response = await webhooks._non_mutating_webhook_response(
                provider, "proxy_to_target", request, payload
            )
            assert response["status"] == "proxied"
            assert response["target_status"] == target_status
        else:
            with pytest.raises(HTTPException) as error:
                await webhooks._non_mutating_webhook_response(
                    provider, "proxy_to_target", request, payload
                )
            assert error.value.status_code == 502

    assert len(deliveries) == 1
    assert str(deliveries[0].url) == target_url
    assert deliveries[0].content == payload


async def test_relay_timeout_remains_retryable(monkeypatch):
    monkeypatch.setattr(settings, "PMS_CHANNEX_WEBHOOK_TARGET_URL", "https://target.example.com/")
    request = Request({"type": "http", "headers": []})

    def target(incoming):
        raise httpx.ReadTimeout("synthetic timeout", request=incoming)

    client = httpx.AsyncClient(transport=httpx.MockTransport(target))
    with patch.object(webhooks.httpx, "AsyncClient", return_value=client):
        with pytest.raises(HTTPException) as error:
            await webhooks._non_mutating_webhook_response(
                "channex", "proxy_to_target", request, b"{}"
            )
    assert error.value.status_code == 502
