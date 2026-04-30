from pydantic import BaseModel, ConfigDict, field_validator
from typing import Optional, List, Dict

MAX_ROOM_SIZE = 15000

# Booking.com meal_plan_code values that Channex maps for us. 0 = room only
# is the implicit default and never persisted in room_types.meal_plans.
VALID_MEAL_PLAN_CODES = {1, 3, 4, 9}


def _validate_meal_plans(plans: list) -> list:
    seen: set[int] = set()
    for p in plans:
        code = p.get("code")
        surcharge = p.get("surcharge")
        if code not in VALID_MEAL_PLAN_CODES:
            raise ValueError(
                f"meal_plans[].code must be one of {sorted(VALID_MEAL_PLAN_CODES)}, got {code}"
            )
        if code in seen:
            raise ValueError(f"meal_plans contains duplicate code {code}")
        seen.add(code)
        if surcharge is None or float(surcharge) < 0:
            raise ValueError(
                f"meal_plans[].surcharge must be >= 0 (code {code})"
            )
    return plans


def _validate_operating_periods(periods: list) -> list:
    """Raise ValueError if any operating period has end date before start date."""
    for p in periods:
        if p.get("from") and p.get("to") and p["to"] < p["from"]:
            raise ValueError(
                f"Operating period end date must be on or after start date: "
                f"{p['from']} – {p['to']}"
            )
    return periods


def _normalize_season_date(d: str) -> str:
    """Normalize MM-DD to YYYY-MM-DD using a leap year as reference."""
    if d and len(d) == 5 and d[2] == '-':
        return f"2024-{d}"  # Use leap year so Feb 29 is valid
    return d


def _normalize_season_dates(seasons: list) -> list:
    """Ensure all season from/to dates are full YYYY-MM-DD."""
    for s in seasons:
        if s.get("from"):
            s["from"] = _normalize_season_date(s["from"])
        if s.get("to"):
            s["to"] = _normalize_season_date(s["to"])
    return seasons


def _validate_no_season_overlap(seasons: list) -> list:
    """Raise ValueError if any two seasons have overlapping date ranges."""
    for i, a in enumerate(seasons):
        for b in seasons[i + 1:]:
            if a.get("from") and a.get("to") and b.get("from") and b.get("to"):
                # Normalize to YYYY-MM-DD for correct string comparison
                af = _normalize_season_date(a["from"])
                at = _normalize_season_date(a["to"])
                bf = _normalize_season_date(b["from"])
                bt = _normalize_season_date(b["to"])
                if af <= bt and bf <= at:
                    raise ValueError(
                        f"Season date ranges overlap: "
                        f"{a.get('name', 'Unnamed')} ({a['from']} – {a['to']}) and "
                        f"{b.get('name', 'Unnamed')} ({b['from']} – {b['to']})"
                    )
    return seasons


def _validate_season_rates(seasons: list) -> list:
    """Raise ValueError if any season has a missing or zero rate."""
    for s in seasons:
        rate = s.get("rate")
        if rate is None or rate == "" or float(rate) <= 0:
            name = s.get("name") or "Unnamed"
            raise ValueError(
                f"Season \"{name}\" must have a rate greater than 0"
            )
    return seasons


def _validate_no_season_gaps(seasons: list) -> list:
    """Raise ValueError if there are gaps between consecutive seasons."""
    from datetime import date, timedelta

    def _parse_date(d: str) -> date:
        """Parse YYYY-MM-DD or MM-DD (normalized to 2024-MM-DD)."""
        if len(d) == 5 and d[2] == '-':
            return date(2024, int(d[:2]), int(d[3:]))
        return date.fromisoformat(d)

    valid = [s for s in seasons if s.get("from") and s.get("to")]
    if len(valid) < 2:
        return seasons
    sorted_seasons = sorted(valid, key=lambda s: _normalize_season_date(s["from"]))
    gaps = []
    for i in range(len(sorted_seasons) - 1):
        end = _parse_date(sorted_seasons[i]["to"])
        next_start = _parse_date(sorted_seasons[i + 1]["from"])
        if end + timedelta(days=1) < next_start:
            gap_from = end + timedelta(days=1)
            gap_to = next_start - timedelta(days=1)
            gaps.append(f"{gap_from.isoformat()} – {gap_to.isoformat()}")
    if gaps:
        raise ValueError(
            f"Season date ranges have gaps (dates with no price): {'; '.join(gaps)}"
        )
    return seasons


def to_camel(string: str) -> str:
    parts = string.split("_")
    return parts[0] + "".join(w.capitalize() for w in parts[1:])


