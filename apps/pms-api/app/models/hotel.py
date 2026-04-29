from pydantic import BaseModel, ConfigDict
from typing import Any, Optional, List


def to_camel(string: str) -> str:
    parts = string.split("_")
    return parts[0] + "".join(w.capitalize() for w in parts[1:])


class HotelRegister(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    name: str
    slug: str
    contact_email: str
    # booking_hotels.id from the booking-engine DB. When present, this
    # value becomes the PMS hotels.id primary key, so the same hotel
    # shares a single UUID across both databases. Callers (setup
    # wizard) must POST to booking-engine /admin/hotels first to get
    # the id, then pass it here. Optional only for backward compat
    # during the rollout — every new caller must supply it.
    booking_hotel_id: Optional[str] = None


PROPERTY_TYPES = [
    "apart_hotel", "apartment", "boat", "camping", "capsule_hotel",
    "chalet", "country_house", "farm_stay", "guest_house", "holiday_home",
    "holiday_park", "homestay", "hostel", "hotel", "inn", "lodge",
    "motel", "resort", "riad", "ryokan", "tent", "villa",
]


class HotelResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    slug: str
    name: str
    contact_email: str
    property_type: str = "guest_house"
    timezone: str = ""
    country: str = ""
    state: str = ""
    city: str = ""
    address: str = ""
    zip_code: str = ""
    phone: str = ""
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    user_id: str
    created_at: str


class HotelBenefitsUpdate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    benefits: List[str]


class HotelBenefitsResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    benefits: List[str] = []


class GuestFormSettingsResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    special_requests_enabled: bool = True
    arrival_time_enabled: bool = False
    guest_count_enabled: bool = False


class GuestFormSettingsUpdate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    special_requests_enabled: Optional[bool] = None
    arrival_time_enabled: Optional[bool] = None
    guest_count_enabled: Optional[bool] = None


class SetupStatusResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    registered: bool
    setup_complete: bool
    room_count: int


class HotelDetailsResponse(BaseModel):
    """Full hotel detail surface returned by GET/PATCH /admin/hotel."""
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    slug: str
    name: str
    contact_email: str = ""
    property_type: str = "guest_house"
    timezone: str = ""
    country: str = ""
    state: str = ""
    city: str = ""
    address: str = ""
    zip_code: str = ""
    phone: str = ""
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    last_minute_discount: Optional[Any] = None
    instant_book: bool = False
