from pydantic import BaseModel
from typing import List, Optional


class ImageUploadResponse(BaseModel):
    url: str
    thumbnail_url: Optional[str] = None
    key: str
    width: int
    height: int
    size_bytes: int
    format: str


class MultipleImageUploadResponse(BaseModel):
    images: List[ImageUploadResponse]
    total: int
