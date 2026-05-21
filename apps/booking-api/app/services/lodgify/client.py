"""Async HTTP wrapper for the Lodgify v2 API.

Every outbound call to Lodgify (property list, room sync, reservation
create) goes through this client. Centralizing it means retry, rate-
limit handling, and structured logging are written once instead of
sprinkled across services that don't have the full picture.

Phase 1a only uses ``get('/v2/properties')`` to validate keys at
connect time; the retry/backoff machinery is here because subsequent
phases (rates/availability/booking write-back) need it and they
should not re-invent the wrapper.
"""

import asyncio
import logging
from dataclasses import dataclass
from typing import Any

import httpx

from app.config import settings

logger = logging.getLogger(__name__)


class LodgifyAPIError(Exception):
    """Non-2xx response from Lodgify, with the original status + body
    preserved so callers can branch on auth vs availability vs server
    error without re-parsing httpx exceptions."""

    def __init__(self, status_code: int, detail: str, *, hotel_id: str | None = None):
        super().__init__(f"Lodgify {status_code}: {detail}")
        self.status_code = status_code
        self.detail = detail
        self.hotel_id = hotel_id


class LodgifyAuthError(LodgifyAPIError):
    """401/403 from Lodgify — the API key is invalid or revoked.
    Surfaced to the admin UI as 'reconnect required'."""


@dataclass(frozen=True)
class RetryPolicy:
    """Configured here, not on the call sites, because Lodgify's rate
    limits are key-wide rather than endpoint-wide — backing off on one
    call type protects every other call sharing the same key."""

    max_attempts: int = 3
    base_delay_seconds: float = 0.5
    rate_limit_fallback_seconds: float = 5.0


DEFAULT_RETRY = RetryPolicy()


class LodgifyClient:
    """Per-call instance: takes the API key in the constructor so we
    don't pass it through every method signature. Re-creating the
    client per call is fine — httpx.AsyncClient is cheap and we don't
    do long-lived connection pooling per hotel."""

    def __init__(
        self,
        api_key: str,
        *,
        hotel_id: str | None = None,
        retry: RetryPolicy = DEFAULT_RETRY,
        base_url: str | None = None,
        timeout: float | None = None,
    ):
        if not api_key:
            raise ValueError("Lodgify API key is required")
        self._api_key = api_key
        self._hotel_id = hotel_id
        self._retry = retry
        self._base_url = (base_url or settings.LODGIFY_API_BASE_URL).rstrip("/")
        self._timeout = timeout or settings.LODGIFY_API_TIMEOUT

    @property
    def _headers(self) -> dict:
        return {
            "X-ApiKey": self._api_key,
            "Accept": "application/json",
        }

    async def get(self, path: str, *, params: dict | None = None) -> Any:
        return await self._request("GET", path, params=params)

    async def post(self, path: str, *, json: dict | None = None) -> Any:
        return await self._request("POST", path, json=json)

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict | None = None,
        json: dict | None = None,
    ) -> Any:
        url = f"{self._base_url}{path if path.startswith('/') else '/' + path}"

        last_exc: Exception | None = None
        for attempt in range(1, self._retry.max_attempts + 1):
            try:
                async with httpx.AsyncClient(timeout=self._timeout) as client:
                    resp = await client.request(
                        method,
                        url,
                        headers=self._headers,
                        params=params,
                        json=json,
                    )

                if resp.status_code == 429:
                    delay = _retry_after_seconds(resp, self._retry.rate_limit_fallback_seconds)
                    logger.warning(
                        "lodgify_rate_limited",
                        extra={
                            "hotel_id": self._hotel_id,
                            "path": path,
                            "delay": delay,
                            "attempt": attempt,
                        },
                    )
                    if attempt < self._retry.max_attempts:
                        await asyncio.sleep(delay)
                        continue
                    raise LodgifyAPIError(429, resp.text, hotel_id=self._hotel_id)

                if 500 <= resp.status_code < 600:
                    last_exc = LodgifyAPIError(resp.status_code, resp.text, hotel_id=self._hotel_id)
                    if attempt < self._retry.max_attempts:
                        await asyncio.sleep(self._retry.base_delay_seconds * (2 ** (attempt - 1)))
                        continue
                    raise last_exc

                if resp.status_code in (401, 403):
                    logger.warning(
                        "lodgify_auth_failed",
                        extra={
                            "hotel_id": self._hotel_id,
                            "path": path,
                            "status": resp.status_code,
                        },
                    )
                    raise LodgifyAuthError(resp.status_code, resp.text, hotel_id=self._hotel_id)

                if resp.status_code >= 400:
                    logger.warning(
                        "lodgify_client_error",
                        extra={
                            "hotel_id": self._hotel_id,
                            "path": path,
                            "status": resp.status_code,
                        },
                    )
                    raise LodgifyAPIError(resp.status_code, resp.text, hotel_id=self._hotel_id)

                if not resp.content:
                    return None
                ctype = resp.headers.get("content-type", "")
                if "application/json" in ctype:
                    return resp.json()
                return resp.text

            except (httpx.TimeoutException, httpx.TransportError) as exc:
                # transport errors and timeouts get the same retry treatment as 5xx
                last_exc = exc
                logger.warning(
                    "lodgify_transport_error",
                    extra={
                        "hotel_id": self._hotel_id,
                        "path": path,
                        "attempt": attempt,
                        "error": str(exc),
                    },
                )
                if attempt < self._retry.max_attempts:
                    await asyncio.sleep(self._retry.base_delay_seconds * (2 ** (attempt - 1)))
                    continue
                raise LodgifyAPIError(
                    0, f"Lodgify transport error: {exc}", hotel_id=self._hotel_id
                ) from exc

        # unreachable — every branch above either returns or raises — but keeps the type checker happy
        if last_exc:
            raise last_exc
        raise LodgifyAPIError(
            0, "Lodgify request failed without producing a response", hotel_id=self._hotel_id
        )


def _retry_after_seconds(resp: httpx.Response, fallback: float) -> float:
    raw = resp.headers.get("Retry-After")
    if not raw:
        return fallback
    try:
        return max(float(raw), 0.0)
    except ValueError:
        return fallback
