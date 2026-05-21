#!/usr/bin/env python3
"""
Seed the local PMS database with mock data for development.
Creates a hotel user, hotel, room types (with monthly rate overrides),
and sample bookings.

Usage:
    python scripts/seed_mock_data.py
"""

import asyncio
import json
import os
import sys
import uuid
from datetime import date
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))

# Ensure env vars are set for local dev
os.environ.setdefault(
    "DATABASE_URL", "postgresql://vayada_pms_user:vayada_pms_password@localhost:5436/vayada_pms_db"
)
os.environ.setdefault(
    "AUTH_DATABASE_URL",
    "postgresql://vayada_auth_user:vayada_auth_password@localhost:5435/vayada_auth_db",
)
os.environ.setdefault(
    "CORS_ORIGINS", "http://localhost:3002,http://localhost:3003,http://localhost:3004"
)
os.environ.setdefault("JWT_SECRET_KEY", "test-secret-key-for-testing-only")
os.environ.setdefault("STRIPE_SECRET_KEY", "sk_test_fake")
os.environ.setdefault("STRIPE_WEBHOOK_SECRET", "whsec_test_fake")
os.environ.setdefault("XENDIT_SECRET_KEY", "xnd_test_fake")
os.environ.setdefault("XENDIT_WEBHOOK_SECRET", "xendit_webhook_test_secret")
os.environ.setdefault("S3_BUCKET_NAME", "test-bucket")
os.environ.setdefault("AWS_REGION", "us-east-1")
os.environ.setdefault("AWS_ACCESS_KEY_ID", "test-access-key")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "test-secret-key")

import asyncpg
import bcrypt
from app.config import settings

HOTEL_SLUG = "demo-mountain-lodge"
HOTEL_USER_EMAIL = "hotel@demo.com"


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


