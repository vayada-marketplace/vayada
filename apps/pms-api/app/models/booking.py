from pydantic import BaseModel, ConfigDict, EmailStr
from typing import Optional
from datetime import date


def to_camel(string: str) -> str:
    parts = string.split("_")
    return parts[0] + "".join(w.capitalize() for w in parts[1:])


class BookingCreate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    room_type_id: str
    guest_first_name: str
    guest_last_name: str
    guest_email: EmailStr
    guest_phone: str
    special_requests: str = ""
    check_in: date
    check_out: date
    adults: int = 1
    children: int = 0
    referral_code: Optional[str] = None


class BookingResponse(BaseModel):
    """Returned to the guest after creating or looking up a booking."""
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    booking_reference: str
    hotel_name: str
    room_name: str
    guest_first_name: str
    guest_last_name: str
    guest_email: str
    check_in: str
    check_out: str
    nights: int
    adults: int
    children: int
    nightly_rate: float
    total_amount: float
    currency: str
    status: str
    created_at: str


class BookingAdminResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    booking_reference: str
    room_type_id: str
    room_name: str
    guest_first_name: str
    guest_last_name: str
    guest_email: str
    guest_phone: str
    special_requests: str
    check_in: str
    check_out: str
    nights: int
    adults: int
    children: int
    nightly_rate: float
    total_amount: float
    currency: str
    status: str
    created_at: str
    updated_at: str


class BookingStatusUpdate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    status: str  # 'confirmed' or 'cancelled'


class BookingLookup(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    booking_reference: str
    guest_email: EmailStr
