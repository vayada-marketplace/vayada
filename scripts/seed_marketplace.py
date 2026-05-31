"""
Seed marketplace database with mock profiles, listings, collaborations, chats, and reviews.

Requires seed_users.py to have been run first (users must exist in auth DB).

Usage:
    python scripts/seed_marketplace.py
"""

import asyncio
import json
import os
from datetime import date, datetime, timedelta
from decimal import Decimal

import asyncpg

MARKETPLACE_DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://vayada_user:vayada_password@localhost:5432/vayada_db",
)
AUTH_DATABASE_URL = os.getenv(
    "AUTH_DATABASE_URL",
    "postgresql://vayada_auth_user:vayada_auth_password@localhost:5435/vayada_auth_db",
)

MOCK_PASSWORD = "Test1234"

# ---------------------------------------------------------------------------
# Creator profiles & platforms
# ---------------------------------------------------------------------------
CREATOR_PROFILES = {
    "creator1@mock.com": {
        "location": "New York, USA",
        "short_description": "Travel content creator sharing amazing destinations around the world",
        "portfolio_link": "https://alexandratravels.com",
        "phone": "+1-555-1001",
        "profile_picture": "https://i.pravatar.cc/300?img=1",
        "profile_complete": True,
        "creator_type": "Travel",
        "platforms": [
            {
                "name": "Instagram",
                "handle": "@alexandratravels",
                "followers": 150000,
                "engagement_rate": Decimal("4.5"),
                "top_countries": {
                    "USA": 40,
                    "UK": 25,
                    "Canada": 15,
                    "Australia": 10,
                    "Germany": 10,
                },
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
        ],
    },
    "creator2@mock.com": {
        "location": "Los Angeles, USA",
        "short_description": "Food blogger and restaurant reviewer exploring culinary delights",
        "portfolio_link": "https://marcusfoodie.com",
        "phone": "+1-555-1002",
        "profile_picture": "https://i.pravatar.cc/300?img=12",
        "profile_complete": True,
        "creator_type": "Lifestyle",
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
        ],
    },
    "creator3@mock.com": {
        "location": "London, UK",
        "short_description": "Fashion and beauty influencer sharing style tips and trends",
        "portfolio_link": "https://emmastyle.com",
        "phone": "+44-20-7946-1003",
        "profile_picture": "https://i.pravatar.cc/300?img=5",
        "profile_complete": True,
        "creator_type": "Lifestyle",
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
                "top_countries": {
                    "UK": 45,
                    "USA": 20,
                    "Canada": 15,
                    "Australia": 10,
                    "Germany": 10,
                },
                "top_age_groups": {"25-34": 40, "35-44": 35, "45+": 15, "18-24": 10},
                "gender_split": {"female": 70, "male": 25, "other": 5},
            },
        ],
    },
    "creator4@mock.com": {
        "location": "Barcelona, Spain",
        "short_description": "Adventure travel and outdoor activities enthusiast",
        "portfolio_link": "https://davidadventure.com",
        "phone": "+34-93-123-4567",
        "profile_picture": "https://i.pravatar.cc/300?img=15",
        "profile_complete": True,
        "creator_type": "Travel",
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
        ],
    },
}

