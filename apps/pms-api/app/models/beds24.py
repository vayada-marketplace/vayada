from pydantic import BaseModel, ConfigDict
from typing import Optional, List


def to_camel(string: str) -> str:
    parts = string.split("_")
    return parts[0] + "".join(w.capitalize() for w in parts[1:])


class Beds24ConnectRequest(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    invite_code: str


class Beds24ConnectionResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    hotel_id: str
    beds24_property_id: Optional[str] = None
    is_active: bool
    last_sync_at: Optional[str] = None
    created_at: str


class Beds24RoomMappingCreate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    room_type_id: str
    beds24_room_id: str


class Beds24RoomMappingResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    hotel_id: str
    room_type_id: str
    beds24_room_id: str
    created_at: str


class Beds24SetPropertyRequest(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    beds24_property_id: str


class Beds24PropertyResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    name: str


class Beds24RoomResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    name: str
    qty: int = 1
