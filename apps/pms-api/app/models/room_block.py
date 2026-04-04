from pydantic import BaseModel, ConfigDict
from datetime import date
from typing import Optional


def to_camel(string: str) -> str:
    parts = string.split("_")
    return parts[0] + "".join(w.capitalize() for w in parts[1:])


class RoomBlockCreate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    room_type_id: str
    start_date: date
    end_date: date
    blocked_count: int = 1
    reason: str = ""


class RoomBlockUpdate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    start_date: Optional[date] = None
    end_date: Optional[date] = None
    blocked_count: Optional[int] = None
    reason: Optional[str] = None


class RoomBlockResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    room_type_id: str
    start_date: str
    end_date: str
    blocked_count: int
    reason: str
    created_at: str
