from pydantic import BaseModel, ConfigDict


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
    amenities: list[str] = []
    features: list[str] = []
    source_image_urls: list[str] = []
    cancellation_policy: str = ""


class ListingImportRequest(BaseModel):
    url: str


class ListingImportPreview(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    source_platform: str  # "booking" or "airbnb"
    source_url: str
    room_types: list[ExtractedRoomType]
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
    amenities: list[str] = []
    features: list[str] = []
    source_image_urls: list[str] = []
    total_rooms: int = 1


class ListingImportConfirm(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    room_types: list[ListingImportConfirmRoomType]


class ListingImportResult(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    room_type_ids: list[str]
    images_pending: bool
    message: str


class ImportImagesRequest(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    room_type_id: str
    source_image_urls: list[str]
