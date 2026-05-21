import asyncio
import logging
from urllib.parse import urlparse

import httpx
from firecrawl import FirecrawlApp

from app.config import settings
from app.image_processing import generate_thumbnail, process_image
from app.models.listing_import import (
    ExtractedRoomType,
    ListingImportPreview,
)
from app.repositories.room_type_repo import RoomTypeRepository
from app.s3_service import generate_file_key, upload_file_to_s3
from app.services.claude_service import extract_structured_data

logger = logging.getLogger(__name__)

BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "image/webp,image/*,*/*;q=0.8",
}


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


async def download_and_upload_images(
    image_urls: list[str],
    user_id: str,
    room_type_id: str,
):
    """Download images from source URLs, process, upload to S3, and update the room type."""
    sem = asyncio.Semaphore(5)
    uploaded_urls = []

    async def process_one(url: str) -> str | None:
        async with sem:
            try:
                async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
                    resp = await client.get(url, headers=BROWSER_HEADERS)
                    resp.raise_for_status()

                content = resp.content
                processed = process_image(content, resize_width=1920, resize_height=1920)
                file_key = generate_file_key("rooms", "imported.jpg", user_id)
                s3_url = await upload_file_to_s3(processed, file_key, "image/jpeg")

                # Generate thumbnail
                thumb = generate_thumbnail(content, size=300)
                thumb_key = file_key.replace(".", "_thumb.")
                await upload_file_to_s3(thumb, thumb_key, "image/jpeg")

                return s3_url
            except Exception as e:
                logger.warning("Failed to download/upload image %s: %s", url, e)
                return None

    tasks = [process_one(url) for url in image_urls]
    results = await asyncio.gather(*tasks)
    uploaded_urls = [r for r in results if r is not None]

    if uploaded_urls:
        await RoomTypeRepository.update(room_type_id, {"images": uploaded_urls})
        logger.info(
            "Uploaded %d/%d images for room type %s",
            len(uploaded_urls),
            len(image_urls),
            room_type_id,
        )
