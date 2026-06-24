from datetime import date
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, field_validator


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
    booking_hotel_id: str | None = None


PROPERTY_TYPES = [
    "apart_hotel",
    "apartment",
    "boat",
    "camping",
    "capsule_hotel",
    "chalet",
    "country_house",
    "farm_stay",
    "guest_house",
    "holiday_home",
    "holiday_park",
    "homestay",
    "hostel",
    "hotel",
    "inn",
    "lodge",
    "motel",
    "resort",
    "riad",
    "ryokan",
    "tent",
    "villa",
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
    latitude: float | None = None
    longitude: float | None = None
    user_id: str
    created_at: str


class HotelBenefitsUpdate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    benefits: list[str]


class HotelBenefitsResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    benefits: list[str] = []


class GuestFormSettingsResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    special_requests_enabled: bool = True
    arrival_time_enabled: bool = False
    guest_count_enabled: bool = False
    phone_required: bool = True


class GuestFormSettingsUpdate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    special_requests_enabled: bool | None = None
    arrival_time_enabled: bool | None = None
    guest_count_enabled: bool | None = None
    phone_required: bool | None = None


class CalendarSettingsResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    auto_rearrange_enabled: bool = True
    auto_open_enabled: bool = False
    auto_open_mode: Literal["rolling", "fixed"] = "rolling"
    auto_open_months: Literal[12, 18, 24] = 18
    auto_open_fixed_month: date | None = None
    auto_open_through: date | None = None
    auto_open_warnings: list[str] = []


class CalendarSettingsUpdate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    auto_rearrange_enabled: bool | None = None
    auto_open_enabled: bool | None = None
    auto_open_mode: Literal["rolling", "fixed"] | None = None
    auto_open_months: Literal[12, 18, 24] | None = None
    auto_open_fixed_month: date | None = None


class SetupStatusResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    registered: bool
    setup_complete: bool
    room_count: int


class HotelDeletionImpactResponse(BaseModel):
    """Counts shown in the Manage Properties delete-warning dialog so the
    user knows what they're about to wipe out."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    upcoming_bookings_count: int = 0
    connected_channels_count: int = 0


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
    latitude: float | None = None
    longitude: float | None = None
    wifi_password: str = ""
    host_contact_name: str = ""
    google_review_link: str = ""
    last_minute_discount: Any | None = None
    instant_book: bool = False
    same_day_bookings_enabled: bool = True
    same_day_booking_cutoff_time: str | None = "18:00"


class SameDayBookingSettingsUpdate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    same_day_bookings_enabled: bool | None = None
    same_day_booking_cutoff_time: str | None = None

    @field_validator("same_day_booking_cutoff_time")
    @classmethod
    def validate_cutoff_time(cls, value: str | None) -> str | None:
        if value is None:
            return value
        try:
            hour, minute = value.split(":")
            hour_int = int(hour)
            minute_int = int(minute)
        except (TypeError, ValueError):
            raise ValueError("sameDayBookingCutoffTime must use HH:mm format") from None
        if hour_int < 0 or hour_int > 23 or minute_int not in (0, 30):
            raise ValueError("sameDayBookingCutoffTime must be in 30-minute intervals")
        return f"{hour_int:02d}:{minute_int:02d}"
