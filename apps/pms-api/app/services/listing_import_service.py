import logging
from urllib.parse import urlparse

from firecrawl import FirecrawlApp

from app.config import settings
from app.models.listing_import import (
    ExtractedRoomType,
    ListingImportPreview,
)
from app.services.claude_service import extract_structured_data

logger = logging.getLogger(__name__)

def _normalize_url(url: str) -> str:
    """Ensure URL has a protocol prefix."""
    url = url.strip()
    if not url.startswith("http://") and not url.startswith("https://"):
        url = "https://www." + url
    return url


def detect_platform(url: str) -> str:
    """Detect platform from URL domain."""
    host = urlparse(url).hostname or ""
    if "booking.com" in host:
        return "booking"
    if "airbnb" in host:
        return "airbnb"
    raise ValueError(
        f"Unsupported platform: {host}. Only Booking.com and Airbnb URLs are supported."
    )


async def scrape_listing(url: str) -> tuple[str, str]:
    """Scrape listing page via Firecrawl. Returns (markdown, platform)."""
    url = _normalize_url(url)
    platform = detect_platform(url)

    app = FirecrawlApp(api_key=settings.FIRECRAWL_API_KEY)
    result = app.scrape(url, formats=["markdown"])

    markdown = result.markdown or ""
    if not markdown:
        raise ValueError("Firecrawl returned no content for this URL")

    return markdown, platform


async def extract_listing_data(url: str) -> ListingImportPreview:
    """Scrape a listing URL and extract structured data via Claude."""
    content, platform = await scrape_listing(url)

    # Truncate to stay within context limits
    max_chars = settings.LISTING_IMPORT_MAX_CHARS
    if len(content) > max_chars:
        content = content[:max_chars]

    extracted = await extract_structured_data(content)

    room_types = []
    for rt in extracted.get("room_types", []):
        room_types.append(
            ExtractedRoomType(
                name=rt.get("name", ""),
                description=rt.get("description", ""),
                short_description=rt.get("short_description", ""),
                max_occupancy=rt.get("max_occupancy", 2),
                size=rt.get("size", 0),
                bed_type=rt.get("bed_type", ""),
                base_rate=rt.get("base_rate", 0),
                currency=rt.get("currency", "EUR"),
                amenities=rt.get("amenities", []),
                features=rt.get("features", []),
                source_image_urls=rt.get("image_urls", []),
                cancellation_policy=rt.get("cancellation_policy", ""),
            )
        )

    return ListingImportPreview(
        source_platform=platform,
        source_url=url,
        room_types=room_types,
        hotel_name=extracted.get("hotel_name", ""),
        hotel_description=extracted.get("hotel_description", ""),
    )


async def create_platform_media_import_job(
    image_urls: list[str],
    auth_header: str,
    pms_hotel_id: str,
    room_type_id: str,
) -> dict:
    """Skip external image import while production uses the legacy media backend."""
    if not image_urls:
        return {"message": "No images to import"}

    return {"message": "Image import is not available on the legacy media backend"}
