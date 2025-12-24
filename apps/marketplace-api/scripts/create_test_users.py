#!/usr/bin/env python3
"""
Create test users for admin interface testing
Creates users with different types, statuses, profiles, platforms, and listings
"""
import asyncio
import asyncpg
import bcrypt
import sys
import json
from pathlib import Path
from decimal import Decimal

# Add parent directory to path to import app modules
sys.path.insert(0, str(Path(__file__).parent.parent))

from app.config import settings


async def create_test_users():
    """Create test users with various configurations"""
    try:
        print("🔗 Connecting to database...")
        conn = await asyncpg.connect(settings.DATABASE_URL)
        print("✅ Connected to database\n")
        
        # Hash password for all test users
        password_hash = bcrypt.hashpw("Test1234".encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
        
        # Test Users Data
        test_users = [
            # Creator Users
            {
                "email": "creator1@test.com",
                "name": "Sarah Johnson",
                "type": "creator",
                "status": "verified",
                "email_verified": True,
                "avatar": "https://i.pravatar.cc/150?img=1",
                "profile": {
                    "location": "New York, USA",
                    "short_description": "Travel and lifestyle content creator with 5+ years of experience",
                    "portfolio_link": "https://sarahjohnson.com",
                    "phone": "+1-555-0101",
                    "profile_picture": "https://i.pravatar.cc/300?img=1",
                    "profile_complete": True,
                },
                "platforms": [
                    {
                        "name": "Instagram",
                        "handle": "@sarahj_travels",
                        "followers": 125000,
                        "engagement_rate": Decimal("4.2"),
                        "top_countries": {"USA": 45, "UK": 20, "Canada": 15, "Australia": 10, "Germany": 10},
                        "top_age_groups": {"18-24": 30, "25-34": 40, "35-44": 20, "45+": 10},
                        "gender_split": {"female": 65, "male": 30, "other": 5},
                    },
                    {
                        "name": "TikTok",
                        "handle": "@sarahjtravels",
                        "followers": 85000,
                        "engagement_rate": Decimal("6.5"),
                        "top_countries": {"USA": 50, "UK": 15, "Canada": 12, "Australia": 8, "France": 15},
                        "top_age_groups": {"18-24": 50, "25-34": 35, "35-44": 10, "45+": 5},
                        "gender_split": {"female": 70, "male": 25, "other": 5},
                    },
                ]
            },
            {
                "email": "creator2@test.com",
                "name": "Mike Chen",
                "type": "creator",
                "status": "pending",
                "email_verified": False,
                "avatar": "https://i.pravatar.cc/150?img=12",
                "profile": {
                    "location": "Los Angeles, USA",
                    "short_description": "Food and restaurant reviewer",
                    "portfolio_link": "https://mikechenfood.com",
                    "phone": "+1-555-0102",
                    "profile_picture": None,
                    "profile_complete": False,
                },
                "platforms": [
                    {
                        "name": "YouTube",
                        "handle": "@mikechenfood",
                        "followers": 250000,
                        "engagement_rate": Decimal("3.8"),
                    },
                ]
            },
            {
                "email": "creator3@test.com",
                "name": "Emma Wilson",
                "type": "creator",
                "status": "verified",
                "email_verified": True,
                "avatar": None,
                "profile": {
                    "location": "London, UK",
                    "short_description": "Fashion and beauty influencer",
                    "portfolio_link": "https://emmawilson.style",
                    "phone": "+44-20-7946-0958",
                    "profile_picture": "https://i.pravatar.cc/300?img=5",
                    "profile_complete": True,
                },
                "platforms": [
                    {
                        "name": "Instagram",
                        "handle": "@emmawilson_style",
                        "followers": 350000,
                        "engagement_rate": Decimal("5.1"),
                    },
                    {
                        "name": "Facebook",
                        "handle": "EmmaWilsonStyle",
                        "followers": 180000,
                        "engagement_rate": Decimal("2.5"),
                    },
                ]
            },
            
            # Hotel Users
            {
                "email": "hotel1@test.com",
                "name": "Grand Paradise Resort",
                "type": "hotel",
                "status": "verified",
                "email_verified": True,
                "avatar": "https://i.pravatar.cc/150?img=47",
                "profile": {
                    "name": "Grand Paradise Resort",
                    "location": "Maldives",
                    "about": "Luxury beachfront resort with world-class amenities and stunning ocean views",
                    "website": "https://grandparadise.com",
                    "phone": "+960-123-4567",
                    "picture": "https://images.unsplash.com/photo-1571896349842-33c89424de2d?w=800",
                    "profile_complete": True,
                },
                "listings": [
                    {
                        "name": "Ocean View Villa",
                        "location": "Maldives - Beachfront",
                        "description": "Spacious villa with private beach access, infinity pool, and panoramic ocean views",
                        "accommodation_type": "Villa",
                        "images": [
                            "https://images.unsplash.com/photo-1571896349842-33c89424de2d?w=800",
                            "https://images.unsplash.com/photo-1566073771259-6a8506099945?w=800",
                        ],
                        "status": "verified",
                    },
                    {
                        "name": "Luxury Suite",
                        "location": "Maldives - Resort Center",
                        "description": "Elegant suite with modern amenities and resort access",
                        "accommodation_type": "Hotel",
                        "images": [
                            "https://images.unsplash.com/photo-1590490360182-c33d57733427?w=800",
                        ],
                        "status": "pending",
                    },
                ]
            },
            {
                "email": "hotel2@test.com",
                "name": "Mountain View Lodge",
                "type": "hotel",
                "status": "verified",
                "email_verified": True,
                "avatar": None,
                "profile": {
                    "name": "Mountain View Lodge",
                    "location": "Switzerland, Alps",
                    "about": "Cozy mountain lodge perfect for skiing and hiking enthusiasts",
                    "website": "https://mountainviewlodge.ch",
                    "phone": "+41-21-123-4567",
                    "picture": "https://images.unsplash.com/photo-1520250497591-112f2f40a3f4?w=800",
                    "profile_complete": True,
                },
                "listings": [
                    {
                        "name": "Alpine Chalet",
                        "location": "Switzerland - Alps",
                        "description": "Traditional Swiss chalet with fireplace and mountain views",
                        "accommodation_type": "Lodge",
                        "images": [
                            "https://images.unsplash.com/photo-1520250497591-112f2f40a3f4?w=800",
                            "https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=800",
                        ],
                        "status": "verified",
                    },
                ]
            },
            {
                "email": "hotel3@test.com",
                "name": "City Center Hotel",
                "type": "hotel",
                "status": "pending",
                "email_verified": False,
                "avatar": "https://i.pravatar.cc/150?img=33",
                "profile": {
                    "name": "City Center Hotel",
                    "location": "Paris, France",
                    "about": None,
                    "website": None,
                    "phone": "+33-1-23-45-67-89",
                    "picture": None,
                    "profile_complete": False,
                },
                "listings": []
            },
            
            # Admin User (if doesn't exist)
            {
                "email": "admin@test.com",
                "name": "Test Admin",
                "type": "admin",
                "status": "verified",
                "email_verified": True,
                "avatar": None,
                "profile": None,
                "platforms": [],
                "listings": [],
            },
        ]
        
        created_count = 0
        skipped_count = 0
        
        for user_data in test_users:
            email = user_data["email"]
            
            # Check if user already exists
            existing = await conn.fetchrow(
                "SELECT id, type FROM users WHERE email = $1",
                email
            )
            
            if existing:
                print(f"⏭️  Skipping {email} (already exists)")
                skipped_count += 1
                continue
            
            print(f"👤 Creating user: {email} ({user_data['type']})")
            
            # Create user
            user = await conn.fetchrow(
                """
                INSERT INTO users (email, password_hash, name, type, status, email_verified, avatar)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                RETURNING id
                """,
                email,
                password_hash,
                user_data["name"],
                user_data["type"],
                user_data["status"],
                user_data["email_verified"],
                user_data.get("avatar")
            )
            
            user_id = user['id']
            created_count += 1
            
            # Create profile based on type
            if user_data["type"] == "creator" and user_data.get("profile"):
                profile_data = user_data["profile"]
                creator = await conn.fetchrow(
                    """
                    INSERT INTO creators (user_id, location, short_description, portfolio_link, phone, 
                                        profile_picture, profile_complete, profile_completed_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, 
                            CASE WHEN $7 = true THEN now() ELSE NULL END)
                    RETURNING id
                    """,
                    user_id,
                    profile_data.get("location"),
                    profile_data.get("short_description"),
                    profile_data.get("portfolio_link"),
                    profile_data.get("phone"),
                    profile_data.get("profile_picture"),
                    profile_data.get("profile_complete", False),
                )
                
                creator_id = creator['id']
                
                # Create platforms
                for platform_data in user_data.get("platforms", []):
                    await conn.execute(
                        """
                        INSERT INTO creator_platforms 
                            (creator_id, name, handle, followers, engagement_rate, 
                             top_countries, top_age_groups, gender_split)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                        """,
                        creator_id,
                        platform_data["name"],
                        platform_data["handle"],
                        platform_data["followers"],
                        platform_data["engagement_rate"],
                        json.dumps(platform_data.get("top_countries")) if platform_data.get("top_countries") else None,
                        json.dumps(platform_data.get("top_age_groups")) if platform_data.get("top_age_groups") else None,
                        json.dumps(platform_data.get("gender_split")) if platform_data.get("gender_split") else None,
                    )
                print(f"   ✅ Created creator profile with {len(user_data.get('platforms', []))} platforms")
            
            elif user_data["type"] == "hotel" and user_data.get("profile"):
                profile_data = user_data["profile"]
                hotel = await conn.fetchrow(
                    """
                    INSERT INTO hotel_profiles (user_id, name, location, about, website, phone, 
                                               picture, profile_complete, profile_completed_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                            CASE WHEN $8 = true THEN now() ELSE NULL END)
                    RETURNING id
                    """,
                    user_id,
                    profile_data.get("name"),
                    profile_data.get("location"),
                    profile_data.get("about"),
                    profile_data.get("website"),
                    profile_data.get("phone"),
                    profile_data.get("picture"),
                    profile_data.get("profile_complete", False),
                )
                
                hotel_id = hotel['id']
                
                # Create listings
                for listing_data in user_data.get("listings", []):
                    await conn.execute(
                        """
                        INSERT INTO hotel_listings 
                            (hotel_profile_id, name, location, description, accommodation_type, images, status)
                        VALUES ($1, $2, $3, $4, $5, $6, $7)
                        """,
                        hotel_id,
                        listing_data["name"],
                        listing_data["location"],
                        listing_data["description"],
                        listing_data.get("accommodation_type"),
                        listing_data.get("images", []),
                        listing_data.get("status", "pending"),
                    )
                print(f"   ✅ Created hotel profile with {len(user_data.get('listings', []))} listings")
            
            elif user_data["type"] == "creator":
                # Create empty creator profile
                await conn.execute(
                    "INSERT INTO creators (user_id) VALUES ($1)",
                    user_id
                )
                print(f"   ✅ Created empty creator profile")
            
            elif user_data["type"] == "hotel":
                # Create empty hotel profile
                await conn.execute(
                    "INSERT INTO hotel_profiles (user_id, name, location) VALUES ($1, $2, 'Not specified')",
                    user_id,
                    user_data["name"]
                )
                print(f"   ✅ Created empty hotel profile")
            
            print()
        
        await conn.close()
        
        print("=" * 60)
        print(f"✨ Test users creation complete!")
        print(f"   Created: {created_count} users")
        print(f"   Skipped: {skipped_count} users (already exist)")
        print()
        print("📋 Test Users Created:")
        print("   Creators:")
        print("     - creator1@test.com (verified, with profile & 2 platforms)")
        print("     - creator2@test.com (pending, incomplete profile)")
        print("     - creator3@test.com (verified, with profile & 2 platforms)")
        print("   Hotels:")
        print("     - hotel1@test.com (verified, with profile & 2 listings)")
        print("     - hotel2@test.com (verified, with profile & 1 listing)")
        print("     - hotel3@test.com (pending, incomplete profile)")
        print("   Admin:")
        print("     - admin@test.com (verified admin)")
        print()
        print("🔑 All test users have password: Test1234")
        print("=" * 60)
        
    except Exception as e:
        print(f"❌ Error creating test users: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    print("🚀 Creating test users for admin interface...")
    print()
    asyncio.run(create_test_users())

