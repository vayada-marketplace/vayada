from pydantic import BaseModel, ConfigDict
from typing import Optional, List

from app.models.hotel import to_camel


class RoomTypeCreate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    name: str
    description: str = ''
    short_description: str = ''
    max_occupancy: int = 2
    size: int = 0
    base_rate: float = 0
    currency: str = 'EUR'
    amenities: List[str] = []
    images: List[str] = []
    bed_type: str = ''
    features: List[str] = []
    total_rooms: int = 1
    is_active: bool = True
    sort_order: int = 0


class RoomTypeUpdate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    name: Optional[str] = None
    description: Optional[str] = None
    short_description: Optional[str] = None
    max_occupancy: Optional[int] = None
    size: Optional[int] = None
    base_rate: Optional[float] = None
    currency: Optional[str] = None
    amenities: Optional[List[str]] = None
    images: Optional[List[str]] = None
    bed_type: Optional[str] = None
    features: Optional[List[str]] = None
    total_rooms: Optional[int] = None
    is_active: Optional[bool] = None
    sort_order: Optional[int] = None


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
    amenities: List[str]
    images: List[str]
    bed_type: str
    features: List[str]
    total_rooms: int
    is_active: bool
    sort_order: int
    created_at: str
    updated_at: str
