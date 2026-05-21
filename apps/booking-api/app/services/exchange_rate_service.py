import logging
from datetime import UTC, datetime, timedelta

import httpx

logger = logging.getLogger(__name__)

_cache: dict[str, dict] = {}
_CACHE_TTL = timedelta(hours=6)

OPEN_ER_API = "https://open.er-api.com/v6/latest"
FRANKFURTER_API = "https://api.frankfurter.app/latest"
FAWAZAHMED0_API = "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies"


async def get_rates(base: str) -> dict:
    base = base.upper()
    cached = _cache.get(base)
    if cached and datetime.now(UTC) - cached["fetched_at"] < _CACHE_TTL:
        return cached["rates"]

    async with httpx.AsyncClient(timeout=10.0) as client:
        # 1. Try open.er-api.com (supports 150+ currencies including IDR)
        try:
            resp = await client.get(f"{OPEN_ER_API}/{base}")
            resp.raise_for_status()
            data = resp.json()
            if data.get("result") == "success" and data.get("rates"):
                rates = {k: v for k, v in data["rates"].items() if k != base}
                _cache[base] = {"rates": rates, "fetched_at": datetime.now(UTC)}
                logger.info(
                    "Exchange rates loaded for %s from open.er-api (%d currencies)",
                    base,
                    len(rates),
                )
                return rates
        except Exception as e:
            logger.warning("open.er-api failed for %s: %s", base, e)

        # 2. Fallback: Frankfurter (ECB data, ~30 currencies)
        try:
            resp = await client.get(f"{FRANKFURTER_API}?from={base}")
            resp.raise_for_status()
            data = resp.json()
            rates = data.get("rates", {})
            if rates:
                _cache[base] = {"rates": rates, "fetched_at": datetime.now(UTC)}
                logger.info(
                    "Exchange rates loaded for %s from frankfurter (%d currencies)",
                    base,
                    len(rates),
                )
                return rates
        except Exception as e:
            logger.warning("Frankfurter failed for %s: %s", base, e)

        # 3. Fallback: fawazahmed0 (150+ currencies)
        try:
            base_lower = base.lower()
            resp = await client.get(f"{FAWAZAHMED0_API}/{base_lower}.json")
            resp.raise_for_status()
            data = resp.json()
            raw_rates = data.get(base_lower, {})
            rates = {k.upper(): v for k, v in raw_rates.items() if k.upper() != base}
            if rates:
                _cache[base] = {"rates": rates, "fetched_at": datetime.now(UTC)}
                logger.info(
                    "Exchange rates loaded for %s from fawazahmed0 (%d currencies)",
                    base,
                    len(rates),
                )
                return rates
        except Exception as e:
            logger.warning("fawazahmed0 failed for %s: %s", base, e)

    logger.error("All exchange rate APIs failed for %s", base)
    if cached:
        return cached["rates"]
    return {}