class MonthlyRate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    base_rate: Optional[float] = None
    non_refundable_rate: Optional[float] = None


class RoomTypeCreate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    name: str
    category: str = ""
    description: str = ""
    short_description: str = ""
    max_occupancy: int = 2
    bedrooms: int = 1
    bathrooms: int = 1
    size: int = 0
    base_rate: float = 0
    non_refundable_rate: Optional[float] = None
    currency: str = "EUR"
    amenities: List[str] = []
    images: List[str] = []
    bed_type: str = ""
    features: List[str] = []
    benefits: List[str] = []
    total_rooms: int = 2
    is_active: bool = True
    sort_order: int = 0
    monthly_rates: Optional[Dict[str, MonthlyRate]] = None
    daily_rates: Optional[Dict[str, float]] = None
    operating_periods: List[dict] = []
    seasons: List[dict] = []
    weekend_surcharge: str = "+0%"
    cancellation_policy: str = "Free until 7 days before"
    flexible_rate_enabled: bool = True
    flexible_cancellation_type: str = "free"
    partial_refund_cancel_window_days: int = 30
    partial_refund_amount_percent: int = 50
    non_refundable_enabled: bool = False
    non_refundable_discount: int = 5
    non_refundable_cancellation_policy: str = "Non-refundable from booking"
    last_minute_discount: Optional[dict] = None
    minimum_advance_days: int = 0
    rate_payment_methods: Optional[Dict[str, List[str]]] = None
    meal_plans: List[dict] = []

    @field_validator("size")
    @classmethod
    def validate_size(cls, v: int) -> int:
        if v > MAX_ROOM_SIZE:
            raise ValueError(f"Room size must not exceed {MAX_ROOM_SIZE} m²")
        return v

    @field_validator("meal_plans")
    @classmethod
    def validate_meal_plans(cls, v: List[dict]) -> List[dict]:
        return _validate_meal_plans(v)

    @field_validator("flexible_cancellation_type")
    @classmethod
    def validate_flexible_cancellation_type(cls, v: str) -> str:
        if v not in ("free", "partial_refund"):
            raise ValueError("flexible_cancellation_type must be 'free' or 'partial_refund'")
        return v

    @field_validator("partial_refund_cancel_window_days")
    @classmethod
    def validate_partial_refund_window(cls, v: int) -> int:
        if v < 1 or v > 365:
            raise ValueError("partial_refund_cancel_window_days must be between 1 and 365")
        return v

    @field_validator("partial_refund_amount_percent")
    @classmethod
    def validate_partial_refund_percent(cls, v: int) -> int:
        if v < 1 or v > 99:
            raise ValueError("partial_refund_amount_percent must be between 1 and 99")
        return v

    @field_validator("operating_periods")
    @classmethod
    def validate_operating_periods(cls, v: List[dict]) -> List[dict]:
        return _validate_operating_periods(v)

    @field_validator("seasons")
    @classmethod
    def validate_seasons(cls, v: List[dict]) -> List[dict]:
        _normalize_season_dates(v)
        _validate_season_rates(v)
        _validate_no_season_overlap(v)
        return _validate_no_season_gaps(v)


