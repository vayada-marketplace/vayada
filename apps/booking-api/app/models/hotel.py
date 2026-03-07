from pydantic import BaseModel, ConfigDict
from typing import Dict, Optional, List

from app.models.utils import to_camel


class HotelContact(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    address: str
    phone: str
    email: str
    whatsapp: Optional[str] = None


class HotelSocialLinks(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    facebook: Optional[str] = None
    instagram: Optional[str] = None
    twitter: Optional[str] = None
    youtube: Optional[str] = None


class HotelBranding(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    primary_color: str
    accent_color: Optional[str] = None
    font_pairing: Optional[str] = None
    logo_url: Optional[str] = None
    favicon_url: Optional[str] = None


class HotelResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    name: str
    slug: str
    description: str
    location: str
    country: str
    star_rating: int
    currency: str
    supported_currencies: List[str] = []
    hero_image: str
    images: List[str]
    amenities: List[str]
    check_in_time: str
    check_out_time: str
    contact: HotelContact
    social_links: Optional[HotelSocialLinks] = None
    booking_filters: List[str] = []
    custom_filters: Dict[str, str] = {}
    branding: Optional[HotelBranding] = None


class RoomTypeResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
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
    remaining_rooms: int
    features: List[str]


# Re-export addon models for backwards compatibility
from app.models.addon import (  # noqa: E402, F401
    AddonResponse,
    CreateAddonRequest,
    UpdateAddonRequest,
    AddonSettingsResponse,
    AddonSettingsUpdate,
)
