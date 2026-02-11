from pydantic import BaseModel, ConfigDict
from typing import Optional, List


def to_camel(string: str) -> str:
    parts = string.split("_")
    return parts[0] + "".join(w.capitalize() for w in parts[1:])


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
    hero_image: str
    images: List[str]
    amenities: List[str]
    check_in_time: str
    check_out_time: str
    contact: HotelContact
    social_links: Optional[HotelSocialLinks] = None
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


class AddonResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    name: str
    description: str
    price: float
    currency: str
    category: str
    image: str
    duration: Optional[str] = None
    per_person: Optional[bool] = None
