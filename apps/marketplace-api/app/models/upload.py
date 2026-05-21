"""
Upload-related Pydantic models
"""

from pydantic import BaseModel

# ============================================
# IMAGE UPLOAD RESPONSES
# ============================================


class ImageUploadResponse(BaseModel):
    """Response model for single image upload"""

    url: str
    thumbnail_url: str | None = None
    key: str
    width: int
    height: int
    size_bytes: int
    format: str


class MultipleImageUploadResponse(BaseModel):
    """Response model for multiple image uploads"""

    images: list[ImageUploadResponse]
    total: int
