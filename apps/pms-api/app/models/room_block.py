from pydantic import BaseModel, ConfigDict, Field
from datetime import date
from typing import Optional, List


def to_camel(string: str) -> str:
    parts = string.split("_")
    return parts[0] + "".join(w.capitalize() for w in parts[1:])


class RoomBlockCreate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    room_type_id: str
    room_ids: List[str] = Field(min_length=1)
    start_date: date
    end_date: date
    reason: str = ""


class RoomBlockUpdate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    start_date: Optional[date] = None
    end_date: Optional[date] = None
    reason: Optional[str] = None


class RoomBlockResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    room_type_id: str
    room_id: Optional[str] = None
    room_number: Optional[str] = None
    start_date: str
    end_date: str
    blocked_count: int
    reason: str
    created_at: str
