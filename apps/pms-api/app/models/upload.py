from pydantic import BaseModel


class ImageUploadResponse(BaseModel):
    url: str
    thumbnail_url: str | None = None
    key: str
    width: int
    height: int
    size_bytes: int
    format: str


class MultipleImageUploadResponse(BaseModel):
    images: list[ImageUploadResponse]
    total: int
