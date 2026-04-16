from pydantic import BaseModel, ConfigDict
from typing import List, Optional


def to_camel(string: str) -> str:
    parts = string.split("_")
    return parts[0] + "".join(w.capitalize() for w in parts[1:])


class ExtractedRoomType(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    name: str = ""
    description: str = ""
    short_description: str = ""
    max_occupancy: int = 2
    size: int = 0
    bed_type: str = ""
    base_rate: float = 0
    currency: str = "EUR"
    amenities: List[str] = []
    features: List[str] = []
    source_image_urls: List[str] = []
    cancellation_policy: str = ""


class ListingImportRequest(BaseModel):
    url: str


class ListingImportPreview(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    source_platform: str  # "booking" or "airbnb"
    source_url: str
    room_types: List[ExtractedRoomType]
    hotel_name: str = ""
    hotel_description: str = ""


class ListingImportConfirmRoomType(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    name: str
    description: str = ""
    short_description: str = ""
    max_occupancy: int = 2
    size: int = 0
    bed_type: str = ""
    base_rate: float = 0
    currency: str = "EUR"
    amenities: List[str] = []
    features: List[str] = []
    source_image_urls: List[str] = []
    total_rooms: int = 1


class ListingImportConfirm(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    room_types: List[ListingImportConfirmRoomType]


class ListingImportResult(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    room_type_ids: List[str]
    images_pending: bool
    message: str


class ImportImagesRequest(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    room_type_id: str
    source_image_urls: List[str]
