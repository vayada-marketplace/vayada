from pydantic import BaseModel, ConfigDict, EmailStr
from typing import Dict, List, Optional
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
    payment_method: str = "card"
    rate_type: str = "flexible"
    addon_ids: List[str] = []
    addon_quantities: Dict[str, int] = {}


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
    addon_total: float = 0
    currency: str
    status: str
    payment_method: Optional[str] = None
    payment_status: Optional[str] = None
    host_response_deadline: Optional[str] = None
    created_at: str


class AdminBookingCreate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    room_id: str
    guest_first_name: str
    guest_last_name: str
    guest_email: EmailStr
    guest_phone: str = ""
    special_requests: str = ""
    check_in: date
    check_out: date
    adults: int = 1
    children: int = 0
    nightly_rate: Optional[float] = None
    channel: str = "direct"


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
    room_id: Optional[str] = None
    room_number: Optional[str] = None
    channel: str = "direct"
    payment_method: Optional[str] = None
    payment_status: Optional[str] = None
    host_response_deadline: Optional[str] = None
    platform_fee_amount: Optional[float] = None
    affiliate_commission_amount: Optional[float] = None
    property_payout_amount: Optional[float] = None
    addon_ids: List[str] = []
    addon_total: float = 0
    addon_quantities: Dict[str, int] = {}
    guest_withdrawn: bool = False
    created_at: str
    updated_at: str


class BookingStatusUpdate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    status: str  # 'confirmed' or 'cancelled'


class BookingRoomAssign(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    room_id: str


class BookingLookup(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    booking_reference: str
    guest_email: EmailStr
