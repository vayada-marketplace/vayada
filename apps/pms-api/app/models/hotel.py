from pydantic import BaseModel, ConfigDict
from typing import Optional, List


def to_camel(string: str) -> str:
    parts = string.split("_")
    return parts[0] + "".join(w.capitalize() for w in parts[1:])


class HotelRegister(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    name: str
    slug: str
    contact_email: str


class HotelResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    slug: str
    name: str
    contact_email: str
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