async def seed():
    # Connect to both databases
    pms = await asyncpg.connect(settings.DATABASE_URL)
    auth = await asyncpg.connect(settings.AUTH_DATABASE_URL)

    print("Connected to databases")
    print()

    # ── 1. Create hotel user in auth DB ─────────────────────────
    existing_user = await auth.fetchrow("SELECT id FROM users WHERE email = $1", HOTEL_USER_EMAIL)
    if existing_user:
        user_id = str(existing_user["id"])
        print(f"User already exists: {HOTEL_USER_EMAIL} ({user_id})")
    else:
        user = await auth.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status, email_verified)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id
            """,
            HOTEL_USER_EMAIL,
            hash_password("Demo1234!"),
            "Demo Hotel Owner",
            "hotel",
            "verified",
            True,
        )
        user_id = str(user["id"])
        print(f"Created user: {HOTEL_USER_EMAIL} / Demo1234!  ({user_id})")

    # ── 2. Create hotel ─────────────────────────────────────────
    existing_hotel = await pms.fetchrow("SELECT id FROM hotels WHERE slug = $1", HOTEL_SLUG)
    if existing_hotel:
        hotel_id = str(existing_hotel["id"])
        print(f"Hotel already exists: {HOTEL_SLUG} ({hotel_id})")
    else:
        hotel = await pms.fetchrow(
            """
            INSERT INTO hotels (slug, name, contact_email, user_id)
            VALUES ($1, $2, $3, $4)
            RETURNING id
            """,
            HOTEL_SLUG,
            "Demo Mountain Lodge",
            "contact@demo-lodge.com",
            user_id,
        )
        hotel_id = str(hotel["id"])
        print(f"Created hotel: Demo Mountain Lodge ({hotel_id})")

    # ── 3. Delete old room types for this hotel (fresh seed) ────
    await pms.execute("DELETE FROM bookings WHERE hotel_id = $1", hotel_id)
    await pms.execute("DELETE FROM room_blocks WHERE hotel_id = $1", hotel_id)
    await pms.execute("DELETE FROM room_types WHERE hotel_id = $1", hotel_id)
    print("Cleared existing room types and bookings")
    print()

    # ── 4. Create room types with monthly rates ─────────────────

    room_types = [
        {
            "name": "Standard Double",
            "description": "Comfortable room with a double bed, perfect for solo travellers or couples. Features a private bathroom, flat-screen TV, and free WiFi.",
            "short_description": "Cozy double room with mountain views",
            "max_occupancy": 2,
            "size": 22,
            "base_rate": 95.00,
            "non_refundable_rate": 80.00,
            "bed_type": "Double",
            "amenities": ["WiFi", "TV", "Air Conditioning", "Private Bathroom", "Hairdryer"],
            "features": ["Mountain View", "Blackout Curtains"],
            "total_rooms": 8,
            "sort_order": 1,
            "monthly_rates": {
                "1": {"base_rate": 75.00, "non_refundable_rate": 63.00},
                "2": {"base_rate": 75.00, "non_refundable_rate": 63.00},
                "3": {"base_rate": 85.00, "non_refundable_rate": 72.00},
                "6": {"base_rate": 120.00, "non_refundable_rate": 100.00},
                "7": {"base_rate": 140.00, "non_refundable_rate": 118.00},
                "8": {"base_rate": 140.00, "non_refundable_rate": 118.00},
                "12": {"base_rate": 130.00, "non_refundable_rate": 110.00},
            },
        },
        {
            "name": "Superior Twin",
            "description": "Spacious room with two single beds, ideal for friends or colleagues. Enjoy the private balcony with panoramic mountain views.",
            "short_description": "Twin room with private balcony",
            "max_occupancy": 2,
            "size": 28,
            "base_rate": 120.00,
            "non_refundable_rate": 100.00,
            "bed_type": "Twin",
            "amenities": [
                "WiFi",
                "TV",
                "Air Conditioning",
                "Private Bathroom",
                "Minibar",
                "Safe",
                "Balcony",
            ],
            "features": ["Mountain View", "Balcony", "Blackout Curtains"],
            "total_rooms": 6,
            "sort_order": 2,
            "monthly_rates": {
                "1": {"base_rate": 95.00, "non_refundable_rate": 80.00},
                "2": {"base_rate": 95.00, "non_refundable_rate": 80.00},
                "6": {"base_rate": 155.00, "non_refundable_rate": 130.00},
                "7": {"base_rate": 175.00, "non_refundable_rate": 148.00},
                "8": {"base_rate": 175.00, "non_refundable_rate": 148.00},
                "12": {"base_rate": 160.00, "non_refundable_rate": 135.00},
            },
        },
        {
            "name": "Deluxe King Suite",
            "description": "Luxurious suite with a king-size bed, separate living area, and a large terrace overlooking the valley. Includes espresso machine and premium toiletries.",
            "short_description": "Luxury suite with valley terrace",
            "max_occupancy": 3,
            "size": 45,
            "base_rate": 195.00,
            "non_refundable_rate": 165.00,
            "bed_type": "King",
            "amenities": [
                "WiFi",
                "TV",
                "Air Conditioning",
                "Private Bathroom",
                "Minibar",
                "Safe",
                "Espresso Machine",
                "Bathrobe",
                "Slippers",
                "Terrace",
            ],
            "features": ["Valley View", "Terrace", "Living Area", "Premium Toiletries"],
            "total_rooms": 4,
            "sort_order": 3,
            "monthly_rates": {
                "1": {"base_rate": 155.00, "non_refundable_rate": 130.00},
                "2": {"base_rate": 155.00, "non_refundable_rate": 130.00},
                "6": {"base_rate": 250.00, "non_refundable_rate": 210.00},
                "7": {"base_rate": 295.00, "non_refundable_rate": 250.00},
                "8": {"base_rate": 295.00, "non_refundable_rate": 250.00},
                "9": {"base_rate": 220.00},
                "12": {"base_rate": 275.00, "non_refundable_rate": 232.00},
            },
        },
        {
            "name": "Family Room",
            "description": "Perfect for families with a king bed and a bunk bed for children. Features a mini-kitchen and a large bathroom with bathtub.",
            "short_description": "Family-friendly room with bunk beds",
            "max_occupancy": 4,
            "size": 38,
            "base_rate": 160.00,
            "non_refundable_rate": 135.00,
            "bed_type": "King + Bunk",
            "amenities": [
                "WiFi",
                "TV",
                "Air Conditioning",
                "Private Bathroom",
                "Mini Kitchen",
                "Bathtub",
                "Safe",
                "Crib Available",
            ],
            "features": ["Garden View", "Mini Kitchen", "Bathtub"],
            "total_rooms": 3,
            "sort_order": 4,
            "monthly_rates": {
                "1": {"base_rate": 125.00, "non_refundable_rate": 105.00},
                "2": {"base_rate": 125.00, "non_refundable_rate": 105.00},
                "6": {"base_rate": 210.00, "non_refundable_rate": 178.00},
                "7": {"base_rate": 240.00, "non_refundable_rate": 203.00},
                "8": {"base_rate": 240.00, "non_refundable_rate": 203.00},
                "12": {"base_rate": 220.00, "non_refundable_rate": 186.00},
            },
        },
        {
            "name": "Economy Single",
            "description": "Compact and affordable room with a single bed. Ideal for budget-conscious solo travellers.",
            "short_description": "Budget-friendly single room",
            "max_occupancy": 1,
            "size": 14,
            "base_rate": 55.00,
            "non_refundable_rate": None,
            "bed_type": "Single",
            "amenities": ["WiFi", "TV", "Private Bathroom"],
            "features": ["Courtyard View"],
            "total_rooms": 5,
            "sort_order": 5,
            "monthly_rates": {},  # No seasonal overrides — flat rate all year
        },
    ]

    created_rooms = []
    for rt in room_types:
        row = await pms.fetchrow(
            """
            INSERT INTO room_types (
                hotel_id, name, description, short_description,
                max_occupancy, size, base_rate, non_refundable_rate, currency,
                amenities, images, bed_type, features,
                total_rooms, is_active, sort_order, monthly_rates
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9,
                $10::jsonb, $11::jsonb, $12, $13::jsonb,
                $14, $15, $16, $17::jsonb
            ) RETURNING id, name, base_rate, monthly_rates
            """,
            hotel_id,
            rt["name"],
            rt["description"],
            rt["short_description"],
            rt["max_occupancy"],
            rt["size"],
            rt["base_rate"],
            rt["non_refundable_rate"],
            "EUR",
            json.dumps(rt["amenities"]),
            json.dumps([]),
            rt["bed_type"],
            json.dumps(rt["features"]),
            rt["total_rooms"],
            True,
            rt["sort_order"],
            json.dumps(rt["monthly_rates"]),
        )
        created_rooms.append(dict(row))
        override_count = len(rt["monthly_rates"])
        print(
            f"  Created room type: {rt['name']}  (base: {rt['base_rate']} EUR, {override_count} monthly overrides)"
        )

    print()

    # ── 5. Create sample bookings ───────────────────────────────

    bookings = [
        # July booking (high season) on Standard Double
        {
            "room_idx": 0,
            "guest_first": "Anna",
            "guest_last": "Schmidt",
            "guest_email": "anna.schmidt@example.com",
            "check_in": "2026-07-10",
            "check_out": "2026-07-15",
            "adults": 2,
            "children": 0,
            "status": "confirmed",
        },
        # January booking (low season) on Deluxe King Suite
        {
            "room_idx": 2,
            "guest_first": "Marco",
            "guest_last": "Rossi",
            "guest_email": "marco.rossi@example.com",
            "check_in": "2026-01-20",
            "check_out": "2026-01-25",
            "adults": 2,
            "children": 0,
            "status": "confirmed",
        },
        # August booking (peak) on Family Room
        {
            "room_idx": 3,
            "guest_first": "Emily",
            "guest_last": "Johnson",
            "guest_email": "emily.j@example.com",
            "check_in": "2026-08-01",
            "check_out": "2026-08-08",
            "adults": 2,
            "children": 2,
            "status": "confirmed",
        },
        # March booking (shoulder season) on Superior Twin
        {
            "room_idx": 1,
            "guest_first": "Lukas",
            "guest_last": "Mueller",
            "guest_email": "lukas.m@example.com",
            "check_in": "2026-03-15",
            "check_out": "2026-03-18",
            "adults": 2,
            "children": 0,
            "status": "pending",
        },
        # October booking (default rate) on Economy Single
        {
            "room_idx": 4,
            "guest_first": "Sofia",
            "guest_last": "Bianchi",
            "guest_email": "sofia.b@example.com",
            "check_in": "2026-10-05",
            "check_out": "2026-10-10",
            "adults": 1,
            "children": 0,
            "status": "confirmed",
        },
    ]

    for b in bookings:
        room = created_rooms[b["room_idx"]]
        room_id = str(room["id"])

        ci = date.fromisoformat(b["check_in"])
        co = date.fromisoformat(b["check_out"])
        nights = (co - ci).days

        # Resolve monthly rate for check-in month
        monthly_rates = room["monthly_rates"] or {}
        if isinstance(monthly_rates, str):
            monthly_rates = json.loads(monthly_rates)
        override = monthly_rates.get(str(ci.month))

        if override and override.get("base_rate") is not None:
            nightly_rate = float(override["base_rate"])
        else:
            nightly_rate = float(room["base_rate"])

        total = round(nightly_rate * nights, 2)
        ref = f"VAY-{uuid.uuid4().hex[:6].upper()}"

        await pms.fetchrow(
            """
            INSERT INTO bookings (
                hotel_id, room_type_id, booking_reference,
                guest_first_name, guest_last_name, guest_email, guest_phone,
                special_requests, check_in, check_out,
                adults, children, nightly_rate, total_amount, currency, status
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                $11, $12, $13, $14, $15, $16
            ) RETURNING id
            """,
            hotel_id,
            room_id,
            ref,
            b["guest_first"],
            b["guest_last"],
            b["guest_email"],
            "+49123456789",
            "",
            ci,
            co,
            b["adults"],
            b["children"],
            nightly_rate,
            total,
            "EUR",
            b["status"],
        )
        month_name = ci.strftime("%B")
        print(
            f"  Booking: {b['guest_first']} {b['guest_last']} - {room['name']} "
            f"({b['check_in']} to {b['check_out']}, {month_name}) "
            f"@ {nightly_rate} EUR/night = {total} EUR  [{b['status']}]"
        )

    print()

    # ── 6. Create payment settings ──────────────────────────────
    await pms.execute(
        """
        INSERT INTO hotel_payment_settings (hotel_id, platform_fee_type, platform_fee_value, platform_fee_with_affiliate, pay_at_property_enabled)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (hotel_id) DO NOTHING
        """,
        hotel_id,
        "percentage",
        8.0,
        2.0,
        True,
    )

    await pms.execute(
        """
        INSERT INTO cancellation_policies (hotel_id, free_cancellation_days, partial_refund_pct)
        VALUES ($1, $2, $3)
        ON CONFLICT (hotel_id) DO NOTHING
        """,
        hotel_id,
        7,
        50.0,
    )
    print("Created payment settings and cancellation policy")

    await pms.close()
    await auth.close()

    print()
    print("=" * 60)
    print("Seed complete!")
    print()
    print("  PMS Admin:  http://localhost:3004")
    print(f"  Login:      {HOTEL_USER_EMAIL} / Demo1234!")
    print(f"  Hotel slug: {HOTEL_SLUG}")
    print()
    print("  Room types with monthly pricing overrides:")
    for rt in room_types:
        n = len(rt["monthly_rates"])
        print(
            f"    - {rt['name']}:  base {rt['base_rate']} EUR, {n} monthly override{'s' if n != 1 else ''}"
        )
    print()
    print("  To see monthly pricing: Rooms > click any room > expand 'Monthly Pricing'")
    print("=" * 60)


if __name__ == "__main__":
    asyncio.run(seed())
