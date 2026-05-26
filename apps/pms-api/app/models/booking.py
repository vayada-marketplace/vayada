import json
from datetime import date

from pydantic import BaseModel, ConfigDict, EmailStr, field_validator


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
    guest_country: str = ""
    special_requests: str = ""
    estimated_arrival_time: str | None = None
    number_of_guests: int | None = None
    check_in: date
    check_out: date
    adults: int = 1
    children: int = 0
    referral_code: str | None = None
    payment_method: str = "card"
    rate_type: str = "flexible"
    number_of_rooms: int = 1
    addon_ids: list[str] = []
    addon_quantities: dict[str, int] = {}
    # For per-day add-ons, the specific ISO dates the guest selected. Empty
    # list (or missing key) means "every night of the stay".
    addon_dates: dict[str, list[str]] = {}
    promo_code: str | None = None


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
    number_of_rooms: int = 1
    total_amount: float
    addon_total: float = 0
    addon_ids: list[str] = []
    addon_names: list[str] = []
    addon_quantities: dict[str, int] = {}
    addon_dates: dict[str, list[str]] = {}
    currency: str
    status: str
    payment_method: str | None = None
    payment_status: str | None = None
    host_response_deadline: str | None = None
    created_at: str

    @field_validator("addon_ids", "addon_names", mode="before")
    @classmethod
    def parse_addon_list(cls, v):
        if isinstance(v, str):
            return json.loads(v)
        if v is None:
            return []
        return v

    @field_validator("addon_quantities", mode="before")
    @classmethod
    def parse_addon_quantities(cls, v):
        if isinstance(v, str):
            return json.loads(v)
        if v is None:
            return {}
        return v

    @field_validator("addon_dates", mode="before")
    @classmethod
    def parse_addon_dates(cls, v):
        if isinstance(v, str):
            return json.loads(v)
        if v is None:
            return {}
        return v


class AdminBookingCreate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    room_id: str
    guest_first_name: str
    guest_last_name: str
    guest_email: EmailStr
    guest_phone: str = ""
    guest_country: str = ""
    special_requests: str = ""
    check_in: date
    check_out: date
    adults: int = 1
    children: int = 0
    nightly_rate: float | None = None
    channel: str = "direct"


class AssignedRoom(BaseModel):
    """One physical room a booking occupies. position 0 is the primary room
    (bookings.room_id); 1..N-1 are the extra rooms of a multi-room booking
    (VAY-403)."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    room_id: str | None = None
    room_number: str | None = None
    position: int = 0


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
    guest_country: str = ""
    guest_gender: str = ""
    guest_date_of_birth: str | None = None
    guest_passport_number: str = ""
    special_requests: str
    estimated_arrival_time: str | None = None
    number_of_guests: int | None = None
    check_in: str
    check_out: str
    nights: int
    adults: int
    children: int
    nightly_rate: float
    number_of_rooms: int = 1
    total_amount: float
    currency: str
    status: str
    room_id: str | None = None
    room_number: str | None = None
    # Full ordered room list incl. the primary at position 0. For a
    # single-room booking this is just the primary; for a multi-room
    # booking it is every physical room the guest paid for (VAY-403).
    assigned_rooms: list[AssignedRoom] = []
    channel: str = "direct"
    payment_method: str | None = None
    payment_status: str | None = None
    check_in_pending_flags: list[str] = []
    checked_in_at: str | None = None
    host_response_deadline: str | None = None
    platform_fee_amount: float | None = None
    affiliate_commission_amount: float | None = None
    property_payout_amount: float | None = None
    addon_ids: list[str] = []
    addon_names: list[str] = []
    addon_total: float = 0
    addon_quantities: dict[str, int] = {}
    addon_dates: dict[str, list[str]] = {}
    guest_withdrawn: bool = False
    promo_code: str | None = None
    promo_discount: float = 0
    last_minute_discount_percent: float = 0
    last_minute_discount_amount: float = 0
    created_at: str
    updated_at: str

    @field_validator("addon_ids", mode="before")
    @classmethod
    def parse_addon_ids(cls, v):
        if isinstance(v, str):
            return json.loads(v)
        return v

    @field_validator("addon_names", mode="before")
    @classmethod
    def parse_addon_names(cls, v):
        if isinstance(v, str):
            return json.loads(v)
        if v is None:
            return []
        return v

    @field_validator("addon_quantities", mode="before")
    @classmethod
    def parse_addon_quantities(cls, v):
        if isinstance(v, str):
            return json.loads(v)
        return v

    @field_validator("addon_dates", mode="before")
    @classmethod
    def parse_addon_dates(cls, v):
        if isinstance(v, str):
            return json.loads(v)
        if v is None:
            return {}
        return v

    @field_validator("check_in_pending_flags", mode="before")
    @classmethod
    def parse_check_in_pending_flags(cls, v):
        if isinstance(v, str):
            return json.loads(v)
        if v is None:
            return []
        return v


class BookingStatusUpdate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    status: str  # 'confirmed' or 'cancelled'. Check-in uses the dedicated endpoint.


class BookingCheckInComplete(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    pending_flags: list[str] = []


class BookingArrivalCharge(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    amount: float
    description: str | None = None


class BookingDetailsUpdate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    check_in: str | None = None
    check_out: str | None = None
    guest_first_name: str | None = None
    guest_last_name: str | None = None
    guest_email: str | None = None
    guest_phone: str | None = None
    guest_country: str | None = None
    guest_gender: str | None = None
    guest_date_of_birth: str | None = None
    guest_passport_number: str | None = None
    adults: int | None = None
    children: int | None = None
    nightly_rate: float | None = None
    addon_ids: list[str] | None = None
    addon_quantities: dict[str, int] | None = None
    addon_dates: dict[str, list[str]] | None = None
    special_requests: str | None = None


class BookingRoomAssign(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    room_id: str
    # VAY-403: which of a multi-room booking's rooms to move. Omitted (or
    # equal to the primary) moves the primary room exactly as before;
    # otherwise the matching extra room is reassigned independently.
    from_room_id: str | None = None


class BookingRoomSwap(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    partner_booking_id: str
    # Optional: only used when the source booking is unassigned. The partner
    # then moves to this free room while the source takes the partner's room.
    partner_destination_room_id: str | None = None


class BookingLookup(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    booking_reference: str
    guest_email: EmailStr


class ChangeRequestPayload(BaseModel):
    """Guest-supplied desired state for a booking change request."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    guest_email: EmailStr
    check_in: date
    check_out: date
    addon_ids: list[str] = []
    addon_quantities: dict[str, int] = {}
    addon_dates: dict[str, list[str]] = {}


