import logging

from app.models.hotel import (
    AddonResponse,
    HotelBranding,
    HotelContact,
    HotelResponse,
    HotelSocialLinks,
)
from app.models.utils import parse_json, parse_json_list
from app.repositories.booking_addon_repo import BookingAddonRepository
from app.repositories.booking_hotel_repo import BookingHotelRepository

logger = logging.getLogger(__name__)


async def get_hotel_by_slug(slug: str, locale: str = "en") -> HotelResponse | None:
    if locale and locale != "en":
        row = await BookingHotelRepository.get_by_slug_translated(slug, locale)
    else:
        row = await BookingHotelRepository.get_by_slug(slug)

    if not row:
        return None

    use_translated = locale != "en"
    name = row.get("t_name", row["name"]) if use_translated else row["name"]
    description = (
        row.get("t_description", row["description"]) if use_translated else row["description"]
    )
    location = row.get("t_location", row["location"]) if use_translated else row["location"]
    country = row.get("t_country", row["country"]) if use_translated else row["country"]
    contact_address = (
        row.get("t_contact_address", row["contact_address"])
        if use_translated
        else row["contact_address"]
    )
    raw_amenities = row.get("t_amenities", row["amenities"]) if use_translated else row["amenities"]

    contact = HotelContact(
        address=contact_address,
        phone=row["contact_phone"],
        email=row["contact_email"],
        whatsapp=row["contact_whatsapp"],
    )

    social_links = None
    if any(
        row[k] for k in ["social_facebook", "social_instagram", "social_tiktok", "social_youtube"]
    ):
        social_links = HotelSocialLinks(
            facebook=row["social_facebook"],
            instagram=row["social_instagram"],
            tiktok=row["social_tiktok"],
            youtube=row["social_youtube"],
        )

    branding = None
    if row["branding_primary_color"]:
        branding = HotelBranding(
            primary_color=row["branding_primary_color"],
            accent_color=row.get("branding_accent_color"),
            font_pairing=row.get("branding_font_pairing"),
            logo_url=row["branding_logo_url"],
            favicon_url=row["branding_favicon_url"],
        )

    return HotelResponse(
        id=str(row["id"]),
        name=name,
        slug=row["slug"],
        description=description,
        location=location,
        country=country,
        star_rating=row["star_rating"],
        currency=row["currency"],
        supported_currencies=parse_json(row.get("supported_currencies")),
        booking_filters=parse_json(row.get("booking_filters")),
        custom_filters=parse_json(row.get("custom_filters"), default={}),
        filter_rooms=parse_json(row.get("filter_rooms"), default={}),
        hero_image=row["hero_image"],
        images=parse_json(row["images"]),
        amenities=parse_json(raw_amenities),
        check_in_time=row["check_in_time"],
        check_out_time=row["check_out_time"],
        timezone=row.get("timezone") or "UTC",
        contact=contact,
        social_links=social_links,
        branding=branding,
        default_language=row.get("default_language") or "en",
        supported_languages=parse_json(row.get("supported_languages"), default=["en"]),
        refer_a_guest_enabled=row.get("refer_a_guest_enabled", False),
        instant_book=row.get("instant_book", False),
        map_view_enabled=row.get("map_view_enabled", False),
        show_room_detail_map=row.get("show_room_detail_map", False),
        points_of_interest=parse_json(row.get("points_of_interest"), default=[]),
    )


async def get_addons_by_hotel_slug(slug: str) -> list[AddonResponse]:
    hotel = await BookingHotelRepository.get_by_slug(slug)
    if not hotel or not hotel.get("show_addons_step", True):
        return []
    rows = await BookingAddonRepository.list_by_hotel_id(str(hotel["id"]))
    return [
        AddonResponse(
            id=str(row["id"]),
            name=row["name"],
            description=row["description"],
            price=float(row["price"]),
            currency=row["currency"],
            category=row["category"],
            image=row["image"],
            duration=row.get("duration"),
            per_person=row.get("per_person"),
            per_night=row.get("per_night"),
            location=row.get("location", ""),
            max_guests=row.get("max_guests", ""),
            highlights=parse_json_list(row.get("highlights")),
            included_items=parse_json_list(row.get("included_items")),
        )
        for row in rows
    ]
