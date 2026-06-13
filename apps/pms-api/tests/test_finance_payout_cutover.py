import json
from unittest.mock import AsyncMock, patch

import pytest
from app.services import finance_payout_cutover as cutover
from fastapi import HTTPException


class _FakeURL:
    path = "/admin/xendit/reconcile-payouts"
    query = ""


class _FakeRequest:
    method = "POST"
    url = _FakeURL()
    headers = {
        "authorization": "Bearer token",
        "host": "legacy.localhost",
        "content-length": "0",
    }


def _reset_modes(monkeypatch):
    monkeypatch.setattr(
        cutover.settings,
        "FINANCE_XENDIT_PAYOUT_RECONCILIATION_LEGACY_MODE",
        "legacy-owned",
    )
    monkeypatch.setattr(cutover.settings, "FINANCE_TARGET_BASE_URL", "")
    monkeypatch.setattr(cutover.settings, "FINANCE_TARGET_TIMEOUT_SECONDS", 10.0)


@pytest.mark.asyncio
async def test_default_legacy_owned_allows_manual_xendit_reconcile(monkeypatch):
    _reset_modes(monkeypatch)

    result = await cutover.guard_xendit_payout_reconciliation_route(
        _FakeRequest(),
        property_id="hotel-686",
    )

    assert result is None


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["disabled", "target-owned"])
async def test_non_mutating_modes_block_legacy_manual_reconcile(monkeypatch, mode):
    _reset_modes(monkeypatch)
    monkeypatch.setattr(cutover.settings, "FINANCE_XENDIT_PAYOUT_RECONCILIATION_LEGACY_MODE", mode)

    with pytest.raises(HTTPException) as exc_info:
        await cutover.guard_xendit_payout_reconciliation_route(
            _FakeRequest(),
            property_id="hotel-686",
        )

    assert exc_info.value.status_code == 423
    assert exc_info.value.detail["mode"] == mode
    assert exc_info.value.detail["scheduler_job"] == "poll_xendit_processing_payouts"


@pytest.mark.asyncio
async def test_proxy_to_target_requires_finance_target_base_url(monkeypatch):
    _reset_modes(monkeypatch)
    monkeypatch.setattr(
        cutover.settings,
        "FINANCE_XENDIT_PAYOUT_RECONCILIATION_LEGACY_MODE",
        "proxy-to-target",
    )

    with pytest.raises(HTTPException) as exc_info:
        await cutover.guard_xendit_payout_reconciliation_route(
            _FakeRequest(),
            property_id="hotel-686",
        )

    assert exc_info.value.status_code == 503
    assert exc_info.value.detail["code"] == "finance_payout_reconciliation_proxy_target_missing"


@pytest.mark.asyncio
async def test_proxy_to_target_forwards_idempotent_reconcile_command(monkeypatch):
    _reset_modes(monkeypatch)
    monkeypatch.setattr(
        cutover.settings,
        "FINANCE_XENDIT_PAYOUT_RECONCILIATION_LEGACY_MODE",
        "proxy-to-target",
    )
    monkeypatch.setattr(cutover.settings, "FINANCE_TARGET_BASE_URL", "https://target.test")
    captured = {}

    class _FakeResponse:
        status_code = 202
        content = json.dumps({"job": {"jobType": "finance.reconcile-payout"}}).encode()
        headers = {"content-type": "application/json"}

    class _FakeClient:
        def __init__(self, timeout):
            captured["timeout"] = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, url, json, headers):
            captured["url"] = url
            captured["json"] = json
            captured["headers"] = headers
            return _FakeResponse()

    monkeypatch.setattr(cutover.httpx, "AsyncClient", _FakeClient)

    response = await cutover.guard_xendit_payout_reconciliation_route(
        _FakeRequest(),
        property_id="hotel-686",
    )

    assert response.status_code == 202
    assert captured["url"] == (
        "https://target.test/api/finance/properties/hotel-686/reconciliation/xendit-payouts"
    )
    assert captured["json"]["commandId"].startswith("legacy-xendit-reconcile-hotel-686-")
    assert captured["json"]["idempotencyKey"] == captured["json"]["commandId"]
    assert captured["json"]["olderThanMinutes"] == 0
    assert captured["headers"] == {"authorization": "Bearer token"}


@pytest.mark.asyncio
async def test_guard_runs_before_legacy_polling(monkeypatch):
    _reset_modes(monkeypatch)
    monkeypatch.setattr(
        cutover.settings,
        "FINANCE_XENDIT_PAYOUT_RECONCILIATION_LEGACY_MODE",
        "disabled",
    )

    with patch(
        "app.repositories.payout_repo.PayoutRepository.list_processing_xendit",
        new_callable=AsyncMock,
    ) as list_processing:
        with pytest.raises(HTTPException):
            await cutover.guard_xendit_payout_reconciliation_route(
                _FakeRequest(),
                property_id="hotel-686",
            )

    list_processing.assert_not_called()
