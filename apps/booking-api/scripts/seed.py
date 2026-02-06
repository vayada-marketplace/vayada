"""
Seed script — inserts 3 example hotels into booking_hotels.

Usage:
    python scripts/seed.py

Requires DATABASE_URL env var or .env file.
"""

import asyncio
import json
import os
import sys

# Allow importing app modules when run from project root
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import asyncpg
from dotenv import load_dotenv

load_dotenv()

HOTELS = [
    {
        "name": "Hotel Alpenrose",
        "slug": "hotel-alpenrose",
        "description": "A boutique alpine retreat featuring panoramic mountain views, world-class spa facilities, and refined Austrian hospitality in the heart of Innsbruck.",
        "location": "Innsbruck, Austria",
        "country": "Austria",
        "star_rating": 4,
        "currency": "EUR",
        "hero_image": "https://images.unsplash.com/photo-1566073771259-6a8506099945?w=1920&q=80",
        "images": [
            "https://images.unsplash.com/photo-1566073771259-6a8506099945?w=800&q=80",
            "https://images.unsplash.com/photo-1582719508461-905c673771fd?w=800&q=80",
            "https://images.unsplash.com/photo-1551882547-ff40c63fe5fa?w=800&q=80",
        ],
        "amenities": [
            "Free WiFi",
            "Spa & Wellness",
            "Restaurant",
            "Bar & Lounge",
            "Fitness Center",
            "Room Service",
            "Concierge",
            "Airport Shuttle",
            "Ski Storage",
            "Mountain Views",
        ],
        "check_in_time": "15:00",
        "check_out_time": "11:00",
        "contact_address": "Alpengasse 12, 6020 Innsbruck, Austria",
        "contact_phone": "+43 512 123 456",
        "contact_email": "reservations@hotel-alpenrose.at",
        "contact_whatsapp": "+43 512 123 456",
        "social_facebook": "https://facebook.com/hotelalpenrose",
        "social_instagram": "https://instagram.com/hotelalpenrose",
        "branding_primary_color": "#1E3EDB",
    },
    {
        "name": "Grand Hotel Riviera",
        "slug": "grand-hotel-riviera",
        "description": "An elegant Mediterranean escape perched on the Amalfi Coast cliffs, offering stunning sea views, a private beach, and authentic Italian fine dining.",
        "location": "Amalfi, Italy",
        "country": "Italy",
        "star_rating": 5,
        "currency": "EUR",
        "hero_image": "https://images.unsplash.com/photo-1520250497591-112f2f40a3f4?w=1920&q=80",
        "images": [
            "https://images.unsplash.com/photo-1520250497591-112f2f40a3f4?w=800&q=80",
            "https://images.unsplash.com/photo-1571896349842-33c89424de2d?w=800&q=80",
            "https://images.unsplash.com/photo-1542314831-068cd1dbfeeb?w=800&q=80",
        ],
        "amenities": [
            "Free WiFi",
            "Private Beach",
            "Infinity Pool",
            "Fine Dining",
            "Spa & Wellness",
            "Room Service",
            "Valet Parking",
            "Concierge",
            "Boat Tours",
            "Sea Views",
        ],
        "check_in_time": "14:00",
        "check_out_time": "12:00",
        "contact_address": "Via Costiera Amalfitana 88, 84011 Amalfi, Italy",
        "contact_phone": "+39 089 831 234",
        "contact_email": "reservations@grandhotelriviera.it",
        "contact_whatsapp": "+39 089 831 234",
        "social_facebook": "https://facebook.com/grandhotelriviera",
        "social_instagram": "https://instagram.com/grandhotelriviera",
        "branding_primary_color": "#0E7C6B",
    },
    {
        "name": "The Birchwood Lodge",
        "slug": "the-birchwood-lodge",
        "description": "A cozy lakeside lodge nestled in the Scottish Highlands, combining rustic charm with modern comfort for the perfect countryside getaway.",
        "location": "Inverness, Scotland",
        "country": "United Kingdom",
        "star_rating": 3,
        "currency": "GBP",
        "hero_image": "https://images.unsplash.com/photo-1587061949409-02df41d5e562?w=1920&q=80",
        "images": [
            "https://images.unsplash.com/photo-1587061949409-02df41d5e562?w=800&q=80",
            "https://images.unsplash.com/photo-1596394516093-501ba68a0ba6?w=800&q=80",
            "https://images.unsplash.com/photo-1445019980597-93fa8acb246c?w=800&q=80",
        ],
        "amenities": [
            "Free WiFi",
            "Fireplace Lounge",
            "Restaurant",
            "Hiking Trails",
            "Kayak Rental",
            "Free Parking",
            "Pet Friendly",
            "Loch Views",
        ],
        "check_in_time": "16:00",
        "check_out_time": "10:00",
        "contact_address": "12 Lochside Road, Inverness IV3 8LA, Scotland",
        "contact_phone": "+44 1463 123 456",
        "contact_email": "hello@birchwoodlodge.co.uk",
        "social_instagram": "https://instagram.com/birchwoodlodge",
        "branding_primary_color": "#8B5E3C",
    },
]

INSERT_SQL = """
    INSERT INTO booking_hotels (
        name, slug, description, location, country, star_rating, currency,
        hero_image, images, amenities, check_in_time, check_out_time,
        contact_address, contact_phone, contact_email, contact_whatsapp,
        social_facebook, social_instagram,
        branding_primary_color
    ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9::jsonb, $10::jsonb, $11, $12,
        $13, $14, $15, $16,
        $17, $18,
        $19
    ) ON CONFLICT (slug) DO NOTHING
"""


async def main():
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        print("ERROR: DATABASE_URL env var is required")
        sys.exit(1)

    conn = await asyncpg.connect(database_url)

    try:
        for hotel in HOTELS:
            await conn.execute(
                INSERT_SQL,
                hotel["name"],
                hotel["slug"],
                hotel["description"],
                hotel["location"],
                hotel["country"],
                hotel["star_rating"],
                hotel["currency"],
                hotel["hero_image"],
                json.dumps(hotel["images"]),
                json.dumps(hotel["amenities"]),
                hotel["check_in_time"],
                hotel["check_out_time"],
                hotel["contact_address"],
                hotel["contact_phone"],
                hotel["contact_email"],
                hotel.get("contact_whatsapp"),
                hotel.get("social_facebook"),
                hotel.get("social_instagram"),
                hotel["branding_primary_color"],
            )
            print(f"  Seeded: {hotel['name']} ({hotel['slug']})")

        count = await conn.fetchval("SELECT COUNT(*) FROM booking_hotels")
        print(f"\nDone. {count} hotel(s) in database.")
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
