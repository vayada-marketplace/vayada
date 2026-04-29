"""Response shape for GET /admin/calendar — the rooms-eye view of bookings,
blocks, and room types over a date range. Frontend expects camelCase keys."""
from typing import List, Optional

from pydantic import BaseModel, ConfigDict


def to_camel(string: str) -> str:
    parts = string.split("_")
    return parts[0] + "".join(w.capitalize() for w in parts[1:])


class _CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class CalendarRoomType(_CamelModel):
    id: str
    name: str
    category: str = ""
    total_rooms: int
    base_rate: float
    max_occupancy: int = 2
    currency: str


class CalendarRoom(_CamelModel):
    id: str
    room_type_id: str
    room_type_name: str
    room_number: str
    floor: str
    status: str


class CalendarBooking(_CamelModel):
    id: str
    room_type_id: str
    room_name: str
    guest_first_name: str
    guest_last_name: str
    check_in: str
    check_out: str
    status: str
    room_id: Optional[str] = None
    room_number: Optional[str] = None
    channel: str = "direct"
    booking_reference: str


class CalendarBlock(_CamelModel):
    id: str
    room_type_id: str
    room_id: Optional[str] = None
    room_number: Optional[str] = None
    start_date: str
    end_date: str
    blocked_count: int
    reason: Optional[str] = None
    created_at: str


class CalendarResponse(_CamelModel):
    room_types: List[CalendarRoomType] = []
    rooms: List[CalendarRoom] = []
    bookings: List[CalendarBooking] = []
    blocks: List[CalendarBlock] = []