# ---------------------------------------------------------------------------
# Hotel profiles & listings
# ---------------------------------------------------------------------------
HOTEL_PROFILES = {
    "hotel1@mock.com": {
        "name": "Grand Paradise Resort",
        "location": "Maldives",
        "about": "Luxury beachfront resort with world-class amenities, stunning ocean views, and exceptional service",
        "website": "https://grandparadise.com",
        "phone": "+960-123-4567",
        "picture": "https://images.unsplash.com/photo-1571896349842-33c89424de2d?w=800",
        "profile_complete": True,
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
                        "availability_months": [
                            "January",
                            "February",
                            "March",
                            "April",
                            "May",
                            "September",
                            "October",
                            "November",
                        ],
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
                    "target_age_groups": ["25-34", "35-44"],
                    "creator_types": ["Travel"],
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
                        "availability_months": [
                            "January",
                            "February",
                            "March",
                            "November",
                            "December",
                        ],
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
                    "target_age_groups": ["25-34", "35-44", "45-54"],
                    "creator_types": ["Lifestyle", "Travel"],
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
                    "target_age_groups": ["25-34", "35-44"],
                },
            },
        ],
    },
    "hotel2@mock.com": {
        "name": "Mountain View Lodge",
        "location": "Switzerland, Alps",
        "about": "Cozy mountain lodge perfect for skiing and hiking enthusiasts. Traditional Swiss hospitality in a stunning alpine setting.",
        "website": "https://mountainviewlodge.ch",
        "phone": "+41-21-123-4567",
        "picture": "https://images.unsplash.com/photo-1520250497591-112f2f40a3f4?w=800",
        "profile_complete": True,
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
                    "target_age_groups": ["25-34", "35-44"],
                    "creator_types": ["Travel"],
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
                    "target_age_groups": ["25-34", "35-44", "45-54", "55+"],
                },
            },
        ],
    },
    "hotel3@mock.com": {
        "name": "Beachside Boutique",
        "location": "Bali, Indonesia",
        "about": "Intimate boutique hotel with stunning beach views and personalized service. Perfect for a romantic getaway.",
        "website": "https://beachsideboutique.bali",
        "phone": "+62-361-123-456",
        "picture": "https://images.unsplash.com/photo-1571896349842-33c89424de2d?w=800",
        "profile_complete": True,
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
                        "availability_months": [
                            "January",
                            "February",
                            "March",
                            "November",
                            "December",
                        ],
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
                    "target_age_groups": ["25-34", "35-44"],
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
                    "target_age_groups": ["25-34", "35-44", "45-54"],
                },
            },
        ],
    },
    "hotel4@mock.com": {
        "name": "City Center Hotel",
        "location": "Paris, France",
        "about": "Modern hotel in the heart of Paris, close to major attractions and shopping",
        "website": "https://citycenterparis.com",
        "phone": "+33-1-23-45-67-89",
        "picture": None,
        "profile_complete": False,
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
                        "availability_months": [
                            "January",
                            "February",
                            "March",
                            "November",
                            "December",
                        ],
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
                    "target_age_groups": ["25-34", "35-44"],
                },
            },
        ],
    },
    "hotel5@mock.com": {
        "name": "Seaside Retreat",
        "location": "Dubrovnik, Croatia",
        "about": "Charming coastal retreat with stunning Adriatic views and authentic Croatian hospitality",
        "website": "https://seasideretreat.hr",
        "phone": "+385-20-123-456",
        "picture": "https://images.unsplash.com/photo-1566073771259-6a8506099945?w=800",
        "profile_complete": True,
        "listings": [
            {
                "name": "Sea View Suite",
                "location": "Dubrovnik - Old Town",
                "description": "Elegant suite with panoramic Adriatic views and private terrace",
                "accommodation_type": "Boutiques Hotel",
                "images": [
                    "https://images.unsplash.com/photo-1566073771259-6a8506099945?w=800",
                    "https://images.unsplash.com/photo-1520250497591-112f2f40a3f4?w=800",
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
                ],
                "creator_requirements": {
                    "platforms": ["Instagram", "TikTok", "YouTube"],
                    "min_followers": 100000,
                    "target_countries": ["UK", "Germany", "USA", "France", "Croatia"],
                    "target_age_min": 25,
                    "target_age_max": 45,
                    "target_age_groups": ["25-34", "35-44"],
                    "creator_types": ["Travel"],
                },
            },
        ],
    },
}

