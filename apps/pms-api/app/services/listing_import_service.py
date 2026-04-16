import asyncio
import logging
import re
from typing import Tuple
from urllib.parse import urlparse

import httpx

from app.config import settings
from app.image_processing import process_image, generate_thumbnail
from app.models.listing_import import (
    ExtractedRoomType,
    ListingImportPreview,
)
from app.repositories.room_type_repo import RoomTypeRepository
from app.s3_service import upload_file_to_s3, generate_file_key
from app.services.claude_service import extract_structured_data

logger = logging.getLogger(__name__)

BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
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
    raise ValueError(f"Unsupported platform: {host}. Only Booking.com and Airbnb URLs are supported.")


async def scrape_listing(url: str) -> Tuple[str, str]:
    """Fetch listing page HTML. Returns (html, platform)."""
    url = _normalize_url(url)
    platform = detect_platform(url)

    async with httpx.AsyncClient(
        follow_redirects=True,
        timeout=settings.LISTING_IMPORT_SCRAPE_TIMEOUT,
    ) as client:
        response = await client.get(url, headers=BROWSER_HEADERS)
        response.raise_for_status()

    return response.text, platform


async def extract_listing_data(url: str) -> ListingImportPreview:
    """Scrape a listing URL and extract structured data via Claude."""
    html, platform = await scrape_listing(url)

    # Strip <script> and <style> tags to reduce noise (keep <script type="application/ld+json">)
    cleaned = re.sub(
        r'<script(?!\s+type=["\']application/ld\+json)[^>]*>.*?</script>',
        "",
        html,
        flags=re.DOTALL | re.IGNORECASE,
    )
    cleaned = re.sub(r"<style[^>]*>.*?</style>", "", cleaned, flags=re.DOTALL | re.IGNORECASE)

    extracted = await extract_structured_data(cleaned)

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
