"""Thin httpx wrapper for server-to-server calls into the PMS backend.

Forwards the user's bearer token + an explicit X-Hotel-Id so PMS can run
its own ownership check on the targeted hotel — keeping the auth model
the same as if the frontend had called PMS directly.
"""

import logging

import httpx

from app.config import settings

logger = logging.getLogger(__name__)


class PmsClientError(Exception):
    """Wraps a non-2xx PMS response with the original status + body."""

    def __init__(self, status_code: int, detail: str):
        super().__init__(f"PMS {status_code}: {detail}")
        self.status_code = status_code
        self.detail = detail


def _headers(auth_header: str, hotel_id: str) -> dict:
    return {"Authorization": auth_header, "X-Hotel-Id": hotel_id}


async def get_deletion_impact(auth_header: str, hotel_id: str) -> dict:
    url = f"{settings.PMS_API_URL}/admin/hotel/deletion-impact"
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(url, headers=_headers(auth_header, hotel_id))
    if resp.status_code >= 400:
        raise PmsClientError(resp.status_code, resp.text)
    return resp.json()


async def delete_hotel(auth_header: str, hotel_id: str) -> dict | None:
    """Delete the PMS-side hotel row. Returns None on 204 success or
    when the row was already gone (404) — both are acceptable
    pre-conditions for the booking-engine cascade that follows."""
    url = f"{settings.PMS_API_URL}/admin/hotel"
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.delete(url, headers=_headers(auth_header, hotel_id))
    if resp.status_code in (204, 404):
        return None
    if resp.status_code >= 400:
        raise PmsClientError(resp.status_code, resp.text)
    return resp.json() if resp.content else None
