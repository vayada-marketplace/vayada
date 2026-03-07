import logging
from datetime import datetime, timedelta, timezone
from typing import Dict

import httpx

logger = logging.getLogger(__name__)

_cache: Dict[str, dict] = {}
_CACHE_TTL = timedelta(hours=6)


async def get_rates(base: str) -> dict:
    base = base.upper()
    cached = _cache.get(base)
    if cached and datetime.now(timezone.utc) - cached["fetched_at"] < _CACHE_TTL:
        return cached["rates"]

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                f"https://api.frankfurter.app/latest?from={base}"
            )
            resp.raise_for_status()
            data = resp.json()
            rates = data.get("rates", {})
            _cache[base] = {
                "rates": rates,
                "fetched_at": datetime.now(timezone.utc),
            }
            return rates
    except Exception as e:
        logger.warning(f"Failed to fetch exchange rates for {base}: {e}")
        if cached:
            return cached["rates"]
        return {}
