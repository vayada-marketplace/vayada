"""
Cloudflare for SaaS — Custom Hostname management.
"""
import logging
import httpx
from app.config import settings

logger = logging.getLogger(__name__)

_BASE = "https://api.cloudflare.com/client/v4"


def _headers() -> dict:
    return {
        "Authorization": f"Bearer {settings.CLOUDFLARE_API_TOKEN}",
        "Content-Type": "application/json",
    }


def _zone_url(path: str = "") -> str:
    return f"{_BASE}/zones/{settings.CLOUDFLARE_ZONE_ID}{path}"


async def create_custom_hostname(domain: str) -> dict:
    """Register a Custom Hostname in Cloudflare for SaaS."""
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            _zone_url("/custom_hostnames"),
            headers=_headers(),
            json={
                "hostname": domain,
                "ssl": {
                    "method": "http",
                    "type": "dv",
                    "settings": {
                        "min_tls_version": "1.2",
                    },
                },
            },
        )
        data = resp.json()
        if not data.get("success"):
            errors = data.get("errors", [])
            logger.error("Cloudflare create_custom_hostname failed: %s", errors)
            raise RuntimeError(f"Cloudflare API error: {errors}")
        return data["result"]


async def delete_custom_hostname(domain: str) -> bool:
    """Remove a Custom Hostname. Looks up by hostname first."""
    hostname_id = await _find_hostname_id(domain)
    if not hostname_id:
        return False

    async with httpx.AsyncClient() as client:
        resp = await client.delete(
            _zone_url(f"/custom_hostnames/{hostname_id}"),
            headers=_headers(),
        )
        data = resp.json()
        if not data.get("success"):
            logger.error("Cloudflare delete_custom_hostname failed: %s", data.get("errors"))
            return False
        return True


async def get_hostname_status(domain: str) -> dict | None:
    """Return SSL + verification status for a custom hostname."""
    hostname_id = await _find_hostname_id(domain)
    if not hostname_id:
        return None

    async with httpx.AsyncClient() as client:
        resp = await client.get(
            _zone_url(f"/custom_hostnames/{hostname_id}"),
            headers=_headers(),
        )
        data = resp.json()
        if not data.get("success"):
            return None
        result = data["result"]
        return {
            "hostname": result["hostname"],
            "status": result.get("status", "unknown"),
            "ssl_status": result.get("ssl", {}).get("status", "unknown"),
            "verification_errors": result.get("verification_errors", []),
            "ownership_verification": result.get("ownership_verification"),
        }


async def _find_hostname_id(domain: str) -> str | None:
    """Look up the Cloudflare custom hostname ID by domain."""
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            _zone_url("/custom_hostnames"),
            headers=_headers(),
            params={"hostname": domain},
        )
        data = resp.json()
        if not data.get("success"):
            return None
        results = data.get("result", [])
        for r in results:
            if r["hostname"] == domain:
                return r["id"]
        return None