# ---------------------------------------------------------------------------
# Collaborations
# ---------------------------------------------------------------------------
COLLABORATIONS = [
    {
        "creator_email": "creator2@mock.com",
        "hotel_email": "hotel3@mock.com",
        "listing_name": "Oceanfront Suite",
        "initiator_type": "creator",
        "status": "negotiating",
        "why_great_fit": "As a food blogger with 200K Instagram followers, I would love to showcase your restaurant and dining experiences. My audience is highly engaged with food and travel content.",
        "travel_date_from": date.today() + timedelta(days=30),
        "travel_date_to": date.today() + timedelta(days=35),
        "preferred_months": ["May", "Jun"],
        "consent": True,
        "platform_deliverables": [
            {
                "platform": "Instagram",
                "deliverables": [
                    {"type": "Instagram Post", "quantity": 3},
                    {"type": "Instagram Stories", "quantity": 7},
                ],
            },
            {"platform": "YouTube", "deliverables": [{"type": "YouTube Video", "quantity": 1}]},
        ],
        "responded_at": datetime.now() - timedelta(days=5),
        "hotel_agreed_at": datetime.now() - timedelta(days=5),
        "creator_agreed_at": datetime.now() - timedelta(days=5, hours=-2),
    },
    {
        "creator_email": "creator4@mock.com",
        "hotel_email": "hotel2@mock.com",
        "listing_name": "Alpine Chalet",
        "initiator_type": "creator",
        "status": "declined",
        "why_great_fit": "I specialize in adventure travel content and would love to showcase your ski-in/ski-out chalet. My YouTube channel has 220K subscribers interested in outdoor activities.",
        "travel_date_from": date.today() + timedelta(days=60),
        "travel_date_to": date.today() + timedelta(days=67),
        "preferred_months": ["Dec", "Jan"],
        "consent": True,
        "platform_deliverables": [
            {"platform": "YouTube", "deliverables": [{"type": "YouTube Video", "quantity": 2}]},
            {"platform": "Instagram", "deliverables": [{"type": "Instagram Post", "quantity": 4}]},
        ],
        "responded_at": datetime.now() - timedelta(days=10),
    },
    {
        "creator_email": "creator1@mock.com",
        "hotel_email": "hotel3@mock.com",
        "listing_name": "Garden Villa",
        "initiator_type": "creator",
        "status": "completed",
        "why_great_fit": "Perfect match for my travel content! I've been wanting to visit Bali and your villa looks stunning. My audience would love this destination.",
        "travel_date_from": date.today() - timedelta(days=30),
        "travel_date_to": date.today() - timedelta(days=25),
        "preferred_months": ["Apr", "May"],
        "consent": True,
        "platform_deliverables": [
            {
                "platform": "Instagram",
                "deliverables": [
                    {"type": "Instagram Post", "quantity": 3},
                    {"type": "Instagram Stories", "quantity": 8},
                ],
            },
            {"platform": "TikTok", "deliverables": [{"type": "TikTok Video", "quantity": 5}]},
        ],
        "responded_at": datetime.now() - timedelta(days=45),
        "completed_at": datetime.now() - timedelta(days=20),
        "creator_fee": Decimal("8.00"),
        "affiliate_referral_code": "ALEX-GARDEN",
        "affiliate_link": "https://beachsideboutique.bali/book?ref=ALEX-GARDEN",
    },
    # Hotel-initiated
    {
        "creator_email": "creator3@mock.com",
        "hotel_email": "hotel1@mock.com",
        "listing_name": "Luxury Suite",
        "initiator_type": "hotel",
        "status": "pending",
        "collaboration_type": "Discount",
        "discount_percentage": 30,
        "preferred_date_from": date.today() + timedelta(days=14),
        "preferred_date_to": date.today() + timedelta(days=44),
        "platform_deliverables": [
            {
                "platform": "Instagram",
                "deliverables": [
                    {"type": "Instagram Post", "quantity": 2},
                    {"type": "Instagram Stories", "quantity": 4},
                ],
            },
            {"platform": "Facebook", "deliverables": [{"type": "Facebook Post", "quantity": 1}]},
        ],
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
        "preferred_date_from": date.today() + timedelta(days=20),
        "preferred_date_to": date.today() + timedelta(days=90),
        "platform_deliverables": [
            {
                "platform": "Instagram",
                "deliverables": [
                    {"type": "Instagram Post", "quantity": 3},
                    {"type": "Instagram Stories", "quantity": 6},
                ],
            },
            {"platform": "YouTube", "deliverables": [{"type": "YouTube Video", "quantity": 1}]},
        ],
        "responded_at": datetime.now() - timedelta(days=3),
        "hotel_agreed_at": datetime.now() - timedelta(days=3),
        "creator_agreed_at": datetime.now() - timedelta(days=3, hours=-1),
        "creator_fee": Decimal("5.00"),
        "affiliate_referral_code": "MARC-PARADISE",
        "affiliate_link": "https://grandparadise.com/book?ref=MARC-PARADISE",
    },
    {
        "creator_email": "creator4@mock.com",
        "hotel_email": "hotel2@mock.com",
        "listing_name": "Mountain Suite",
        "initiator_type": "hotel",
        "status": "pending",
        "collaboration_type": "Discount",
        "discount_percentage": 25,
        "preferred_date_from": date.today() + timedelta(days=45),
        "preferred_date_to": date.today() + timedelta(days=120),
        "platform_deliverables": [
            {"platform": "Instagram", "deliverables": [{"type": "Instagram Post", "quantity": 2}]},
            {"platform": "Facebook", "deliverables": [{"type": "Facebook Post", "quantity": 1}]},
        ],
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
        "preferred_date_from": date.today() + timedelta(days=30),
        "preferred_date_to": date.today() + timedelta(days=100),
        "platform_deliverables": [
            {
                "platform": "Instagram",
                "deliverables": [
                    {"type": "Instagram Post", "quantity": 2},
                    {"type": "Instagram Stories", "quantity": 5},
                ],
            },
            {"platform": "TikTok", "deliverables": [{"type": "TikTok Video", "quantity": 2}]},
        ],
    },
    {
        "creator_email": "creator3@mock.com",
        "hotel_email": "hotel2@mock.com",
        "listing_name": "Alpine Chalet",
        "initiator_type": "hotel",
        "status": "accepted",
        "collaboration_type": "Paid",
        "paid_amount": Decimal("3000.00"),
        "preferred_date_from": date.today() + timedelta(days=15),
        "preferred_date_to": date.today() + timedelta(days=150),
        "platform_deliverables": [
            {
                "platform": "Instagram",
                "deliverables": [
                    {"type": "Instagram Post", "quantity": 4},
                    {"type": "Instagram Stories", "quantity": 8},
                ],
            },
            {"platform": "YouTube", "deliverables": [{"type": "YouTube Video", "quantity": 2}]},
        ],
        "responded_at": datetime.now() - timedelta(days=7),
        "hotel_agreed_at": datetime.now() - timedelta(days=7),
        "creator_agreed_at": datetime.now() - timedelta(days=7, hours=-1),
    },
    {
        "creator_email": "creator1@mock.com",
        "hotel_email": "hotel1@mock.com",
        "listing_name": "Ocean View Villa",
        "initiator_type": "creator",
        "status": "negotiating",
        "why_great_fit": "I'd love to visit! Let's discuss the dates.",
        "travel_date_from": date.today() + timedelta(days=40),
        "travel_date_to": date.today() + timedelta(days=45),
        "preferred_months": ["Jul"],
        "consent": True,
        "platform_deliverables": [
            {
                "platform": "Instagram",
                "deliverables": [
                    {"type": "Instagram Post", "quantity": 3},
                    {"type": "Instagram Stories", "quantity": 10},
                ],
            },
        ],
        "hotel_agreed_at": datetime.now() - timedelta(days=2),
        "creator_agreed_at": None,
        "term_last_updated_at": datetime.now() - timedelta(days=2),
    },
]

