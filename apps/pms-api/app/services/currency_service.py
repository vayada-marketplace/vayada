import logging

import httpx

logger = logging.getLogger(__name__)

OPEN_ER_API = "https://open.er-api.com/v6/latest"
FRANKFURTER_API = "https://api.frankfurter.dev/v1/latest"
FAWAZAHMED0_API = "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies"


async def get_exchange_rate(from_currency: str, to_currency: str) -> float:
    """Fetch the current exchange rate between two currencies."""
    if from_currency == to_currency:
        return 1.0

    async with httpx.AsyncClient(timeout=10) as client:
        # Try open.er-api.com first (supports 150+ currencies)
        try:
            resp = await client.get(f"{OPEN_ER_API}/{from_currency}")
            resp.raise_for_status()
            data = resp.json()
            if data.get("result") == "success" and to_currency in data.get("rates", {}):
                rate = data["rates"][to_currency]
                logger.info(
                    "Exchange rate %s -> %s: %s (open.er-api)", from_currency, to_currency, rate
                )
                return float(rate)
        except Exception as e:
            logger.warning("open.er-api failed for %s -> %s: %s", from_currency, to_currency, e)

        # Fallback to Frankfurter (ECB data, ~30 currencies)
        try:
            resp = await client.get(
                FRANKFURTER_API,
                params={"from": from_currency, "to": to_currency},
            )
            resp.raise_for_status()
            data = resp.json()
            rate = data["rates"][to_currency]
            logger.info(
                "Exchange rate %s -> %s: %s (frankfurter)", from_currency, to_currency, rate
            )
            return float(rate)
        except Exception as e:
            logger.warning("Frankfurter failed for %s -> %s: %s", from_currency, to_currency, e)

        # Fallback to fawazahmed0 currency API (150+ currencies)
        try:
            from_lower = from_currency.lower()
            to_lower = to_currency.lower()
            resp = await client.get(f"{FAWAZAHMED0_API}/{from_lower}.json")
            resp.raise_for_status()
            data = resp.json()
            rate = data[from_lower][to_lower]
            logger.info(
                "Exchange rate %s -> %s: %s (fawazahmed0)", from_currency, to_currency, rate
            )
            return float(rate)
        except Exception as e:
            logger.warning("fawazahmed0 failed for %s -> %s: %s", from_currency, to_currency, e)

        raise ValueError(f"All exchange rate APIs failed for {from_currency} -> {to_currency}")


ZERO_DECIMAL_CURRENCIES = frozenset(
    {
        "IDR",
        "JPY",
        "KRW",
        "VND",
        "CLP",
        "GNF",
        "PYG",
        "RWF",
        "UGX",
        "XOF",
        "XAF",
    }
)


def decimals_for_currency(currency: str) -> int:
    return 0 if currency in ZERO_DECIMAL_CURRENCIES else 2


def convert_amount(amount: float, rate: float, decimals: int = 2) -> float:
    """Convert an amount using the given exchange rate."""
    return round(amount * rate, decimals)


async def convert_room_type_rates(room: dict, rate: float, decimals: int = 2) -> dict:
    """Build an updates dict with all monetary fields converted."""
    import json

    updates = {}

    if room.get("base_rate") is not None:
        updates["base_rate"] = convert_amount(float(room["base_rate"]), rate, decimals)

    if room.get("non_refundable_rate") is not None:
        updates["non_refundable_rate"] = convert_amount(
            float(room["non_refundable_rate"]), rate, decimals
        )

    # Convert season rates
    seasons = room.get("seasons") or []
    if isinstance(seasons, str):
        seasons = json.loads(seasons)
    if seasons:
        converted_seasons = []
        for s in seasons:
            s_copy = dict(s)
            if s_copy.get("rate"):
                s_copy["rate"] = convert_amount(float(s_copy["rate"]), rate, decimals)
            converted_seasons.append(s_copy)
        updates["seasons"] = converted_seasons

    # Convert monthly rate overrides
    monthly_rates = room.get("monthly_rates") or {}
    if isinstance(monthly_rates, str):
        monthly_rates = json.loads(monthly_rates)
    if monthly_rates:
        converted_monthly = {}
        for month, mr in monthly_rates.items():
            mr_copy = dict(mr)
            if mr_copy.get("base_rate") is not None:
                mr_copy["base_rate"] = convert_amount(float(mr_copy["base_rate"]), rate, decimals)
            if mr_copy.get("non_refundable_rate") is not None:
                mr_copy["non_refundable_rate"] = convert_amount(
                    float(mr_copy["non_refundable_rate"]), rate, decimals
                )
            converted_monthly[month] = mr_copy
        updates["monthly_rates"] = converted_monthly

    # Convert daily rate overrides
    daily_rates = room.get("daily_rates") or {}
    if isinstance(daily_rates, str):
        daily_rates = json.loads(daily_rates)
    if daily_rates:
        converted_daily = {}
        for day, dr in daily_rates.items():
            converted_daily[day] = convert_amount(float(dr), rate, decimals)
        updates["daily_rates"] = converted_daily

    return updates
