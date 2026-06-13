from datetime import UTC, datetime
from enum import StrEnum

import httpx
from fastapi import HTTPException, Request
from fastapi.responses import Response

from app.config import settings


class FinancePayoutReconciliationCutoverMode(StrEnum):
    LEGACY_OWNED = "legacy-owned"
    DISABLED = "disabled"
    PROXY_TO_TARGET = "proxy-to-target"
    TARGET_OWNED = "target-owned"


_HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}


def _normalize_mode(raw_mode: str) -> FinancePayoutReconciliationCutoverMode:
    normalized = raw_mode.strip().lower().replace("_", "-")
    if normalized in {"", "legacy", "legacy-owned"}:
        return FinancePayoutReconciliationCutoverMode.LEGACY_OWNED
    if normalized == "disabled":
        return FinancePayoutReconciliationCutoverMode.DISABLED
    if normalized in {"proxy", "proxy-target", "proxy-to-target"}:
        return FinancePayoutReconciliationCutoverMode.PROXY_TO_TARGET
    if normalized in {"target", "target-owned"}:
        return FinancePayoutReconciliationCutoverMode.TARGET_OWNED

    supported = ", ".join(mode.value for mode in FinancePayoutReconciliationCutoverMode)
    raise HTTPException(
        status_code=500,
        detail={
            "code": "invalid_finance_payout_reconciliation_cutover_mode",
            "mode": raw_mode,
            "message": (
                f"FINANCE_XENDIT_PAYOUT_RECONCILIATION_LEGACY_MODE must be one of: {supported}"
            ),
        },
    )


def finance_payout_reconciliation_cutover_status() -> dict:
    mode = _normalize_mode(settings.FINANCE_XENDIT_PAYOUT_RECONCILIATION_LEGACY_MODE)
    return {
        "route": "POST /admin/xendit/reconcile-payouts",
        "mode": mode.value,
        "target_base_url_configured": bool(settings.FINANCE_TARGET_BASE_URL.strip()),
        "scheduler_job": "poll_xendit_processing_payouts",
        "legacy_disposition": (
            "Matches poll_xendit_processing_payouts: freeze legacy manual reconciliation "
            "when target Xendit payout reconciliation can mutate payout status."
        ),
    }


async def guard_xendit_payout_reconciliation_route(
    request: Request,
    *,
    property_id: str,
) -> Response | None:
    mode = _normalize_mode(settings.FINANCE_XENDIT_PAYOUT_RECONCILIATION_LEGACY_MODE)
    if mode == FinancePayoutReconciliationCutoverMode.LEGACY_OWNED:
        return None
    if mode == FinancePayoutReconciliationCutoverMode.PROXY_TO_TARGET:
        return await _proxy_to_target(request, property_id=property_id)

    message = (
        "Legacy Xendit payout reconciliation is target-owned during cutover; use the "
        "target Finance route or set proxy-to-target mode."
        if mode == FinancePayoutReconciliationCutoverMode.TARGET_OWNED
        else "Legacy Xendit payout reconciliation is disabled during cutover."
    )
    raise HTTPException(
        status_code=423,
        detail={
            "code": "finance_payout_reconciliation_route_guarded",
            "route": "POST /admin/xendit/reconcile-payouts",
            "mode": mode.value,
            "scheduler_job": "poll_xendit_processing_payouts",
            "message": message,
        },
    )


async def _proxy_to_target(request: Request, *, property_id: str) -> Response:
    base_url = settings.FINANCE_TARGET_BASE_URL.strip().rstrip("/")
    if not base_url:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "finance_payout_reconciliation_proxy_target_missing",
                "mode": FinancePayoutReconciliationCutoverMode.PROXY_TO_TARGET.value,
                "message": (
                    "FINANCE_TARGET_BASE_URL must be set before using proxy-to-target mode."
                ),
            },
        )

    target_url = f"{base_url}/api/finance/properties/{property_id}/reconciliation/xendit-payouts"
    headers = {
        key: value
        for key, value in request.headers.items()
        if key.lower() not in _HOP_BY_HOP_HEADERS | {"host", "content-length", "content-type"}
    }
    command_date = datetime.now(UTC).date().isoformat()
    command = {
        "commandId": f"legacy-xendit-reconcile-{property_id}-{command_date}",
        "idempotencyKey": f"legacy-xendit-reconcile-{property_id}-{command_date}",
        "olderThanMinutes": 0,
    }

    try:
        async with httpx.AsyncClient(timeout=settings.FINANCE_TARGET_TIMEOUT_SECONDS) as client:
            proxied = await client.post(target_url, json=command, headers=headers)
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=502,
            detail={
                "code": "finance_payout_reconciliation_proxy_failed",
                "mode": FinancePayoutReconciliationCutoverMode.PROXY_TO_TARGET.value,
                "message": f"Failed to proxy Finance reconciliation request to target: {exc}",
            },
        ) from exc

    response_headers = {
        key: value
        for key, value in proxied.headers.items()
        if key.lower() not in _HOP_BY_HOP_HEADERS | {"content-encoding", "content-length"}
    }
    return Response(
        content=proxied.content,
        status_code=proxied.status_code,
        headers=response_headers,
        media_type=proxied.headers.get("content-type"),
    )