# ---------------------------------------------------------------------------
# Trips & External Collaborations
# ---------------------------------------------------------------------------
TRIPS = [
    {
        "creator_email": "creator1@mock.com",
        "name": "Bali Spring Trip",
        "location": "Bali, Indonesia",
        "start_date": date.today() + timedelta(days=20),
        "end_date": date.today() + timedelta(days=30),
        "notes": "Visiting multiple resorts for content creation",
    },
    {
        "creator_email": "creator1@mock.com",
        "name": "Maldives Summer",
        "location": "Maldives",
        "start_date": date.today() + timedelta(days=60),
        "end_date": date.today() + timedelta(days=70),
        "notes": "Luxury resort content series",
    },
    {
        "creator_email": "creator4@mock.com",
        "name": "Swiss Alps Adventure",
        "location": "Switzerland, Alps",
        "start_date": date.today() + timedelta(days=45),
        "end_date": date.today() + timedelta(days=55),
        "notes": "Skiing and hiking content for winter series",
    },
    {
        "creator_email": "creator2@mock.com",
        "name": "Croatia Food Tour",
        "location": "Dubrovnik, Croatia",
        "start_date": date.today() + timedelta(days=35),
        "end_date": date.today() + timedelta(days=42),
        "notes": "Exploring local restaurants and coastal cuisine",
    },
]

EXTERNAL_COLLABORATIONS = [
    {
        "creator_email": "creator1@mock.com",
        "trip_name": "Bali Spring Trip",
        "title": "Ubud Eco Resort Feature",
        "hotel_name": "Ubud Green Villas",
        "location": "Ubud, Bali",
        "collaboration_type": "Free Stay",
        "start_date": date.today() + timedelta(days=22),
        "end_date": date.today() + timedelta(days=25),
        "deliverables": "3 Instagram posts, 1 YouTube vlog, 10 Stories",
        "notes": "Eco-tourism angle, sustainable travel content",
    },
    {
        "creator_email": "creator4@mock.com",
        "trip_name": "Swiss Alps Adventure",
        "title": "Zermatt Ski Lodge Partnership",
        "hotel_name": "Zermatt Mountain Lodge",
        "location": "Zermatt, Switzerland",
        "collaboration_type": "Paid",
        "start_date": date.today() + timedelta(days=47),
        "end_date": date.today() + timedelta(days=50),
        "deliverables": "2 YouTube videos, 5 Instagram posts",
        "notes": "Paid partnership for winter sports content",
    },
    {
        "creator_email": "creator2@mock.com",
        "trip_name": "Croatia Food Tour",
        "title": "Old Town Restaurant Review",
        "hotel_name": None,
        "location": "Dubrovnik Old Town, Croatia",
        "collaboration_type": "Custom / External",
        "start_date": date.today() + timedelta(days=36),
        "end_date": date.today() + timedelta(days=38),
        "deliverables": "1 YouTube food review, 5 Instagram Stories",
        "notes": "Local restaurant partnership, not hotel-based",
    },
]

