import json
import logging
from typing import Optional, List
from app.database import Database
from app.models.hotel import (
    HotelResponse,
    HotelContact,
    HotelSocialLinks,
    HotelBranding,
    RoomTypeResponse,
    AddonResponse,
)

logger = logging.getLogger(__name__)


async def get_hotel_by_slug(slug: str) -> Optional[HotelResponse]:
    row = await Database.fetchrow(
        "SELECT * FROM booking_hotels WHERE slug = $1", slug
    )
    if not row:
        return None

    contact = HotelContact(
        address=row["contact_address"],
        phone=row["contact_phone"],
        email=row["contact_email"],
        whatsapp=row["contact_whatsapp"],
    )

    social_links = None
    if any(row[k] for k in ["social_facebook", "social_instagram", "social_twitter", "social_youtube"]):
        social_links = HotelSocialLinks(
            facebook=row["social_facebook"],
            instagram=row["social_instagram"],
            twitter=row["social_twitter"],
            youtube=row["social_youtube"],
        )

    branding = None
    if row["branding_primary_color"]:
        branding = HotelBranding(
            primary_color=row["branding_primary_color"],
            logo_url=row["branding_logo_url"],
            favicon_url=row["branding_favicon_url"],
        )

    images = json.loads(row["images"]) if isinstance(row["images"], str) else row["images"]
    amenities = json.loads(row["amenities"]) if isinstance(row["amenities"], str) else row["amenities"]

    return HotelResponse(
        id=str(row["id"]),
        name=row["name"],
        slug=row["slug"],
        description=row["description"],
        location=row["location"],
        country=row["country"],
        star_rating=row["star_rating"],
        currency=row["currency"],
        hero_image=row["hero_image"],
        images=images,
        amenities=amenities,
        check_in_time=row["check_in_time"],
        check_out_time=row["check_out_time"],
        contact=contact,
        social_links=social_links,
        branding=branding,
    )


async def get_rooms_by_hotel_slug(slug: str) -> List[RoomTypeResponse]:
    # Room types will come from PMS integration later.
    # For now, return empty list.
    return []


async def get_addons_by_hotel_slug(slug: str) -> List[AddonResponse]:
    # Addons will come from PMS integration later.
    # For now, return empty list.
    return []
