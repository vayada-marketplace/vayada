from pydantic import BaseModel, ConfigDict
from typing import Optional


def to_camel(string: str) -> str:
    parts = string.split("_")
    return parts[0] + "".join(w.capitalize() for w in parts[1:])


class RoomCreate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    room_type_id: str
    room_number: str
    floor: str = ""
    status: str = "available"
    sort_order: int = 0


class RoomUpdate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    room_type_id: Optional[str] = None
    room_number: Optional[str] = None
    floor: Optional[str] = None
    status: Optional[str] = None
    sort_order: Optional[int] = None


class RoomResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    hotel_id: str
    room_type_id: str
    room_type_name: str
    room_number: str
    floor: str
    status: str
    sort_order: int
    created_at: str
    updated_at: str
