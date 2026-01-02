#!/usr/bin/env python3
"""
Add mock collaborations to the database
Creates collaborations between existing mock creators and hotels
"""
import asyncio
import asyncpg
import sys
import json
from pathlib import Path
from decimal import Decimal
from datetime import datetime, date

# Add parent directory to path to import app modules
sys.path.insert(0, str(Path(__file__).parent.parent))

from app.config import settings


async def add_collaborations():
    """Add mock collaborations between existing creators and hotels"""
    try:
        print("🔗 Connecting to database...")
        conn = await asyncpg.connect(settings.DATABASE_URL)
        print("✅ Connected to database\n")
        
        # Get all creator and listing IDs
        print("📋 Fetching creators and listings...")
        all_creators = await conn.fetch(
            """
            SELECT c.id, u.email 
            FROM creators c 
            JOIN users u ON u.id = c.user_id 
            WHERE u.email LIKE $1
            """,
            '%@mock.com'
        )
        all_listings = await conn.fetch(
            """
            SELECT hl.id, hl.name, hp.id as hotel_id, u.email as hotel_email
            FROM hotel_listings hl
            JOIN hotel_profiles hp ON hp.id = hl.hotel_profile_id
            JOIN users u ON u.id = hp.user_id
            WHERE u.email LIKE $1 AND hl.status = $2
            """,
            '%@mock.com', 'verified'
        )
        
        # Map creators and listings
        creator_map = {row['email']: row['id'] for row in all_creators}
        listing_map = {}
        for row in all_listings:
            key = (row['hotel_email'], row['name'])
            listing_map[key] = row
        
        print(f"   Found {len(creator_map)} creators")
        print(f"   Found {len(listing_map)} listings\n")
        
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
                "collaboration_type": "Paid",
                "paid_amount": Decimal("1500.00"),
                "travel_date_from": date(2024, 6, 1),
                "travel_date_to": date(2024, 6, 5),
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
                "travel_date_from": date(2024, 5, 15),
                "travel_date_to": date(2024, 5, 20),
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
                "travel_date_from": date(2024, 12, 20),
                "travel_date_to": date(2024, 12, 27),
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
                "collaboration_type": "Discount",
                "discount_percentage": 20,
                "travel_date_from": date(2024, 4, 10),
                "travel_date_to": date(2024, 4, 15),
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
                "preferred_date_from": date(2024, 2, 1),
                "preferred_date_to": date(2024, 2, 29),
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
                "preferred_date_from": date(2024, 3, 1),
                "preferred_date_to": date(2024, 5, 31),
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
                "preferred_date_from": date(2024, 9, 1),
                "preferred_date_to": date(2024, 11, 30),
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
                "preferred_date_from": date(2024, 4, 1),
                "preferred_date_to": date(2024, 6, 30),
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
                "preferred_date_from": date(2024, 4, 1),
                "preferred_date_to": date(2024, 8, 31),
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
            {
                "creator_email": "creator1@mock.com",
                "hotel_email": "hotel2@mock.com",
                "listing_name": "Alpine Chalet",
                "initiator_type": "hotel",
                "status": "accepted",
                "collaboration_type": "Paid",
                "paid_amount": Decimal("2500.00"),
                "preferred_date_from": date(2024, 5, 1),
                "preferred_date_to": date(2024, 7, 31),
                "platform_deliverables": [
                    {
                        "platform": "Instagram",
                        "deliverables": [
                            {"type": "Instagram Post", "quantity": 3},
                            {"type": "Instagram Stories", "quantity": 6}
                        ]
                    }
                ],
                "responded_at": datetime(2024, 1, 15, 11, 0, 0)
            },
        ]
        
        # Cleanup existing mock collaborations to ensure fresh data
        print("🧹 Cleaning up existing mock collaborations...")
        await conn.execute(
            """
            DELETE FROM collaborations 
            WHERE creator_id IN (
                SELECT c.id FROM creators c 
                JOIN users u ON u.id = c.user_id 
                WHERE u.email LIKE $1
            )
            """,
            '%@mock.com'
        )
        
        print("🤝 Creating collaboration requests...")
        collaboration_count = 0
        
        for collab_req in collaboration_requests:
            creator_id = creator_map.get(collab_req["creator_email"])
            if not creator_id:
                print(f"   ⚠️  Skipping collaboration: Creator {collab_req['creator_email']} not found")
                continue
            
            # Find listing by hotel email and listing name
            listing_key = (collab_req["hotel_email"], collab_req["listing_name"])
            listing = listing_map.get(listing_key)
            
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
        
        await conn.close()
        
        print(f"\n✨ Created {collaboration_count} collaborations")
        print("=" * 60)
        
    except Exception as e:
        print(f"❌ Error creating collaborations: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    print("🚀 Adding mock collaborations to database...")
    print()
    asyncio.run(add_collaborations())