class ChangeRequestPreview(BaseModel):
    """Returned by the preview endpoint so the guest can see the price diff
    (and any block reason) before they submit."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    old_total: float
    new_total: float
    price_difference: float
    currency: str
    blocked: bool = False
    block_reason: str | None = None
    available: bool = True


class ChangeRequestResponse(BaseModel):
    """Full change-request row, returned to guest UI + PMS UI."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    booking_id: str
    status: str  # pending | approved | declined | cancelled
    old_check_in: str
    old_check_out: str
    old_addon_ids: list[str] = []
    old_addon_quantities: dict[str, int] = {}
    old_addon_dates: dict[str, list[str]] = {}
    old_total: float
    requested_check_in: str
    requested_check_out: str
    requested_addon_ids: list[str] = []
    requested_addon_quantities: dict[str, int] = {}
    requested_addon_dates: dict[str, list[str]] = {}
    requested_addon_names: list[str] = []
    new_total: float
    price_difference: float
    currency: str
    decline_reason: str | None = None
    decided_at: str | None = None
    created_at: str

    @field_validator(
        "old_addon_ids",
        "old_addon_quantities",
        "old_addon_dates",
        "requested_addon_ids",
        "requested_addon_quantities",
        "requested_addon_dates",
        "requested_addon_names",
        mode="before",
    )
    @classmethod
    def parse_json(cls, v):
        if isinstance(v, str):
            return json.loads(v)
        return v


class ChangeRequestDecline(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    reason: str | None = None


# ── Booking detail page extras (VAY-495) ──────────────────────────────


class BookingNoteCreate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    body: str


class BookingNoteResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    booking_id: str
    author_user_id: str
    author_name: str
    body: str
    created_at: str


class BookingAdditionalGuestPayload(BaseModel):
    """Both create + update share this shape; all fields optional on update.
    room_position links the guest to one of the booking's rooms (0 = primary,
    1..N-1 = extras). null clears the assignment back to "unassigned"."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    first_name: str | None = None
    last_name: str | None = None
    gender: str | None = None
    nationality: str | None = None
    date_of_birth: date | None = None
    email: str | None = None
    phone: str | None = None
    passport_number: str | None = None
    room_position: int | None = None


class BookingAdditionalGuestResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    booking_id: str
    position: int
    first_name: str
    last_name: str
    gender: str
    nationality: str
    date_of_birth: str | None = None
    email: str
    phone: str
    passport_number: str
    # null = unassigned. 0 = primary room, 1..N-1 = extras.
    room_position: int | None = None
    created_at: str
    updated_at: str


class CancelBookingRequest(BaseModel):
    """Body for the explicit cancel endpoint (VAY-495 — cancellation now
    requires a reason and applies to every room in the booking)."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    reason: str
