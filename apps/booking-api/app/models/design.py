from pydantic import BaseModel
from typing import Optional


class DesignSettingsResponse(BaseModel):
    hero_image: str
    hero_heading: str
    hero_subtext: str
    primary_color: str
    accent_color: str
    font_pairing: str


class DesignSettingsUpdate(BaseModel):
    hero_image: Optional[str] = None
    hero_heading: Optional[str] = None
    hero_subtext: Optional[str] = None
    primary_color: Optional[str] = None
    accent_color: Optional[str] = None
    font_pairing: Optional[str] = None
