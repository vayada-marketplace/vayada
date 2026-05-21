from pydantic import BaseModel, ConfigDict

from app.models.utils import to_camel


class RoomTypeCreate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    name: str
    description: str = ""
    short_description: str = ""
    max_occupancy: int = 2
    size: int = 0
    base_rate: float = 0
    currency: str = "EUR"
    amenities: list[str] = []
    images: list[str] = []
    bed_type: str = ""
    features: list[str] = []
    total_rooms: int = 2
    is_active: bool = True
    sort_order: int = 0


class RoomTypeUpdate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    name: str | None = None
    description: str | None = None
    short_description: str | None = None
    max_occupancy: int | None = None
    size: int | None = None
    base_rate: float | None = None
    currency: str | None = None
    amenities: list[str] | None = None
    images: list[str] | None = None
    bed_type: str | None = None
    features: list[str] | None = None
    total_rooms: int | None = None
    is_active: bool | None = None
    sort_order: int | None = None


class RoomTypeAdminResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    hotel_id: str
    name: str
    description: str
    short_description: str
    max_occupancy: int
    size: int
    base_rate: float
    currency: str
    amenities: list[str]
    images: list[str]
    bed_type: str
    features: list[str]
    total_rooms: int
    is_active: bool
    sort_order: int
    created_at: str
    updated_at: str
