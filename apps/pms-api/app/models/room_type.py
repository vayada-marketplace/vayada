from pydantic import BaseModel, ConfigDict, field_validator
from typing import Optional, List, Dict

MAX_ROOM_SIZE = 15000


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
    non_refundable_enabled: bool = False
    non_refundable_discount: int = 10
    last_minute_discount: Optional[dict] = None
    minimum_advance_days: int = 0
    rate_payment_methods: Optional[Dict[str, List[str]]] = None

    @field_validator("size")
    @classmethod
    def validate_size(cls, v: int) -> int:
        if v > MAX_ROOM_SIZE:
            raise ValueError(f"Room size must not exceed {MAX_ROOM_SIZE} m²")
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
    non_refundable_enabled: Optional[bool] = None
    non_refundable_discount: Optional[int] = None
    last_minute_discount: Optional[dict] = None
    minimum_advance_days: Optional[int] = None
    rate_payment_methods: Optional[Dict[str, List[str]]] = None

    @field_validator("size")
    @classmethod
    def validate_size(cls, v: Optional[int]) -> Optional[int]:
        if v is not None and v > MAX_ROOM_SIZE:
            raise ValueError(f"Room size must not exceed {MAX_ROOM_SIZE} m²")
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
    non_refundable_enabled: bool = False
    non_refundable_discount: int = 10
    last_minute_discount: Optional[dict] = None
    minimum_advance_days: int = 0
    rate_payment_methods: Optional[Dict[str, List[str]]] = None
    created_at: str
    updated_at: str
