import json
import logging
from typing import Optional

import anthropic

from app.config import settings

logger = logging.getLogger(__name__)

_client: Optional[anthropic.AsyncAnthropic] = None


def _get_client() -> anthropic.AsyncAnthropic:
    global _client
    if _client is None:
        _client = anthropic.AsyncAnthropic(api_key=settings.ANTHROPIC_API_KEY)
    return _client


EXTRACTION_TOOL = {
    "name": "extract_listing",
    "description": "Extract structured hotel/property listing data from the provided page content.",
    "input_schema": {
        "type": "object",
        "properties": {
            "hotel_name": {
                "type": "string",
                "description": "The name of the hotel or property",
            },
            "hotel_description": {
                "type": "string",
                "description": "A general description of the hotel/property (not specific room types)",
            },
            "room_types": {
                "type": "array",
                "description": "List of room types found in the listing",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string", "description": "Room type name"},
                        "description": {
                            "type": "string",
                            "description": "Detailed room description",
                        },
                        "short_description": {
                            "type": "string",
                            "description": "One-line summary, max 150 chars",
                        },
                        "max_occupancy": {
                            "type": "integer",
                            "description": "Maximum number of guests",
                        },
                        "size": {
                            "type": "integer",
                            "description": "Room size in square meters (m2). Convert from sqft if needed.",
                        },
                        "bed_type": {
                            "type": "string",
                            "description": "Bed configuration, e.g. 'King Bed', 'Twin Beds', '1 Double Bed and 1 Sofa Bed'",
                        },
                        "base_rate": {
                            "type": "number",
                            "description": "Nightly rate in the listing currency. Use 0 if not found.",
                        },
                        "currency": {
                            "type": "string",
                            "description": "3-letter currency code (EUR, USD, IDR, etc.)",
                        },
                        "amenities": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Room amenities. Map to these known values when possible: "
                            "Free WiFi, Flat-screen TV, Smart TV, Netflix / Streaming, Work desk, "
                            "Laptop-friendly workspace, Minibar, Refrigerator, Microwave, Kitchenware, "
                            "Electric kettle, Stovetop, Dining table, Bath, Shower, Free toiletries, "
                            "Hairdryer, Toilet, Toilet paper, Hot Tub, Towels, Slippers, Bathrobe, "
                            "Air conditioning, Heating, Fan, Fireplace, Extra pillows, Blackout curtains, "
                            "Wardrobe, Bed linen, Washing machine, Dryer, Iron/Ironing board, Clothes rack, "
                            "Safe, 24hr Security, Smoke detector, First aid kit, Fire extinguisher, "
                            "Room service, Daily housekeeping, Concierge, Parking, Non-smoking, "
                            "Adults-Only, Outdoor furniture",
                        },
                        "features": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Room features/highlights. Map to these known values when possible: "
                            "Sea view, Ocean view, Mountain view, Garden view, Pool view, Beachfront, "
                            "Forest view, City view, Lake view, River view, Private Pool, Shared Pool, "
                            "Hot tub, BBQ, Outdoor dining area, Private terrace, Balcony, Garden, "
                            "Rooftop access, Entire villa, Entire apartment, Private entrance, "
                            "Penthouse, Duplex, Studio",
                        },
                        "image_urls": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Full URLs of room/property images found on the page",
                        },
                    },
                    "required": ["name"],
                },
            },
        },
        "required": ["room_types"],
    },
}

SYSTEM_PROMPT = """You are a data extraction assistant. Extract structured hotel/property listing data from the provided HTML page content.

Instructions:
- Extract ALL room types you can find on the page.
- For Booking.com pages, there are usually multiple room types listed in a table.
- For Airbnb pages, there is typically one listing (treat it as a single room type).
- Map amenities and features to the known values provided in the tool schema when there is a match. Use the exact label from the known values list. Only add custom values if no match exists.
- Extract image URLs — look for high-resolution image URLs (not thumbnails). On Booking.com, look for data-highres or src attributes in image elements. On Airbnb, look for image URLs in JSON data or picture elements.
- Convert room size to square meters if listed in square feet (1 sqft = 0.0929 m2).
- Extract the nightly rate and currency if visible on the page. Use 0 for base_rate if pricing is not clearly shown.
- For bed_type, describe the actual bed configuration (e.g. "1 King Bed", "2 Twin Beds", "1 Double Bed and 1 Sofa Bed").
- Write the description in a natural, appealing way suitable for a hotel booking site.
- Keep short_description under 150 characters."""


async def extract_structured_data(html_content: str) -> dict:
    """Send HTML to Claude and extract structured listing data using tool-use."""
    client = _get_client()

    # Truncate HTML to stay within context limits
    max_chars = settings.LISTING_IMPORT_MAX_HTML_CHARS
    if len(html_content) > max_chars:
        html_content = html_content[:max_chars]

    response = await client.messages.create(
        model=settings.LISTING_IMPORT_MODEL,
        max_tokens=8192,
        temperature=0,
        system=SYSTEM_PROMPT,
        tools=[EXTRACTION_TOOL],
        tool_choice={"type": "tool", "name": "extract_listing"},
        messages=[
            {
                "role": "user",
                "content": f"Extract the listing data from this page:\n\n{html_content}",
            }
        ],
    )

    # Extract tool use result
    for block in response.content:
        if block.type == "tool_use" and block.name == "extract_listing":
            return block.input

    logger.warning("Claude did not return tool use result")
    return {"room_types": []}
