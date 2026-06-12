from dataclasses import dataclass
from enum import StrEnum

import httpx
from fastapi import HTTPException, Request
from fastapi.responses import Response

from app.config import settings


class ChannexAdminCutoverMode(StrEnum):
    LEGACY_OWNED = "legacy-owned"
    READ_ONLY = "read-only"
    DISABLED = "disabled"
    PROXY_TO_TARGET = "proxy-to-target"
    TARGET_OWNED = "target-owned"


class ChannexAdminRouteGroup(StrEnum):
    READ_MODEL = "read-model"
    ENABLE_DISABLE = "enable-disable"
    PROVISIONING = "provisioning"
    MARKUPS = "markups"
    MANUAL_ARI_SYNC = "manual-ari-sync"
    MANUAL_BOOKING_SYNC = "manual-booking-sync"
    MESSAGING = "messaging"
    IFRAME_URL = "iframe-url"
    WEBHOOK_SETUP = "webhook-setup"


@dataclass(frozen=True)
class _RouteGroupConfig:
    group: ChannexAdminRouteGroup
    env_var: str
    description: str


ROUTE_GROUP_CONFIGS = (
    _RouteGroupConfig(
        ChannexAdminRouteGroup.READ_MODEL,
        "CHANNEX_ADMIN_READ_MODEL_MODE",
        "status, mappings, channels, markup reads, and webhook event summaries",
    ),
    _RouteGroupConfig(
        ChannexAdminRouteGroup.ENABLE_DISABLE,
        "CHANNEX_ADMIN_ENABLE_DISABLE_MODE",
        "enable and disable legacy Channex connections",
    ),
    _RouteGroupConfig(
        ChannexAdminRouteGroup.PROVISIONING,
        "CHANNEX_ADMIN_PROVISIONING_MODE",
        "legacy Channex property, room type, and rate plan provisioning",
    ),
    _RouteGroupConfig(
        ChannexAdminRouteGroup.MARKUPS,
        "CHANNEX_ADMIN_MARKUPS_MODE",
        "channel markup writes and their provisioning/ARI side effects",
    ),
    _RouteGroupConfig(
        ChannexAdminRouteGroup.MANUAL_ARI_SYNC,
        "CHANNEX_ADMIN_MANUAL_ARI_SYNC_MODE",
        "manual full ARI push",
    ),
    _RouteGroupConfig(
        ChannexAdminRouteGroup.MANUAL_BOOKING_SYNC,
        "CHANNEX_ADMIN_MANUAL_BOOKING_SYNC_MODE",
        "manual Channex booking feed poll",
    ),
    _RouteGroupConfig(
        ChannexAdminRouteGroup.MESSAGING,
        "CHANNEX_ADMIN_MESSAGING_MODE",
        "messaging app install and backfill",
    ),
    _RouteGroupConfig(
        ChannexAdminRouteGroup.IFRAME_URL,
        "CHANNEX_ADMIN_IFRAME_URL_MODE",
        "Channex channel-management iframe URL creation",
    ),
    _RouteGroupConfig(
        ChannexAdminRouteGroup.WEBHOOK_SETUP,
        "CHANNEX_ADMIN_WEBHOOK_SETUP_MODE",
        "global Channex webhook setup and endpoint updates",
    ),
)

_GROUP_CONFIGS_BY_GROUP = {config.group: config for config in ROUTE_GROUP_CONFIGS}
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


def _normalize_mode(raw_mode: str, *, env_var: str) -> ChannexAdminCutoverMode:
    normalized = raw_mode.strip().lower().replace("_", "-")
    if normalized in {"", "legacy", "legacy-owned", "legacy-owned-mode"}:
        return ChannexAdminCutoverMode.LEGACY_OWNED
    if normalized in {"readonly", "read-only"}:
        return ChannexAdminCutoverMode.READ_ONLY
    if normalized == "disabled":
        return ChannexAdminCutoverMode.DISABLED
    if normalized in {"proxy", "proxy-target", "proxy-to-target"}:
        return ChannexAdminCutoverMode.PROXY_TO_TARGET
    if normalized in {"target", "target-owned"}:
        return ChannexAdminCutoverMode.TARGET_OWNED

    supported = ", ".join(mode.value for mode in ChannexAdminCutoverMode)
    raise HTTPException(
        status_code=500,
        detail={
            "code": "invalid_channex_admin_cutover_mode",
            "env_var": env_var,
            "mode": raw_mode,
            "message": f"{env_var} must be one of: {supported}",
        },
    )


