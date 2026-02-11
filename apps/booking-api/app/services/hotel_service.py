import json
import logging
from typing import Optional, List
from app.repositories.booking_hotel_repo import BookingHotelRepository
from app.models.hotel import (
    HotelResponse,
    HotelContact,
    HotelSocialLinks,
    HotelBranding,
    RoomTypeResponse,
    AddonResponse,
)

logger = logging.getLogger(__name__)


async def get_hotel_by_slug(slug: str, locale: str = "en") -> Optional[HotelResponse]:
    if locale and locale != "en":
        row = await BookingHotelRepository.get_by_slug_translated(slug, locale)
    else:
        row = await BookingHotelRepository.get_by_slug(slug)

    if not row:
        return None

    # Use translated fields when available (non-English locale)
    name = row.get("t_name", row["name"]) if locale != "en" else row["name"]
    description = row.get("t_description", row["description"]) if locale != "en" else row["description"]
    location = row.get("t_location", row["location"]) if locale != "en" else row["location"]
    country = row.get("t_country", row["country"]) if locale != "en" else row["country"]
    contact_address = row.get("t_contact_address", row["contact_address"]) if locale != "en" else row["contact_address"]
    raw_amenities = row.get("t_amenities", row["amenities"]) if locale != "en" else row["amenities"]

    contact = HotelContact(
        address=contact_address,
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
    amenities = json.loads(raw_amenities) if isinstance(raw_amenities, str) else raw_amenities

    return HotelResponse(
        id=str(row["id"]),
        name=name,
        slug=row["slug"],
        description=description,
        location=location,
        country=country,
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
