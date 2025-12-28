#!/usr/bin/env python3
"""
Add mock users to the database
Creates creators with social media platforms and hotels with listings
"""
import asyncio
import asyncpg
import bcrypt
import sys
import json
from pathlib import Path
from decimal import Decimal
from datetime import datetime

# Add parent directory to path to import app modules
sys.path.insert(0, str(Path(__file__).parent.parent))

from app.config import settings


async def add_mock_users():
    """Add mock users with platforms and listings"""
    try:
        print("🔗 Connecting to database...")
        conn = await asyncpg.connect(settings.DATABASE_URL)
        print("✅ Connected to database\n")
        
        # Hash password for all test users
        password_hash = bcrypt.hashpw("Test1234".encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
        
        # Mock Users Data
        mock_users = [
            # Creators with Social Media Platforms
            {
                "email": "creator1@mock.com",
                "name": "Alexandra Travels",
                "type": "creator",
                "status": "verified",
                "email_verified": True,
                "avatar": "https://i.pravatar.cc/150?img=1",
                "profile": {
                    "location": "New York, USA",
                    "short_description": "Travel content creator sharing amazing destinations around the world",
                    "portfolio_link": "https://alexandratravels.com",
                    "phone": "+1-555-1001",
                    "profile_picture": "https://i.pravatar.cc/300?img=1",
                    "profile_complete": True,
                },
                "platforms": [
                    {
                        "name": "Instagram",
                        "handle": "@alexandratravels",
                        "followers": 150000,
                        "engagement_rate": Decimal("4.5"),
                        "top_countries": {"USA": 40, "UK": 25, "Canada": 15, "Australia": 10, "Germany": 10},
                        "top_age_groups": {"25-34": 45, "35-44": 30, "18-24": 15, "45+": 10},
                        "gender_split": {"female": 60, "male": 35, "other": 5},
                    },
                    {
                        "name": "TikTok",
                        "handle": "@alexandratravels",
                        "followers": 95000,
                        "engagement_rate": Decimal("6.2"),
                        "top_countries": {"USA": 45, "UK": 20, "Canada": 15, "Australia": 10, "France": 10},
                        "top_age_groups": {"18-24": 50, "25-34": 35, "35-44": 10, "45+": 5},
                        "gender_split": {"female": 65, "male": 30, "other": 5},
                    },
                    {
                        "name": "YouTube",
                        "handle": "@alexandratravels",
                        "followers": 75000,
                        "engagement_rate": Decimal("3.8"),
                        "top_countries": {"USA": 50, "UK": 20, "Canada": 15, "Australia": 10, "Germany": 5},
                        "top_age_groups": {"25-34": 50, "35-44": 30, "18-24": 15, "45+": 5},
                        "gender_split": {"female": 55, "male": 40, "other": 5},
                    },
                ]
            },
            {
                "email": "creator2@mock.com",
                "name": "Marcus Foodie",
                "type": "creator",
                "status": "verified",
                "email_verified": True,
                "avatar": "https://i.pravatar.cc/150?img=12",
                "profile": {
                    "location": "Los Angeles, USA",
                    "short_description": "Food blogger and restaurant reviewer exploring culinary delights",
                    "portfolio_link": "https://marcusfoodie.com",
                    "phone": "+1-555-1002",
                    "profile_picture": "https://i.pravatar.cc/300?img=12",
                    "profile_complete": True,
                },
                "platforms": [
                    {
                        "name": "Instagram",
                        "handle": "@marcusfoodie",
                        "followers": 200000,
                        "engagement_rate": Decimal("5.2"),
                        "top_countries": {"USA": 60, "Canada": 15, "UK": 10, "Australia": 10, "Mexico": 5},
                        "top_age_groups": {"25-34": 50, "35-44": 30, "18-24": 15, "45+": 5},
                        "gender_split": {"male": 55, "female": 40, "other": 5},
                    },
                    {
                        "name": "YouTube",
                        "handle": "@marcusfoodie",
                        "followers": 180000,
                        "engagement_rate": Decimal("4.0"),
                        "top_countries": {"USA": 55, "Canada": 20, "UK": 15, "Australia": 10},
                        "top_age_groups": {"25-34": 45, "35-44": 35, "18-24": 15, "45+": 5},
                        "gender_split": {"male": 60, "female": 35, "other": 5},
                    },
                ]
            },
            {
                "email": "creator3@mock.com",
                "name": "Emma Style",
                "type": "creator",
                "status": "pending",
                "email_verified": False,
                "avatar": "https://i.pravatar.cc/150?img=5",
                "profile": {
                    "location": "London, UK",
                    "short_description": "Fashion and beauty influencer sharing style tips and trends",
                    "portfolio_link": "https://emmastyle.com",
                    "phone": "+44-20-7946-1003",
                    "profile_picture": "https://i.pravatar.cc/300?img=5",
                    "profile_complete": True,
                },
                "platforms": [
                    {
                        "name": "Instagram",
                        "handle": "@emmastyle",
                        "followers": 300000,
                        "engagement_rate": Decimal("5.8"),
                        "top_countries": {"UK": 40, "USA": 25, "France": 15, "Germany": 10, "Italy": 10},
                        "top_age_groups": {"18-24": 40, "25-34": 40, "35-44": 15, "45+": 5},
                        "gender_split": {"female": 75, "male": 20, "other": 5},
                    },
                    {
                        "name": "Facebook",
                        "handle": "EmmaStyleOfficial",
                        "followers": 120000,
                        "engagement_rate": Decimal("2.8"),
                        "top_countries": {"UK": 45, "USA": 20, "Canada": 15, "Australia": 10, "Germany": 10},
                        "top_age_groups": {"25-34": 40, "35-44": 35, "45+": 15, "18-24": 10},
                        "gender_split": {"female": 70, "male": 25, "other": 5},
                    },
                ]
            },
            {
                "email": "creator4@mock.com",
                "name": "David Adventure",
                "type": "creator",
                "status": "verified",
                "email_verified": True,
                "avatar": "https://i.pravatar.cc/150?img=15",
                "profile": {
                    "location": "Barcelona, Spain",
                    "short_description": "Adventure travel and outdoor activities enthusiast",
                    "portfolio_link": "https://davidadventure.com",
                    "phone": "+34-93-123-4567",
                    "profile_picture": "https://i.pravatar.cc/300?img=15",
                    "profile_complete": True,
                },
                "platforms": [
                    {
                        "name": "YouTube",
                        "handle": "@davidadventure",
                        "followers": 220000,
                        "engagement_rate": Decimal("4.8"),
                        "top_countries": {"Spain": 35, "USA": 25, "UK": 15, "Germany": 12, "France": 13},
                        "top_age_groups": {"25-34": 50, "35-44": 30, "18-24": 15, "45+": 5},
                        "gender_split": {"male": 60, "female": 35, "other": 5},
                    },
                    {
                        "name": "Instagram",
                        "handle": "@davidadventure",
                        "followers": 180000,
                        "engagement_rate": Decimal("5.5"),
                        "top_countries": {"Spain": 40, "USA": 20, "UK": 15, "Germany": 10, "France": 15},
                        "top_age_groups": {"25-34": 45, "18-24": 30, "35-44": 20, "45+": 5},
                        "gender_split": {"male": 55, "female": 40, "other": 5},
                    },
                ]
            },
            
            # Hotels with Listings
            {
                "email": "hotel1@mock.com",
                "name": "Grand Paradise Resort",
                "type": "hotel",
                "status": "verified",
                "email_verified": True,
                "avatar": "https://i.pravatar.cc/150?img=47",
                "profile": {
                    "name": "Grand Paradise Resort",
                    "location": "Maldives",
                    "about": "Luxury beachfront resort with world-class amenities, stunning ocean views, and exceptional service",
                    "website": "https://grandparadise.com",
                    "phone": "+960-123-4567",
                    "picture": "https://images.unsplash.com/photo-1571896349842-33c89424de2d?w=800",
                    "profile_complete": True,
                },
                "listings": [
                    {
                        "name": "Ocean View Villa",
                        "location": "Maldives - Beachfront",
                        "description": "Spacious villa with private beach access, infinity pool, and panoramic ocean views. Perfect for couples and families.",
                        "accommodation_type": "Villa",
                        "images": [
                            "https://images.unsplash.com/photo-1571896349842-33c89424de2d?w=800",
                            "https://images.unsplash.com/photo-1566073771259-6a8506099945?w=800",
                            "https://images.unsplash.com/photo-1590490360182-c33d57733427?w=800",
                        ],
                        "status": "verified",
                        "collaboration_offerings": [
                            {
                                "collaboration_type": "Free Stay",
                                "availability_months": ["January", "February", "March", "April", "May", "September", "October", "November"],
                                "platforms": ["Instagram", "TikTok", "YouTube"],
                                "free_stay_min_nights": 3,
                                "free_stay_max_nights": 7,
                            },
                            {
                                "collaboration_type": "Paid",
                                "availability_months": ["June", "July", "August", "December"],
                                "platforms": ["Instagram", "YouTube"],
                                "paid_max_amount": Decimal("5000.00"),
                            },
                        ],
                        "creator_requirements": {
                            "platforms": ["Instagram", "TikTok", "YouTube"],
                            "min_followers": 100000,
                            "target_countries": ["USA", "UK", "Canada", "Australia", "Germany"],
                            "target_age_min": 25,
                            "target_age_max": 45,
                        },
                    },
                    {
                        "name": "Luxury Suite",
                        "location": "Maldives - Resort Center",
                        "description": "Elegant suite with modern amenities, resort access, and stunning views",
                        "accommodation_type": "Hotel",
                        "images": [
                            "https://images.unsplash.com/photo-1590490360182-c33d57733427?w=800",
                            "https://images.unsplash.com/photo-1520250497591-112f2f40a3f4?w=800",
                        ],
                        "status": "verified",
                        "collaboration_offerings": [
                            {
                                "collaboration_type": "Discount",
                                "availability_months": ["January", "February", "March", "November", "December"],
                                "platforms": ["Instagram", "Facebook"],
                                "discount_percentage": 30,
                            },
                        ],
                        "creator_requirements": {
                            "platforms": ["Instagram", "Facebook"],
                            "min_followers": 50000,
                            "target_countries": ["USA", "UK", "France"],
                            "target_age_min": 30,
                            "target_age_max": 50,
                        },
                    },
                    {
                        "name": "Beachfront Villa",
                        "location": "Maldives - Private Beach",
                        "description": "Intimate villa steps away from pristine white sand beach",
                        "accommodation_type": "Villa",
                        "images": [
                            "https://images.unsplash.com/photo-1566073771259-6a8506099945?w=800",
                        ],
                        "status": "pending",
                        "collaboration_offerings": [
                            {
                                "collaboration_type": "Free Stay",
                                "availability_months": ["May", "June", "September", "October"],
                                "platforms": ["Instagram", "TikTok"],
                                "free_stay_min_nights": 2,
                                "free_stay_max_nights": 5,
                            },
                        ],
                        "creator_requirements": {
                            "platforms": ["Instagram", "TikTok"],
                            "min_followers": 75000,
                            "target_countries": ["USA", "UK", "Canada"],
                            "target_age_min": 25,
                            "target_age_max": 40,
                        },
                    },
                ]
            },
            {
                "email": "hotel2@mock.com",
                "name": "Mountain View Lodge",
                "type": "hotel",
                "status": "verified",
                "email_verified": True,
                "avatar": None,
                "profile": {
                    "name": "Mountain View Lodge",
                    "location": "Switzerland, Alps",
                    "about": "Cozy mountain lodge perfect for skiing and hiking enthusiasts. Traditional Swiss hospitality in a stunning alpine setting.",
                    "website": "https://mountainviewlodge.ch",
                    "phone": "+41-21-123-4567",
                    "picture": "https://images.unsplash.com/photo-1520250497591-112f2f40a3f4?w=800",
                    "profile_complete": True,
                },
                "listings": [
                    {
                        "name": "Alpine Chalet",
                        "location": "Switzerland - Alps",
                        "description": "Traditional Swiss chalet with fireplace, mountain views, and ski-in/ski-out access",
                        "accommodation_type": "Lodge",
                        "images": [
                            "https://images.unsplash.com/photo-1520250497591-112f2f40a3f4?w=800",
                            "https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=800",
                        ],
                        "status": "verified",
                        "collaboration_offerings": [
                            {
                                "collaboration_type": "Free Stay",
                                "availability_months": ["December", "January", "February", "March"],
                                "platforms": ["Instagram", "YouTube", "TikTok"],
                                "free_stay_min_nights": 4,
                                "free_stay_max_nights": 10,
                            },
                            {
                                "collaboration_type": "Paid",
                                "availability_months": ["April", "May", "June", "July", "August"],
                                "platforms": ["Instagram", "YouTube"],
                                "paid_max_amount": Decimal("3000.00"),
                            },
                        ],
                        "creator_requirements": {
                            "platforms": ["Instagram", "YouTube", "TikTok"],
                            "min_followers": 150000,
                            "target_countries": ["Switzerland", "Germany", "France", "Austria", "UK"],
                            "target_age_min": 28,
                            "target_age_max": 45,
                        },
                    },
                    {
                        "name": "Mountain Suite",
                        "location": "Switzerland - Lodge Main Building",
                        "description": "Comfortable suite with balcony overlooking the Alps",
                        "accommodation_type": "Hotel",
                        "images": [
                            "https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=800",
                        ],
                        "status": "verified",
                        "collaboration_offerings": [
                            {
                                "collaboration_type": "Discount",
                                "availability_months": ["September", "October", "November"],
                                "platforms": ["Instagram", "Facebook"],
                                "discount_percentage": 25,
                            },
                        ],
                        "creator_requirements": {
                            "platforms": ["Instagram", "Facebook"],
                            "min_followers": 80000,
                            "target_countries": ["Switzerland", "Germany", "France"],
                            "target_age_min": 30,
                            "target_age_max": 55,
                        },
                    },
                ]
            },
            {
                "email": "hotel3@mock.com",
                "name": "Beachside Boutique",
                "type": "hotel",
                "status": "verified",
                "email_verified": True,
                "avatar": "https://i.pravatar.cc/150?img=51",
                "profile": {
                    "name": "Beachside Boutique",
                    "location": "Bali, Indonesia",
                    "about": "Intimate boutique hotel with stunning beach views and personalized service. Perfect for a romantic getaway.",
                    "website": "https://beachsideboutique.bali",
                    "phone": "+62-361-123-456",
                    "picture": "https://images.unsplash.com/photo-1571896349842-33c89424de2d?w=800",
                    "profile_complete": True,
                },
                "listings": [
                    {
                        "name": "Oceanfront Suite",
                        "location": "Bali - Beachfront",
                        "description": "Luxurious suite with direct beach access, private balcony, and ocean views",
                        "accommodation_type": "Hotel",
                        "images": [
                            "https://images.unsplash.com/photo-1571896349842-33c89424de2d?w=800",
                            "https://images.unsplash.com/photo-1566073771259-6a8506099945?w=800",
                        ],
                        "status": "verified",
                        "collaboration_offerings": [
                            {
                                "collaboration_type": "Free Stay",
                                "availability_months": ["April", "May", "June", "September", "October"],
                                "platforms": ["Instagram", "TikTok", "YouTube"],
                                "free_stay_min_nights": 3,
                                "free_stay_max_nights": 7,
                            },
                            {
                                "collaboration_type": "Discount",
                                "availability_months": ["January", "February", "March", "November", "December"],
                                "platforms": ["Instagram", "Facebook"],
                                "discount_percentage": 35,
                            },
                        ],
                        "creator_requirements": {
                            "platforms": ["Instagram", "TikTok", "YouTube"],
                            "min_followers": 120000,
                            "target_countries": ["Australia", "USA", "UK", "Indonesia", "Singapore"],
                            "target_age_min": 25,
                            "target_age_max": 45,
                        },
                    },
                    {
                        "name": "Garden Villa",
                        "location": "Bali - Garden Area",
                        "description": "Spacious villa surrounded by tropical gardens with private pool",
                        "accommodation_type": "Villa",
                        "images": [
                            "https://images.unsplash.com/photo-1566073771259-6a8506099945?w=800",
                            "https://images.unsplash.com/photo-1590490360182-c33d57733427?w=800",
                        ],
                        "status": "verified",
                        "collaboration_offerings": [
                            {
                                "collaboration_type": "Paid",
                                "availability_months": ["July", "August"],
                                "platforms": ["Instagram", "YouTube"],
                                "paid_max_amount": Decimal("4000.00"),
                            },
                        ],
                        "creator_requirements": {
                            "platforms": ["Instagram", "YouTube"],
                            "min_followers": 100000,
                            "target_countries": ["Australia", "USA", "UK"],
                            "target_age_min": 28,
                            "target_age_max": 50,
                        },
                    },
                ]
            },
            {
                "email": "hotel4@mock.com",
                "name": "City Center Hotel",
                "type": "hotel",
                "status": "pending",
                "email_verified": False,
                "avatar": "https://i.pravatar.cc/150?img=33",
                "profile": {
                    "name": "City Center Hotel",
                    "location": "Paris, France",
                    "about": "Modern hotel in the heart of Paris, close to major attractions and shopping",
                    "website": "https://citycenterparis.com",
                    "phone": "+33-1-23-45-67-89",
                    "picture": None,
                    "profile_complete": False,
                },
                "listings": [
                    {
                        "name": "Deluxe Room",
                        "location": "Paris - City Center",
                        "description": "Comfortable room with city views, perfect for business or leisure",
                        "accommodation_type": "Hotel",
                        "images": [
                            "https://images.unsplash.com/photo-1590490360182-c33d57733427?w=800",
                        ],
                        "status": "pending",
                        "collaboration_offerings": [
                            {
                                "collaboration_type": "Discount",
                                "availability_months": ["January", "February", "March", "November", "December"],
                                "platforms": ["Instagram", "Facebook"],
                                "discount_percentage": 20,
                            },
                        ],
                        "creator_requirements": {
                            "platforms": ["Instagram", "Facebook"],
                            "min_followers": 50000,
                            "target_countries": ["France", "UK", "Germany", "Spain"],
                            "target_age_min": 25,
                            "target_age_max": 45,
                        },
                    },
                ]
            },
        ]
        
        created_count = 0
        skipped_count = 0
        
        # Track IDs for creating collaborations later
        creator_ids_by_email = {}
        hotel_ids_by_email = {}
        listing_ids_by_hotel_email = {}
        
        for user_data in mock_users:
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
                creator_ids_by_email[email] = creator_id
                
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
                hotel_ids_by_email[email] = hotel_id
                listing_ids_by_hotel_email[email] = []
                
                # Create listings
                for listing_data in user_data.get("listings", []):
                    listing = await conn.fetchrow(
                        """
                        INSERT INTO hotel_listings 
                            (hotel_profile_id, name, location, description, accommodation_type, images, status)
                        VALUES ($1, $2, $3, $4, $5, $6, $7)
                        RETURNING id
                        """,
                        hotel_id,
                        listing_data["name"],
                        listing_data["location"],
                        listing_data["description"],
                        listing_data.get("accommodation_type"),
                        listing_data.get("images", []),
                        listing_data.get("status", "pending"),
                    )
                    listing_id = listing['id']
                    listing_ids_by_hotel_email[email].append(listing_id)
                    
                    # Create collaboration offerings
                    for offering_data in listing_data.get("collaboration_offerings", []):
                        await conn.execute(
                            """
                            INSERT INTO listing_collaboration_offerings
                                (listing_id, collaboration_type, availability_months, platforms,
                                 free_stay_min_nights, free_stay_max_nights, paid_max_amount, discount_percentage)
                            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                            """,
                            listing_id,
                            offering_data["collaboration_type"],
                            offering_data["availability_months"],
                            offering_data["platforms"],
                            offering_data.get("free_stay_min_nights"),
                            offering_data.get("free_stay_max_nights"),
                            offering_data.get("paid_max_amount"),
                            offering_data.get("discount_percentage"),
                        )
                    
                    # Create creator requirements
                    if listing_data.get("creator_requirements"):
                        req_data = listing_data["creator_requirements"]
                        await conn.execute(
                            """
                            INSERT INTO listing_creator_requirements
                                (listing_id, platforms, min_followers, target_countries, target_age_min, target_age_max)
                            VALUES ($1, $2, $3, $4, $5, $6)
                            """,
                            listing_id,
                            req_data["platforms"],
                            req_data.get("min_followers"),
                            req_data["target_countries"],
                            req_data.get("target_age_min"),
                            req_data.get("target_age_max"),
                        )
                
                total_offerings = sum(len(l.get("collaboration_offerings", [])) for l in user_data.get("listings", []))
                print(f"   ✅ Created hotel profile with {len(user_data.get('listings', []))} listings and {total_offerings} collaboration offerings")
            
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
        
        # Create collaborations
        print("🤝 Creating collaboration requests...")
        collaboration_count = 0
        
        # Get all creator and listing IDs (including existing ones)
        all_creators = await conn.fetch(
            """
            SELECT c.id, u.email 
            FROM creators c 
            JOIN users u ON u.id = c.user_id 
            WHERE u.email LIKE '%@mock.com'
            """
        )
        all_listings = await conn.fetch(
            """
            SELECT hl.id, hl.name, hp.id as hotel_id, u.email as hotel_email
            FROM hotel_listings hl
            JOIN hotel_profiles hp ON hp.id = hl.hotel_profile_id
            JOIN users u ON u.id = hp.user_id
            WHERE u.email LIKE '%@mock.com' AND hl.status = 'verified'
            """
        )
        
        # Map creators and listings
        creator_map = {row['email']: row['id'] for row in all_creators}
        listing_map = {row['id']: row for row in all_listings}
        
        # Define collaboration requests
        collaboration_requests = [
            # Creator-initiated (applications)
            {
                "creator_email": "creator1@mock.com",
                "hotel_email": "hotel1@mock.com",
                "listing_name": "Ocean View Villa",
                "initiator_type": "creator",
                "status": "pending",
                "why_great_fit": "I have a strong following in the travel niche with 150K+ Instagram followers. My content focuses on luxury destinations and would perfectly showcase your beautiful resort.",
                "travel_date_from": "2024-06-01",
                "travel_date_to": "2024-06-05",
                "preferred_months": ["Jun", "Jul"],
                "consent": True,
                "platform_deliverables": [
                    {
                        "platform": "Instagram",
                        "deliverables": [
                            {"type": "Instagram Post", "quantity": 2},
                            {"type": "Instagram Stories", "quantity": 5}
                        ]
                    },
                    {
                        "platform": "TikTok",
                        "deliverables": [
                            {"type": "TikTok Video", "quantity": 3}
                        ]
                    }
                ]
            },
            {
                "creator_email": "creator2@mock.com",
                "hotel_email": "hotel3@mock.com",
                "listing_name": "Oceanfront Suite",
                "initiator_type": "creator",
                "status": "accepted",
                "why_great_fit": "As a food blogger with 200K Instagram followers, I would love to showcase your restaurant and dining experiences. My audience is highly engaged with food and travel content.",
                "travel_date_from": "2024-05-15",
                "travel_date_to": "2024-05-20",
                "preferred_months": ["May", "Jun"],
                "consent": True,
                "platform_deliverables": [
                    {
                        "platform": "Instagram",
                        "deliverables": [
                            {"type": "Instagram Post", "quantity": 3},
                            {"type": "Instagram Stories", "quantity": 7}
                        ]
                    },
                    {
                        "platform": "YouTube",
                        "deliverables": [
                            {"type": "YouTube Video", "quantity": 1}
                        ]
                    }
                ],
                "responded_at": datetime(2024, 1, 10, 12, 0, 0)
            },
            {
                "creator_email": "creator4@mock.com",
                "hotel_email": "hotel2@mock.com",
                "listing_name": "Alpine Chalet",
                "initiator_type": "creator",
                "status": "declined",
                "why_great_fit": "I specialize in adventure travel content and would love to showcase your ski-in/ski-out chalet. My YouTube channel has 220K subscribers interested in outdoor activities.",
                "travel_date_from": "2024-12-20",
                "travel_date_to": "2024-12-27",
                "preferred_months": ["Dec", "Jan"],
                "consent": True,
                "platform_deliverables": [
                    {
                        "platform": "YouTube",
                        "deliverables": [
                            {"type": "YouTube Video", "quantity": 2}
                        ]
                    },
                    {
                        "platform": "Instagram",
                        "deliverables": [
                            {"type": "Instagram Post", "quantity": 4}
                        ]
                    }
                ],
                "responded_at": datetime(2024, 1, 8, 10, 30, 0)
            },
            {
                "creator_email": "creator1@mock.com",
                "hotel_email": "hotel3@mock.com",
                "listing_name": "Garden Villa",
                "initiator_type": "creator",
                "status": "completed",
                "why_great_fit": "Perfect match for my travel content! I've been wanting to visit Bali and your villa looks stunning. My audience would love this destination.",
                "travel_date_from": "2024-04-10",
                "travel_date_to": "2024-04-15",
                "preferred_months": ["Apr", "May"],
                "consent": True,
                "platform_deliverables": [
                    {
                        "platform": "Instagram",
                        "deliverables": [
                            {"type": "Instagram Post", "quantity": 3},
                            {"type": "Instagram Stories", "quantity": 8}
                        ]
                    },
                    {
                        "platform": "TikTok",
                        "deliverables": [
                            {"type": "TikTok Video", "quantity": 5}
                        ]
                    }
                ],
                "responded_at": datetime(2024, 1, 5, 14, 0, 0),
                "completed_at": datetime(2024, 4, 20, 16, 0, 0)
            },
            
            # Hotel-initiated (invitations)
            {
                "creator_email": "creator3@mock.com",
                "hotel_email": "hotel1@mock.com",
                "listing_name": "Luxury Suite",
                "initiator_type": "hotel",
                "status": "pending",
                "collaboration_type": "Discount",
                "discount_percentage": 30,
                "preferred_date_from": "2024-02-01",
                "preferred_date_to": "2024-02-29",
                "platform_deliverables": [
                    {
                        "platform": "Instagram",
                        "deliverables": [
                            {"type": "Instagram Post", "quantity": 2},
                            {"type": "Instagram Stories", "quantity": 4}
                        ]
                    },
                    {
                        "platform": "Facebook",
                        "deliverables": [
                            {"type": "Facebook Post", "quantity": 1}
                        ]
                    }
                ]
            },
            {
                "creator_email": "creator2@mock.com",
                "hotel_email": "hotel1@mock.com",
                "listing_name": "Ocean View Villa",
                "initiator_type": "hotel",
                "status": "accepted",
                "collaboration_type": "Free Stay",
                "free_stay_min_nights": 3,
                "free_stay_max_nights": 7,
                "preferred_date_from": "2024-03-01",
                "preferred_date_to": "2024-05-31",
                "platform_deliverables": [
                    {
                        "platform": "Instagram",
                        "deliverables": [
                            {"type": "Instagram Post", "quantity": 3},
                            {"type": "Instagram Stories", "quantity": 6}
                        ]
                    },
                    {
                        "platform": "YouTube",
                        "deliverables": [
                            {"type": "YouTube Video", "quantity": 1}
                        ]
                    }
                ],
                "responded_at": datetime(2024, 1, 12, 9, 0, 0)
            },
            {
                "creator_email": "creator4@mock.com",
                "hotel_email": "hotel2@mock.com",
                "listing_name": "Mountain Suite",
                "initiator_type": "hotel",
                "status": "pending",
                "collaboration_type": "Discount",
                "discount_percentage": 25,
                "preferred_date_from": "2024-09-01",
                "preferred_date_to": "2024-11-30",
                "platform_deliverables": [
                    {
                        "platform": "Instagram",
                        "deliverables": [
                            {"type": "Instagram Post", "quantity": 2}
                        ]
                    },
                    {
                        "platform": "Facebook",
                        "deliverables": [
                            {"type": "Facebook Post", "quantity": 1}
                        ]
                    }
                ]
            },
            {
                "creator_email": "creator1@mock.com",
                "hotel_email": "hotel3@mock.com",
                "listing_name": "Oceanfront Suite",
                "initiator_type": "hotel",
                "status": "pending",
                "collaboration_type": "Free Stay",
                "free_stay_min_nights": 3,
                "free_stay_max_nights": 7,
                "preferred_date_from": "2024-04-01",
                "preferred_date_to": "2024-06-30",
                "platform_deliverables": [
                    {
                        "platform": "Instagram",
                        "deliverables": [
                            {"type": "Instagram Post", "quantity": 2},
                            {"type": "Instagram Stories", "quantity": 5}
                        ]
                    },
                    {
                        "platform": "TikTok",
                        "deliverables": [
                            {"type": "TikTok Video", "quantity": 2}
                        ]
                    }
                ]
            },
            {
                "creator_email": "creator3@mock.com",
                "hotel_email": "hotel2@mock.com",
                "listing_name": "Alpine Chalet",
                "initiator_type": "hotel",
                "status": "accepted",
                "collaboration_type": "Paid",
                "paid_amount": Decimal("3000.00"),
                "preferred_date_from": "2024-04-01",
                "preferred_date_to": "2024-08-31",
                "platform_deliverables": [
                    {
                        "platform": "Instagram",
                        "deliverables": [
                            {"type": "Instagram Post", "quantity": 4},
                            {"type": "Instagram Stories", "quantity": 8}
                        ]
                    },
                    {
                        "platform": "YouTube",
                        "deliverables": [
                            {"type": "YouTube Video", "quantity": 2}
                        ]
                    }
                ],
                "responded_at": datetime(2024, 1, 11, 15, 30, 0)
            },
        ]
        
        for collab_req in collaboration_requests:
            creator_id = creator_map.get(collab_req["creator_email"])
            if not creator_id:
                print(f"   ⚠️  Skipping collaboration: Creator {collab_req['creator_email']} not found")
                continue
            
            # Find listing by hotel email and listing name
            listing = None
            for listing_row in all_listings:
                if (listing_row['hotel_email'] == collab_req["hotel_email"] and 
                    listing_row['name'] == collab_req["listing_name"]):
                    listing = listing_row
                    break
            
            if not listing:
                print(f"   ⚠️  Skipping collaboration: Listing '{collab_req['listing_name']}' for {collab_req['hotel_email']} not found")
                continue
            
            hotel_id = listing['hotel_id']
            listing_id = listing['id']
            
            # Check if collaboration already exists
            existing = await conn.fetchrow(
                """
                SELECT id FROM collaborations 
                WHERE creator_id = $1 AND listing_id = $2 AND status IN ('pending', 'accepted')
                """,
                creator_id, listing_id
            )
            
            if existing:
                print(f"   ⏭️  Skipping collaboration: Already exists between creator and listing")
                continue
            
            # Prepare platform_deliverables JSON
            platform_deliverables_json = json.dumps(collab_req["platform_deliverables"])
            
            # Insert collaboration
            await conn.execute(
                """
                INSERT INTO collaborations (
                    initiator_type, creator_id, hotel_id, listing_id, status,
                    why_great_fit, collaboration_type,
                    free_stay_min_nights, free_stay_max_nights,
                    paid_amount, discount_percentage,
                    travel_date_from, travel_date_to,
                    preferred_date_from, preferred_date_to,
                    preferred_months, platform_deliverables, consent,
                    responded_at, completed_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
                """,
                collab_req["initiator_type"],
                creator_id,
                hotel_id,
                listing_id,
                collab_req["status"],
                collab_req.get("why_great_fit"),
                collab_req.get("collaboration_type"),
                collab_req.get("free_stay_min_nights"),
                collab_req.get("free_stay_max_nights"),
                collab_req.get("paid_amount"),
                collab_req.get("discount_percentage"),
                collab_req.get("travel_date_from"),
                collab_req.get("travel_date_to"),
                collab_req.get("preferred_date_from"),
                collab_req.get("preferred_date_to"),
                collab_req.get("preferred_months"),
                platform_deliverables_json,
                collab_req.get("consent"),
                collab_req.get("responded_at"),
                collab_req.get("completed_at"),
            )
            collaboration_count += 1
            print(f"   ✅ Created {collab_req['initiator_type']}-initiated collaboration: {collab_req['status']}")
        
        print(f"   ✨ Created {collaboration_count} collaborations\n")
        
        await conn.close()
        
        print("=" * 60)
        print(f"✨ Mock users creation complete!")
        print(f"   Created: {created_count} users")
        print(f"   Skipped: {skipped_count} users (already exist)")
        print(f"   Created: {collaboration_count} collaborations")
        print()
        print("📋 Mock Users Created:")
        print("   Creators:")
        print("     - creator1@mock.com (Alexandra Travels) - 3 platforms")
        print("     - creator2@mock.com (Marcus Foodie) - 2 platforms")
        print("     - creator3@mock.com (Emma Style) - 2 platforms")
        print("     - creator4@mock.com (David Adventure) - 2 platforms")
        print("   Hotels:")
        print("     - hotel1@mock.com (Grand Paradise Resort) - 3 listings")
        print("     - hotel2@mock.com (Mountain View Lodge) - 2 listings")
        print("     - hotel3@mock.com (Beachside Boutique) - 2 listings")
        print("     - hotel4@mock.com (City Center Hotel) - 1 listing")
        print()
        print("🤝 Collaborations Created:")
        print("   - Mix of creator-initiated and hotel-initiated")
        print("   - Various statuses: pending, accepted, declined, completed")
        print("   - Different types: Free Stay, Paid, Discount")
        print()
        print("🔑 All mock users have password: Test1234")
        print("=" * 60)
        
    except Exception as e:
        print(f"❌ Error creating mock users: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    print("🚀 Adding mock users to database...")
    print()
    asyncio.run(add_mock_users())

