"""Tests for the Lodgify HTTP client wrapper.

These tests do not hit the network. They drive the client via an
httpx MockTransport so we can assert: retry counts, backoff on 5xx,
rate-limit handling, and auth-error classification.
"""
import httpx
import pytest

from app.services.lodgify.client import (
    DEFAULT_RETRY,
    LodgifyAPIError,
    LodgifyAuthError,
    LodgifyClient,
    RetryPolicy,
)


pytestmark = pytest.mark.asyncio


def _make_client_with_transport(transport: httpx.MockTransport, retry: RetryPolicy = DEFAULT_RETRY) -> LodgifyClient:
    """Patch the per-call httpx.AsyncClient to use a MockTransport."""

    class _FakeAsyncClient(httpx.AsyncClient):
        def __init__(self, *args, **kwargs):
            kwargs["transport"] = transport
            super().__init__(*args, **kwargs)

    client = LodgifyClient(api_key="test-key", hotel_id="h-1", retry=retry, base_url="https://api.lodgify.test")
    # Monkey-patch httpx.AsyncClient inside the module under test.
    import app.services.lodgify.client as mod
    mod.httpx.AsyncClient = _FakeAsyncClient  # type: ignore[attr-defined]
    return client


@pytest.fixture(autouse=True)
def restore_async_client():
    """Always restore the real AsyncClient after each test."""
    import app.services.lodgify.client as mod
    real = httpx.AsyncClient
    yield
    mod.httpx.AsyncClient = real  # type: ignore[attr-defined]


async def test_get_returns_json_on_2xx():
    handler_calls = []

    def handler(req: httpx.Request) -> httpx.Response:
        handler_calls.append(req)
        assert req.headers["X-ApiKey"] == "test-key"
        return httpx.Response(200, json=[{"id": 42, "name": "Beach Villa"}])

    client = _make_client_with_transport(httpx.MockTransport(handler))
    result = await client.get("/v2/properties")
    assert result == [{"id": 42, "name": "Beach Villa"}]
    assert len(handler_calls) == 1


async def test_401_raises_auth_error_without_retry():
    handler_calls = []

    def handler(req: httpx.Request) -> httpx.Response:
        handler_calls.append(req)
        return httpx.Response(401, json={"error": "bad key"})

    client = _make_client_with_transport(httpx.MockTransport(handler))
    with pytest.raises(LodgifyAuthError):
        await client.get("/v2/properties")
    assert len(handler_calls) == 1


async def test_5xx_retries_then_raises():
    handler_calls = []

    def handler(req: httpx.Request) -> httpx.Response:
        handler_calls.append(req)
        return httpx.Response(503, text="upstream down")

    fast = RetryPolicy(max_attempts=3, base_delay_seconds=0.0)
    client = _make_client_with_transport(httpx.MockTransport(handler), retry=fast)
    with pytest.raises(LodgifyAPIError) as exc:
        await client.get("/v2/properties")
    assert exc.value.status_code == 503
    assert len(handler_calls) == 3


async def test_5xx_then_success_returns_payload():
    state = {"calls": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        state["calls"] += 1
        if state["calls"] == 1:
            return httpx.Response(503)
        return httpx.Response(200, json={"ok": True})

    fast = RetryPolicy(max_attempts=3, base_delay_seconds=0.0)
    client = _make_client_with_transport(httpx.MockTransport(handler), retry=fast)
    result = await client.get("/v2/properties")
    assert result == {"ok": True}
    assert state["calls"] == 2


async def test_429_honors_retry_after_then_succeeds():
    state = {"calls": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        state["calls"] += 1
        if state["calls"] == 1:
            return httpx.Response(429, headers={"Retry-After": "0"})
        return httpx.Response(200, json={"ok": True})

    fast = RetryPolicy(max_attempts=3, base_delay_seconds=0.0, rate_limit_fallback_seconds=0.0)
    client = _make_client_with_transport(httpx.MockTransport(handler), retry=fast)
    result = await client.get("/v2/properties")
    assert result == {"ok": True}
    assert state["calls"] == 2


async def test_400_raises_without_retry():
    state = {"calls": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        state["calls"] += 1
        return httpx.Response(400, json={"error": "bad request"})

    client = _make_client_with_transport(httpx.MockTransport(handler))
    with pytest.raises(LodgifyAPIError) as exc:
        await client.get("/v2/properties")
    assert exc.value.status_code == 400
    assert state["calls"] == 1


async def test_missing_api_key_rejected_at_construction():
    with pytest.raises(ValueError):
        LodgifyClient(api_key="")
