"""
Upload-related Pydantic models
"""
from pydantic import BaseModel
from typing import List, Optional


# ============================================
# IMAGE UPLOAD RESPONSES
# ============================================

class ImageUploadResponse(BaseModel):
    """Response model for single image upload"""
    url: str
    thumbnail_url: Optional[str] = None
    key: str
    width: int
    height: int
    size_bytes: int
    format: str


class MultipleImageUploadResponse(BaseModel):
    """Response model for multiple image uploads"""
    images: List[ImageUploadResponse]
    total: int