def mode_for_group(group: ChannexAdminRouteGroup) -> ChannexAdminCutoverMode:
    config = _GROUP_CONFIGS_BY_GROUP[group]
    raw_group_mode = getattr(settings, config.env_var, "")
    raw_mode = raw_group_mode or settings.CHANNEX_ADMIN_DEFAULT_MODE
    env_var = config.env_var if raw_group_mode else "CHANNEX_ADMIN_DEFAULT_MODE"
    return _normalize_mode(raw_mode, env_var=env_var)


def describe_channex_admin_cutover_modes() -> dict:
    modes = []
    for config in ROUTE_GROUP_CONFIGS:
        raw_group_mode = getattr(settings, config.env_var, "")
        effective_source = config.env_var if raw_group_mode else "CHANNEX_ADMIN_DEFAULT_MODE"
        modes.append(
            {
                "group": config.group.value,
                "mode": mode_for_group(config.group).value,
                "env_var": config.env_var,
                "source": effective_source,
                "description": config.description,
            }
        )
    return {
        "default_mode": _normalize_mode(
            settings.CHANNEX_ADMIN_DEFAULT_MODE,
            env_var="CHANNEX_ADMIN_DEFAULT_MODE",
        ).value,
        "target_base_url_configured": bool(settings.CHANNEX_ADMIN_TARGET_BASE_URL.strip()),
        "modes": modes,
    }


async def guard_channex_admin_route(
    group: ChannexAdminRouteGroup,
    request: Request,
    *,
    mutation: bool,
) -> Response | None:
    mode = mode_for_group(group)

    if mode == ChannexAdminCutoverMode.LEGACY_OWNED:
        return None
    if mode == ChannexAdminCutoverMode.READ_ONLY and not mutation:
        return None
    if mode == ChannexAdminCutoverMode.PROXY_TO_TARGET:
        return await _proxy_to_target(request)

    if mode == ChannexAdminCutoverMode.READ_ONLY:
        message = (
            f"Legacy Channex admin route group '{group.value}' is read-only during cutover; "
            "mutating legacy action is blocked."
        )
    elif mode == ChannexAdminCutoverMode.TARGET_OWNED:
        message = (
            f"Legacy Channex admin route group '{group.value}' is target-owned during cutover; "
            "use the target service or set proxy-to-target mode."
        )
    else:
        message = f"Legacy Channex admin route group '{group.value}' is disabled during cutover."

    raise HTTPException(
        status_code=423,
        detail={
            "code": "channex_admin_route_guarded",
            "route_group": group.value,
            "mode": mode.value,
            "message": message,
        },
    )


async def _proxy_to_target(request: Request) -> Response:
    base_url = settings.CHANNEX_ADMIN_TARGET_BASE_URL.strip().rstrip("/")
    if not base_url:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "channex_admin_proxy_target_missing",
                "mode": ChannexAdminCutoverMode.PROXY_TO_TARGET.value,
                "message": (
                    "CHANNEX_ADMIN_TARGET_BASE_URL must be set before using "
                    "proxy-to-target mode."
                ),
            },
        )

    path = request.url.path
    target_url = f"{base_url}{path}"
    if request.url.query:
        target_url = f"{target_url}?{request.url.query}"

    headers = {
        key: value
        for key, value in request.headers.items()
        if key.lower() not in _HOP_BY_HOP_HEADERS | {"host", "content-length"}
    }

    try:
        async with httpx.AsyncClient(timeout=settings.CHANNEX_ADMIN_TARGET_TIMEOUT_SECONDS) as client:
            proxied = await client.request(
                request.method,
                target_url,
                content=await request.body(),
                headers=headers,
            )
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=502,
            detail={
                "code": "channex_admin_proxy_failed",
                "mode": ChannexAdminCutoverMode.PROXY_TO_TARGET.value,
                "message": f"Failed to proxy Channex admin request to target: {exc}",
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