class RoomTypeUpdate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    name: Optional[str] = None
    category: Optional[str] = None
    description: Optional[str] = None
    short_description: Optional[str] = None
    max_occupancy: Optional[int] = None
    bedrooms: Optional[int] = None
    bathrooms: Optional[int] = None
    size: Optional[int] = None
    base_rate: Optional[float] = None
    non_refundable_rate: Optional[float] = None
    currency: Optional[str] = None
    amenities: Optional[List[str]] = None
    images: Optional[List[str]] = None
    bed_type: Optional[str] = None
    features: Optional[List[str]] = None
    benefits: Optional[List[str]] = None
    total_rooms: Optional[int] = None
    is_active: Optional[bool] = None
    sort_order: Optional[int] = None
    monthly_rates: Optional[Dict[str, MonthlyRate]] = None
    daily_rates: Optional[Dict[str, float]] = None
    operating_periods: Optional[List[dict]] = None
    seasons: Optional[List[dict]] = None
    weekend_surcharge: Optional[str] = None
    cancellation_policy: Optional[str] = None
    flexible_rate_enabled: Optional[bool] = None
    flexible_cancellation_type: Optional[str] = None
    partial_refund_cancel_window_days: Optional[int] = None
    partial_refund_amount_percent: Optional[int] = None
    non_refundable_enabled: Optional[bool] = None
    non_refundable_discount: Optional[int] = None
    non_refundable_cancellation_policy: Optional[str] = None
    last_minute_discount: Optional[dict] = None
    minimum_advance_days: Optional[int] = None
    rate_payment_methods: Optional[Dict[str, List[str]]] = None
    meal_plans: Optional[List[dict]] = None

    @field_validator("size")
    @classmethod
    def validate_size(cls, v: Optional[int]) -> Optional[int]:
        if v is not None and v > MAX_ROOM_SIZE:
            raise ValueError(f"Room size must not exceed {MAX_ROOM_SIZE} m²")
        return v

    @field_validator("flexible_cancellation_type")
    @classmethod
    def validate_flexible_cancellation_type(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and v not in ("free", "partial_refund"):
            raise ValueError("flexible_cancellation_type must be 'free' or 'partial_refund'")
        return v

    @field_validator("partial_refund_cancel_window_days")
    @classmethod
    def validate_partial_refund_window(cls, v: Optional[int]) -> Optional[int]:
        if v is not None and (v < 1 or v > 365):
            raise ValueError("partial_refund_cancel_window_days must be between 1 and 365")
        return v

    @field_validator("partial_refund_amount_percent")
    @classmethod
    def validate_partial_refund_percent(cls, v: Optional[int]) -> Optional[int]:
        if v is not None and (v < 1 or v > 99):
            raise ValueError("partial_refund_amount_percent must be between 1 and 99")
        return v

    @field_validator("operating_periods")
    @classmethod
    def validate_operating_periods(cls, v: Optional[List[dict]]) -> Optional[List[dict]]:
        if v is not None:
            _validate_operating_periods(v)
        return v

    @field_validator("seasons")
    @classmethod
    def validate_seasons(cls, v: Optional[List[dict]]) -> Optional[List[dict]]:
        if v is not None:
            _normalize_season_dates(v)
            _validate_season_rates(v)
            _validate_no_season_overlap(v)
            _validate_no_season_gaps(v)
        return v

    @field_validator("meal_plans")
    @classmethod
    def validate_meal_plans(cls, v: Optional[List[dict]]) -> Optional[List[dict]]:
        if v is not None:
            _validate_meal_plans(v)
        return v


class RoomTypeResponse(BaseModel):
    """Guest-facing response — includes availability."""
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    name: str
    category: str = ""
    description: str
    short_description: str
    max_occupancy: int
    bedrooms: int = 1
    bathrooms: int = 1
    size: int
    base_rate: float
    non_refundable_rate: Optional[float] = None
    original_rate: Optional[float] = None
    last_minute_discount_percent: Optional[int] = None
    currency: str
    amenities: List[str]
    images: List[str]
    bed_type: str
    remaining_rooms: int
    features: List[str]
    benefits: List[str] = []
    flexible_rate_enabled: bool = True
    cancellation_policy: str = "Free until 7 days before"
    flexible_cancellation_type: str = "free"
    partial_refund_cancel_window_days: int = 30
    partial_refund_amount_percent: int = 50
    non_refundable_cancellation_policy: str = "Non-refundable from booking"
    rate_payment_methods: Optional[Dict[str, List[str]]] = None


class RoomTypeAdminResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    hotel_id: str
    name: str
    category: str = ""
    description: str
    short_description: str
    max_occupancy: int
    bedrooms: int = 1
    bathrooms: int = 1
    size: int
    base_rate: float
    non_refundable_rate: Optional[float] = None
    currency: str
    amenities: List[str]
    images: List[str]
    bed_type: str
    features: List[str]
    benefits: List[str] = []
    total_rooms: int
    is_active: bool
    sort_order: int
    monthly_rates: Dict[str, MonthlyRate] = {}
    daily_rates: Dict[str, float] = {}
    operating_periods: List[dict] = []
    seasons: List[dict] = []
    weekend_surcharge: str = "+0%"
    cancellation_policy: str = "Free until 7 days before"
    flexible_rate_enabled: bool = True
    flexible_cancellation_type: str = "free"
    partial_refund_cancel_window_days: int = 30
    partial_refund_amount_percent: int = 50
    non_refundable_enabled: bool = False
    non_refundable_discount: int = 5
    non_refundable_cancellation_policy: str = "Non-refundable from booking"
    last_minute_discount: Optional[dict] = None
    minimum_advance_days: int = 0
    rate_payment_methods: Optional[Dict[str, List[str]]] = None
    meal_plans: List[dict] = []
    created_at: str
    updated_at: str


class UnavailableDatesResponse(BaseModel):
    """Public /api/hotels/{slug}/unavailable-dates: dates where every room
    type is fully booked, plus per-arrival min-stay constraints."""
    dates: List[str] = []
    min_stay_by_arrival: Dict[str, int] = {}