# ---------------------------------------------------------------------------
# Reviews
# ---------------------------------------------------------------------------
REVIEWS = [
    {
        "creator_email": "creator1@mock.com",
        "rating": 5,
        "comment": "Excellent content quality and very professional to work with. Highly recommended!",
    },
    {
        "creator_email": "creator2@mock.com",
        "rating": 5,
        "comment": "Amazing photos! Exactly what we were looking for. Delivered everything on time.",
    },
    {
        "creator_email": "creator3@mock.com",
        "rating": 4,
        "comment": "Great reach and engagement. Communication could be slightly faster but overall good experience.",
    },
    {
        "creator_email": "creator4@mock.com",
        "rating": 5,
        "comment": "Truly authentic content. Our guests loved the reel! Will definitely work again.",
    },
    {
        "creator_email": "creator1@mock.com",
        "rating": 5,
        "comment": "Super creative and professional. The video quality is top notch.",
    },
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def parse_date(val):
    if isinstance(val, str):
        return datetime.strptime(val, "%Y-%m-%d").date()
    return val


async def ensure_marketplace_user(conn, auth_conn, email):
    """Look up user ID from auth DB (users table no longer exists in marketplace DB)."""
    auth_user = await auth_conn.fetchrow(
        "SELECT id FROM users WHERE email = $1",
        email,
    )
    if not auth_user:
        return None
    return auth_user["id"]


async def main():
    conn = await asyncpg.connect(MARKETPLACE_DATABASE_URL)
    auth_conn = await asyncpg.connect(AUTH_DATABASE_URL)
    print("Connected to marketplace + auth databases\n")

    try:
        # ------------------------------------------------------------------
        # 1. Look up user IDs from auth DB
        # ------------------------------------------------------------------
        all_emails = list(CREATOR_PROFILES.keys()) + list(HOTEL_PROFILES.keys())
        user_ids = {}
        for email in all_emails:
            uid = await ensure_marketplace_user(conn, auth_conn, email)
            if uid:
                user_ids[email] = uid
            else:
                print(f"  WARNING: {email} not found in auth DB — run seed_users.py first")

        # ------------------------------------------------------------------
        # 2. Creator profiles & platforms
        # ------------------------------------------------------------------
        print("Seeding creator profiles...")
        creator_db_ids = {}  # email -> creators.id
        for email, profile in CREATOR_PROFILES.items():
            uid = user_ids.get(email)
            if not uid:
                continue
            existing = await conn.fetchrow("SELECT id FROM creators WHERE user_id = $1", uid)
            if existing:
                creator_db_ids[email] = existing["id"]
                print(f"  Skipped: {email} (profile exists)")
                continue
            row = await conn.fetchrow(
                """
                INSERT INTO creators (user_id, location, short_description, portfolio_link, phone,
                                      profile_picture, profile_complete, profile_completed_at, creator_type)
                VALUES ($1, $2, $3, $4, $5, $6, $7,
                        CASE WHEN $7 = true THEN now() ELSE NULL END, $8)
                RETURNING id
                """,
                uid,
                profile["location"],
                profile["short_description"],
                profile["portfolio_link"],
                profile["phone"],
                profile["profile_picture"],
                profile["profile_complete"],
                profile["creator_type"],
            )
            creator_db_ids[email] = row["id"]

            for p in profile["platforms"]:
                top_countries = (
                    [{"country": k, "percentage": v} for k, v in p["top_countries"].items()]
                    if p.get("top_countries")
                    else None
                )
                top_age = (
                    [{"ageRange": k, "percentage": v} for k, v in p["top_age_groups"].items()]
                    if p.get("top_age_groups")
                    else None
                )
                await conn.execute(
                    """
                    INSERT INTO creator_platforms
                        (creator_id, name, handle, followers, engagement_rate,
                         top_countries, top_age_groups, gender_split)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                    """,
                    row["id"],
                    p["name"],
                    p["handle"],
                    p["followers"],
                    p["engagement_rate"],
                    json.dumps(top_countries) if top_countries else None,
                    json.dumps(top_age) if top_age else None,
                    json.dumps(p["gender_split"]) if p.get("gender_split") else None,
                )
            print(f"  Created: {email} ({len(profile['platforms'])} platforms)")

        # ------------------------------------------------------------------
        # 3. Hotel profiles & listings
        # ------------------------------------------------------------------
        print("\nSeeding hotel profiles & listings...")
        hotel_db_ids = {}  # email -> hotel_profiles.id
        for email, profile in HOTEL_PROFILES.items():
            uid = user_ids.get(email)
            if not uid:
                continue
            existing = await conn.fetchrow("SELECT id FROM hotel_profiles WHERE user_id = $1", uid)
            if existing:
                hotel_id = existing["id"]
                print(f"  Skipped: {email} (profile exists)")
            else:
                row = await conn.fetchrow(
                    """
                    INSERT INTO hotel_profiles (user_id, name, location, about, website, phone,
                                                picture, profile_complete, profile_completed_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                            CASE WHEN $8 = true THEN now() ELSE NULL END)
                    RETURNING id
                    """,
                    uid,
                    profile["name"],
                    profile["location"],
                    profile["about"],
                    profile["website"],
                    profile["phone"],
                    profile["picture"],
                    profile["profile_complete"],
                )
                hotel_id = row["id"]
                print(f"  Created: {email} ({len(profile['listings'])} listings)")
            hotel_db_ids[email] = hotel_id

            for listing in profile["listings"]:
                lr = await conn.fetchrow(
                    "SELECT id FROM hotel_listings WHERE hotel_profile_id = $1 AND name = $2",
                    hotel_id,
                    listing["name"],
                )
                if not lr:
                    lr = await conn.fetchrow(
                        """
                        INSERT INTO hotel_listings
                            (hotel_profile_id, name, location, description, accommodation_type, images, status)
                        VALUES ($1, $2, $3, $4, $5, $6, $7)
                        RETURNING id
                        """,
                        hotel_id,
                        listing["name"],
                        listing["location"],
                        listing["description"],
                        listing.get("accommodation_type"),
                        listing.get("images", []),
                        listing.get("status", "pending"),
                    )
                default_min_followers = (listing.get("creator_requirements") or {}).get(
                    "min_followers"
                )
                for off in listing.get("collaboration_offerings", []):
                    existing_offering = await conn.fetchval(
                        """
                        SELECT 1
                        FROM listing_collaboration_offerings
                        WHERE listing_id = $1
                          AND collaboration_type = $2
                          AND availability_months = $3
                          AND platforms = $4
                          AND COALESCE(free_stay_min_nights, -1) = COALESCE($5, -1)
                          AND COALESCE(free_stay_max_nights, -1) = COALESCE($6, -1)
                          AND COALESCE(paid_max_amount, -1) = COALESCE($7, -1)
                          AND COALESCE(discount_percentage, -1) = COALESCE($8, -1)
                        """,
                        lr["id"],
                        off["collaboration_type"],
                        off["availability_months"],
                        off["platforms"],
                        off.get("free_stay_min_nights"),
                        off.get("free_stay_max_nights"),
                        off.get("paid_max_amount"),
                        off.get("discount_percentage"),
                    )
                    if not existing_offering:
                        await conn.execute(
                            """
                            INSERT INTO listing_collaboration_offerings
                                (listing_id, collaboration_type, availability_months, platforms,
                                 free_stay_min_nights, free_stay_max_nights, paid_max_amount,
                                 discount_percentage, min_followers)
                            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                            """,
                            lr["id"],
                            off["collaboration_type"],
                            off["availability_months"],
                            off["platforms"],
                            off.get("free_stay_min_nights"),
                            off.get("free_stay_max_nights"),
                            off.get("paid_max_amount"),
                            off.get("discount_percentage"),
                            off.get("min_followers", default_min_followers),
                        )
                if listing.get("creator_requirements"):
                    req = listing["creator_requirements"]
                    await conn.execute(
                        """
                        INSERT INTO listing_creator_requirements
                            (listing_id, platforms, target_countries,
                             target_age_min, target_age_max, target_age_groups, creator_types)
                        VALUES ($1, $2, $3, $4, $5, $6, $7)
                        ON CONFLICT (listing_id) DO UPDATE SET
                            platforms = EXCLUDED.platforms,
                            target_countries = EXCLUDED.target_countries,
                            target_age_min = EXCLUDED.target_age_min,
                            target_age_max = EXCLUDED.target_age_max,
                            target_age_groups = EXCLUDED.target_age_groups,
                            creator_types = EXCLUDED.creator_types,
                            updated_at = now()
                        """,
                        lr["id"],
                        req["platforms"],
                        req["target_countries"],
                        req.get("target_age_min"),
                        req.get("target_age_max"),
                        req.get("target_age_groups"),
                        req.get("creator_types", []),
                    )

        # ------------------------------------------------------------------
        # 4. Collaborations
        # ------------------------------------------------------------------
        print("\nSeeding collaborations...")

        # Build lookup: listing name+hotel email -> listing row
        # user_ids maps email -> auth user UUID; reverse it for hotel_profiles lookup
        uid_to_email = {v: k for k, v in user_ids.items()}
        all_listings = await conn.fetch(
            """
            SELECT hl.id, hl.name, hp.id as hotel_id, hp.user_id
            FROM hotel_listings hl
            JOIN hotel_profiles hp ON hp.id = hl.hotel_profile_id
            """
        )
        listing_lookup = {}
        for row in all_listings:
            hotel_email = uid_to_email.get(row["user_id"])
            if hotel_email:
                listing_lookup[(hotel_email, row["name"])] = {
                    "id": row["id"],
                    "name": row["name"],
                    "hotel_id": row["hotel_id"],
                    "hotel_email": hotel_email,
                }

        collab_count = 0
        for c in COLLABORATIONS:
            creator_id = creator_db_ids.get(c["creator_email"])
            listing_row = listing_lookup.get((c["hotel_email"], c["listing_name"]))
            if not creator_id or not listing_row:
                print("  Skipped collab: missing creator or listing")
                continue

            # Parse dates
            for f in (
                "travel_date_from",
                "travel_date_to",
                "preferred_date_from",
                "preferred_date_to",
            ):
                if c.get(f):
                    c[f] = parse_date(c[f])

            row = await conn.fetchrow(
                """
                SELECT id
                FROM collaborations
                WHERE creator_id = $1
                  AND hotel_id = $2
                  AND listing_id = $3
                  AND status = $4
                  AND COALESCE(collaboration_type, '') = COALESCE($5, '')
                  AND COALESCE(why_great_fit, '') = COALESCE($6, '')
                """,
                creator_id,
                listing_row["hotel_id"],
                listing_row["id"],
                c["status"],
                c.get("collaboration_type"),
                c.get("why_great_fit"),
            )
            if row:
                print(f"  Skipped: {c['creator_email']} <-> {c['hotel_email']} ({c['status']})")
            else:
                row = await conn.fetchrow(
                    """
                    INSERT INTO collaborations (
                        initiator_type, creator_id, hotel_id, listing_id, status,
                        why_great_fit, collaboration_type,
                        free_stay_min_nights, free_stay_max_nights,
                        paid_amount, discount_percentage,
                        travel_date_from, travel_date_to,
                        preferred_date_from, preferred_date_to,
                        preferred_months, consent,
                        responded_at, completed_at,
                        hotel_agreed_at, creator_agreed_at, term_last_updated_at,
                        creator_fee, affiliate_referral_code, affiliate_link
                    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
                    RETURNING id
                    """,
                    c["initiator_type"],
                    creator_id,
                    listing_row["hotel_id"],
                    listing_row["id"],
                    c["status"],
                    c.get("why_great_fit"),
                    c.get("collaboration_type"),
                    c.get("free_stay_min_nights"),
                    c.get("free_stay_max_nights"),
                    c.get("paid_amount"),
                    c.get("discount_percentage"),
                    c.get("travel_date_from"),
                    c.get("travel_date_to"),
                    c.get("preferred_date_from"),
                    c.get("preferred_date_to"),
                    c.get("preferred_months"),
                    c.get("consent"),
                    c.get("responded_at"),
                    c.get("completed_at"),
                    c.get("hotel_agreed_at"),
                    c.get("creator_agreed_at"),
                    c.get("term_last_updated_at", datetime.now()),
                    c.get("creator_fee"),
                    c.get("affiliate_referral_code"),
                    c.get("affiliate_link"),
                )
                collab_count += 1
                print(f"  Created: {c['creator_email']} <-> {c['hotel_email']} ({c['status']})")

            for pi in c["platform_deliverables"]:
                for d in pi["deliverables"]:
                    exists = await conn.fetchval(
                        """
                        SELECT 1 FROM collaboration_deliverables
                        WHERE collaboration_id = $1 AND platform = $2 AND type = $3
                        """,
                        row["id"],
                        pi["platform"],
                        d["type"],
                    )
                    if not exists:
                        await conn.execute(
                            """
                            INSERT INTO collaboration_deliverables
                                (collaboration_id, platform, type, quantity, status)
                            VALUES ($1, $2, $3, $4, $5)
                            """,
                            row["id"],
                            pi["platform"],
                            d["type"],
                            d["quantity"],
                            "completed" if c["status"] == "completed" else "pending",
                        )

        # ------------------------------------------------------------------
        # 5. Trips & External Collaborations
        # ------------------------------------------------------------------
        print("\nSeeding trips & external collaborations...")
        trip_db_ids = {}  # (email, trip_name) -> trip.id

        for t in TRIPS:
            cid = creator_db_ids.get(t["creator_email"])
            if not cid:
                print(f"  Skipped trip: creator {t['creator_email']} not found")
                continue
            row = await conn.fetchrow(
                "SELECT id FROM trips WHERE creator_id = $1 AND name = $2",
                cid,
                t["name"],
            )
            if not row:
                row = await conn.fetchrow(
                    """
                    INSERT INTO trips (creator_id, name, location, start_date, end_date, notes)
                    VALUES ($1, $2, $3, $4, $5, $6)
                    RETURNING id
                    """,
                    cid,
                    t["name"],
                    t.get("location"),
                    t["start_date"],
                    t["end_date"],
                    t.get("notes"),
                )
                print(f"  Created trip: {t['name']} ({t['creator_email']})")
            else:
                print(f"  Skipped trip: {t['name']} ({t['creator_email']})")
            trip_db_ids[(t["creator_email"], t["name"])] = row["id"]

        for ec in EXTERNAL_COLLABORATIONS:
            cid = creator_db_ids.get(ec["creator_email"])
            trip_id = trip_db_ids.get((ec["creator_email"], ec["trip_name"]))
            if not cid:
                print(f"  Skipped external collab: creator {ec['creator_email']} not found")
                continue
            exists = await conn.fetchval(
                """
                SELECT 1 FROM external_collaborations
                WHERE creator_id = $1 AND title = $2 AND start_date = $3
                """,
                cid,
                ec["title"],
                ec["start_date"],
            )
            if exists:
                print(f"  Skipped external collab: {ec['title']}")
            else:
                await conn.execute(
                    """
                    INSERT INTO external_collaborations
                        (creator_id, trip_id, title, hotel_name, location,
                         collaboration_type, start_date, end_date, deliverables, notes)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                    """,
                    cid,
                    trip_id,
                    ec["title"],
                    ec.get("hotel_name"),
                    ec.get("location"),
                    ec.get("collaboration_type"),
                    ec["start_date"],
                    ec["end_date"],
                    ec.get("deliverables"),
                    ec.get("notes"),
                )
                print(f"  Created external collab: {ec['title']}")

        # ------------------------------------------------------------------
        #  Chat messages
        # ------------------------------------------------------------------
        print("\nSeeding chat messages...")
        all_collabs = await conn.fetch(
            """
            SELECT c.id, c.status, cr.user_id as creator_user_id, hp.user_id as hotel_user_id
            FROM collaborations c
            JOIN creators cr ON cr.id = c.creator_id
            JOIN hotel_profiles hp ON hp.id = c.hotel_id
            """
        )
        chat_count = 0
        for collab in all_collabs:
            cuid = collab["creator_user_id"]
            huid = collab["hotel_user_id"]
            msgs = []
            if collab["status"] == "negotiating":
                msgs = [
                    (cuid, "Hi! Can we adjust the check-in date to July 10th?", "text"),
                    (
                        None,
                        "Creator has suggested a counter-offer with updated terms: Check-in: 2024-07-10. Please review the new terms.",
                        "system",
                    ),
                    (huid, "Sure, that works for us! I've updated the terms on my end.", "text"),
                    (
                        None,
                        "Hotel has suggested a counter-offer - Deliverables updated. Please review.",
                        "system",
                    ),
                    (None, "Hotel approved the terms.", "system"),
                ]
            elif collab["status"] == "accepted":
                msgs = [
                    (cuid, "Looking forward to our stay!", "text"),
                    (huid, "We are excited to host you!", "text"),
                    (
                        None,
                        "Collaboration Accepted! Both parties have agreed to the terms.",
                        "system",
                    ),
                ]
            elif collab["status"] == "completed":
                msgs = [
                    (cuid, "I've just posted the content! Check it out.", "text"),
                    (huid, "This looks amazing! Thank you so much.", "text"),
                    (
                        None,
                        "Collaboration completed. All deliverables have been fulfilled.",
                        "system",
                    ),
                ]
            elif collab["status"] == "declined":
                msgs = [
                    (cuid, "Hi, I'm really interested in this collaboration.", "text"),
                    (
                        huid,
                        "Thank you for your interest. Unfortunately, we are fully booked for those dates.",
                        "text",
                    ),
                    (None, "Hotel has declined the collaboration request.", "system"),
                ]
            for sender, content, mtype in msgs:
                exists = await conn.fetchval(
                    """
                    SELECT 1 FROM chat_messages
                    WHERE collaboration_id = $1
                      AND (
                        (sender_id IS NULL AND $2::uuid IS NULL)
                        OR sender_id = $2::uuid
                      )
                      AND content = $3
                      AND message_type = $4
                    """,
                    collab["id"],
                    sender,
                    content,
                    mtype,
                )
                if not exists:
                    await conn.execute(
                        """
                        INSERT INTO chat_messages (collaboration_id, sender_id, content, message_type, created_at)
                        VALUES ($1, $2, $3, $4, now() - interval '1 day')
                        """,
                        collab["id"],
                        sender,
                        content,
                        mtype,
                    )
                    chat_count += 1
        print(f"  Created {chat_count} messages")

        # ------------------------------------------------------------------
        #  Reviews
        # ------------------------------------------------------------------
        print("\nSeeding reviews...")
        reviewable = await conn.fetch(
            """
            SELECT c.id, c.creator_id, c.hotel_id
            FROM collaborations c
            WHERE c.status IN ('completed', 'accepted')
            """
        )
        review_count = 0
        for i, rev in enumerate(REVIEWS):
            cid = creator_db_ids.get(rev["creator_email"])
            matching = [r for r in reviewable if r["creator_id"] == cid]
            if not matching:
                matching = reviewable
            if not matching:
                continue
            target = matching[i % len(matching)]
            exists = await conn.fetchval(
                "SELECT 1 FROM creator_ratings WHERE collaboration_id = $1", target["id"]
            )
            if exists:
                continue
            await conn.execute(
                """
                INSERT INTO creator_ratings (creator_id, hotel_id, collaboration_id, rating, comment, created_at, updated_at)
                VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
                """,
                target["creator_id"],
                target["hotel_id"],
                target["id"],
                rev["rating"],
                rev["comment"],
            )
            review_count += 1
        print(f"  Created {review_count} reviews")

        print("\nDone. Marketplace seeded.")
    finally:
        await conn.close()
        await auth_conn.close()


if __name__ == "__main__":
    asyncio.run(main())
