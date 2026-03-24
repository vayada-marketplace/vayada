from pydantic import BaseModel, ConfigDict
from typing import Optional, List, Dict


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
    description: str = ""
    short_description: str = ""
    max_occupancy: int = 2
    size: int = 0
    base_rate: float = 0
    non_refundable_rate: Optional[float] = None
    currency: str = "EUR"
    amenities: List[str] = []
    images: List[str] = []
    bed_type: str = ""
    features: List[str] = []
    benefits: List[str] = []
    total_rooms: int = 1
    is_active: bool = True
    sort_order: int = 0
    monthly_rates: Optional[Dict[str, MonthlyRate]] = None
    operating_periods: List[dict] = []
    seasons: List[dict] = []
    weekend_surcharge: str = "+0%"
    cancellation_policy: str = "Free until 7 days before"
    flexible_rate_enabled: bool = True
    non_refundable_enabled: bool = False
    non_refundable_discount: int = 10


class RoomTypeUpdate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    name: Optional[str] = None
    description: Optional[str] = None
    short_description: Optional[str] = None
    max_occupancy: Optional[int] = None
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
    operating_periods: Optional[List[dict]] = None
    seasons: Optional[List[dict]] = None
    weekend_surcharge: Optional[str] = None
    cancellation_policy: Optional[str] = None
    flexible_rate_enabled: Optional[bool] = None
    non_refundable_enabled: Optional[bool] = None
    non_refundable_discount: Optional[int] = None


class RoomTypeResponse(BaseModel):
    """Guest-facing response — includes availability."""
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    name: str
    description: str
    short_description: str
    max_occupancy: int
    size: int
    base_rate: float
    non_refundable_rate: Optional[float] = None
    currency: str
    amenities: List[str]
    images: List[str]
    bed_type: str
    remaining_rooms: int
    features: List[str]
    benefits: List[str] = []


class RoomTypeAdminResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    hotel_id: str
    name: str
    description: str
    short_description: str
    max_occupancy: int
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
    operating_periods: List[dict] = []
    seasons: List[dict] = []
    weekend_surcharge: str = "+0%"
    cancellation_policy: str = "Free until 7 days before"
    flexible_rate_enabled: bool = True
    non_refundable_enabled: bool = False
    non_refundable_discount: int = 10
    created_at: str
    updated_at: str
