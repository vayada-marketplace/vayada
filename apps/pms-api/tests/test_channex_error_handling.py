"""Channex API error handling — VAY-386.

Channex returns a JSON error body with the actual validation reason, but we
used to call response.raise_for_status() which strips that body and replaces
it with an httpx string that points users at MDN. ChannexAPIError parses the
body and exposes a one-line user-facing summary.
"""

import asyncio
from unittest.mock import patch

import httpx
import pytest
from app.services import channex_service
from app.services.channex_service import (
    ChannexAPIError,
    _request,
    _summarize_channex_errors,
)

# ── _summarize_channex_errors ─────────────────────────────────────────


def test_summary_handles_detail_string():
    body = {"errors": {"detail": "title has already been taken"}}
    assert (
        _summarize_channex_errors("/api/v1/rate_plans", body)
        == "Channex rejected rate_plans: title has already been taken"
    )


def test_summary_handles_per_field_dict():
    body = {"errors": {"title": ["has already been taken"], "occupancy": ["can't be blank"]}}
    summary = _summarize_channex_errors("/api/v1/rate_plans", body)
    # Order of fields in a dict is insertion-stable in py3.7+, so we can
    # assert exact string. Both fields must show up.
    assert "title has already been taken" in summary
    assert "occupancy can't be blank" in summary
    assert summary.startswith("Channex rejected rate_plans:")


def test_summary_handles_list_of_errors():
    body = {"errors": [{"detail": "missing currency"}, {"detail": "bad property_id"}]}
    summary = _summarize_channex_errors("/api/v1/rate_plans", body)
    assert "missing currency" in summary
    assert "bad property_id" in summary


def test_summary_falls_back_to_text_body():
    body = "Internal Server Error\n"
    assert (
        _summarize_channex_errors("/api/v1/rate_plans", body)
        == "Channex rejected rate_plans: Internal Server Error"
    )


def test_summary_unknown_shape_does_not_crash():
    # No `errors` key — we still return a sensible label.
    body = {"unexpected": "shape"}
    summary = _summarize_channex_errors("/api/v1/rate_plans", body)
    assert "rate_plans" in summary
    assert summary == "Channex rejected rate_plans (HTTP error)"


# ── _request raises ChannexAPIError on 4xx ────────────────────────────


class _FakeResponse:
    def __init__(self, status_code: int, body):
        self.status_code = status_code
        self._body = body
        self.text = body if isinstance(body, str) else ""

    def json(self):
        if isinstance(self._body, dict):
            return self._body
        raise ValueError("not json")


class _FakeAsyncClient:
    def __init__(self, response: _FakeResponse):
        self._response = response

    async def request(self, *args, **kwargs):
        return self._response


def test_request_raises_channex_api_error_with_parsed_body():
    response = _FakeResponse(
        422,
        {"errors": {"title": ["has already been taken"]}},
    )

    async def run():
        with (
            patch.object(channex_service, "_get_client", lambda: _FakeAsyncClient(response)),
            patch.object(channex_service.settings, "CHANNEX_API_DELAY_SECONDS", 0),
        ):
            await _request("POST", "/api/v1/rate_plans", "key", json={})

    with pytest.raises(ChannexAPIError) as exc_info:
        asyncio.run(run())

    err = exc_info.value
    assert err.status_code == 422
    assert err.body == {"errors": {"title": ["has already been taken"]}}
    assert "title has already been taken" in err.summary
    # No MDN link, no "Client error '422 Unprocessable Content' for url ..."
    # — that was the unactionable noise the ticket called out.
    assert "developer.mozilla.org" not in err.summary
    assert "Client error" not in err.summary


def test_request_raises_channex_api_error_when_body_is_not_json():
    response = _FakeResponse(500, "Internal Server Error")

    async def run():
        with (
            patch.object(channex_service, "_get_client", lambda: _FakeAsyncClient(response)),
            patch.object(channex_service.settings, "CHANNEX_API_DELAY_SECONDS", 0),
        ):
            await _request("GET", "/api/v1/properties", "key")

    with pytest.raises(ChannexAPIError) as exc_info:
        asyncio.run(run())

    assert exc_info.value.status_code == 500
    assert exc_info.value.body == "Internal Server Error"


def test_request_returns_json_on_2xx():
    response = _FakeResponse(200, {"data": {"id": "abc"}})

    async def run():
        with (
            patch.object(channex_service, "_get_client", lambda: _FakeAsyncClient(response)),
            patch.object(channex_service.settings, "CHANNEX_API_DELAY_SECONDS", 0),
        ):
            return await _request("GET", "/api/v1/properties", "key")

    assert asyncio.run(run()) == {"data": {"id": "abc"}}


# ── create_rate_plan requires options ─────────────────────────────────


def test_create_rate_plan_rejects_missing_options():
    """create_rate_plan used to default to occupancy=2 when options was None,
    which silently masked bugs at the call site (e.g. a single-occupancy
    room getting an invalid 2-person rate plan). VAY-386 makes options
    explicit."""

    async def run():
        await channex_service.create_rate_plan(
            "key",
            property_id="p1",
            room_type_id="rt1",
            title="Some plan",
            options=[],
        )

    with pytest.raises(ValueError, match="occupancy option"):
        asyncio.run(run())
