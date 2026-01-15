"""
Marketplace routes for public browsing
"""
from fastapi import APIRouter, HTTPException, status
from typing import List, Optional
from datetime import datetime
from app.database import Database
import logging
import json

from app.models.common import CollaborationOfferingResponse, CreatorRequirementsResponse
from app.models.marketplace import (
    ListingMarketplaceResponse,
    PlatformMarketplaceResponse,
    CreatorMarketplaceResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/marketplace", tags=["marketplace"])


@router.get("/listings", response_model=List[ListingMarketplaceResponse])
async def get_all_listings():
    """
    Get all hotel listings for the marketplace page.
    Returns only listings from hotels with complete profiles (profile_complete = true) and verified status.
    Includes hotel information, listing details, and collaboration offerings.
    """
    try:
        # Get all listings from verified hotels with complete profiles
        listings_data = await Database.fetch(
            """
            SELECT 
                hl.id,
                hl.hotel_profile_id,
                hl.name,
                hl.location,
                hl.description,
                hl.accommodation_type,
                hl.images,
                hl.status,
                hl.created_at,
                hp.name as hotel_name,
                hp.picture as hotel_picture
            FROM hotel_listings hl
            JOIN hotel_profiles hp ON hp.id = hl.hotel_profile_id
            JOIN users u ON u.id = hp.user_id
            WHERE hp.profile_complete = true
            AND u.status = 'verified'
            ORDER BY hl.created_at DESC
            """
        )
        
        if not listings_data:
            return []
        
        # Get all listing IDs
        listing_ids = [str(l['id']) for l in listings_data]
        
        # Get all collaboration offerings for these listings
        if listing_ids:
            placeholders = ','.join([f'${i+1}' for i in range(len(listing_ids))])
            offerings_query = f"""
                SELECT id, listing_id, collaboration_type, availability_months, platforms,
                       free_stay_min_nights, free_stay_max_nights, paid_max_amount, discount_percentage,
                       created_at, updated_at
                FROM listing_collaboration_offerings
                WHERE listing_id IN ({placeholders})
                ORDER BY listing_id, created_at DESC
            """
            offerings_data = await Database.fetch(offerings_query, *listing_ids)
        else:
            offerings_data = []
        
        # Create a map of listing_id -> offerings
        offerings_map = {}
        for o in offerings_data:
            listing_id_str = str(o['listing_id'])
            if listing_id_str not in offerings_map:
                offerings_map[listing_id_str] = []
            
            offerings_map[listing_id_str].append(CollaborationOfferingResponse(
                id=str(o['id']),
                listing_id=listing_id_str,
                collaboration_type=o['collaboration_type'],
                availability_months=o['availability_months'],
                platforms=o['platforms'],
                free_stay_min_nights=o['free_stay_min_nights'],
                free_stay_max_nights=o['free_stay_max_nights'],
                paid_max_amount=o['paid_max_amount'],
                discount_percentage=o['discount_percentage'],
                created_at=o['created_at'],
                updated_at=o['updated_at']
            ))
        
        # Get creator requirements for these listings
        if listing_ids:
            placeholders = ','.join([f'${i+1}' for i in range(len(listing_ids))])
            requirements_query = f"""
                SELECT id, listing_id, platforms, min_followers, target_countries,
                       target_age_min, target_age_max, target_age_groups, created_at, updated_at
                FROM listing_creator_requirements
                WHERE listing_id IN ({placeholders})
            """
            requirements_data = await Database.fetch(requirements_query, *listing_ids)
        else:
            requirements_data = []
        
        # Create a map of listing_id -> requirements
        requirements_map = {}
        for r in requirements_data:
            listing_id_str = str(r['listing_id'])
            requirements_map[listing_id_str] = CreatorRequirementsResponse(
                id=str(r['id']),
                listing_id=listing_id_str,
                platforms=r['platforms'],
                min_followers=r['min_followers'],
                target_countries=r['target_countries'],
                target_age_min=r['target_age_min'],
                target_age_max=r['target_age_max'],
                target_age_groups=r['target_age_groups'],
                created_at=r['created_at'],
                updated_at=r['updated_at']
            )
        
        # Build response
        response = []
        for listing in listings_data:
            listing_id_str = str(listing['id'])
            offerings = offerings_map.get(listing_id_str, [])
            requirements = requirements_map.get(listing_id_str)
            
            response.append(ListingMarketplaceResponse(
                id=listing_id_str,
                hotel_profile_id=str(listing['hotel_profile_id']),
                hotel_name=listing['hotel_name'],
                hotel_picture=listing['hotel_picture'],
                name=listing['name'],
                location=listing['location'],
                description=listing['description'],
                accommodation_type=listing['accommodation_type'],
                images=listing['images'] or [],
                status=listing['status'],
                collaboration_offerings=offerings,
                creator_requirements=requirements,
                created_at=listing['created_at']
            ))
        
        return response
        
    except Exception as e:
        logger.error(f"Error fetching listings for marketplace: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to fetch listings: {str(e)}"
        )


@router.get("/creators", response_model=List[CreatorMarketplaceResponse])
async def get_all_creators():
    """
    Get all creators for the marketplace page.
    Returns only creators with complete profiles (profile_complete = true) and verified status.
    Includes platforms, audience size, and ratings information.
    """
    try:
        # Get all creators with complete profiles, platforms, and ratings in one query
        creators_data = await Database.fetch(
            """
            SELECT 
                c.id,
                c.location,
                c.short_description,
                c.portfolio_link,
                c.profile_picture,
                c.created_at,
                u.name,
                u.status,
                COALESCE(rating_stats.average_rating, 0.0) as average_rating,
                COALESCE(rating_stats.total_reviews, 0) as total_reviews
            FROM creators c
            JOIN users u ON u.id = c.user_id
            LEFT JOIN (
                SELECT 
                    creator_id,
                    AVG(rating)::float as average_rating,
                    COUNT(*)::int as total_reviews
                FROM creator_ratings
                GROUP BY creator_id
            ) rating_stats ON rating_stats.creator_id = c.id
            WHERE c.profile_complete = true
            AND u.status = 'verified'
            ORDER BY c.created_at DESC
            """
        )
        
        if not creators_data:
            return []
        
        # Get all creator IDs
        creator_ids = [c['id'] for c in creators_data]
        
        # Get all platforms for these creators
        if creator_ids:
            placeholders = ','.join([f'${i+1}' for i in range(len(creator_ids))])
            platforms_query = f"""
                SELECT id, creator_id, name, handle, followers, engagement_rate,
                       top_countries, top_age_groups, gender_split
                FROM creator_platforms
                WHERE creator_id IN ({placeholders})
                ORDER BY creator_id, name
            """
            platforms_data = await Database.fetch(platforms_query, *creator_ids)
        else:
            platforms_data = []
        
        # Create a map of creator_id -> platforms
        platforms_map = {}
        for p in platforms_data:
            creator_id_str = str(p['creator_id'])
            if creator_id_str not in platforms_map:
                platforms_map[creator_id_str] = []
            
            # Parse JSON data and convert dict to list format if needed
            top_countries = None
            if p['top_countries']:
                parsed = json.loads(p['top_countries'])
                # Convert dict to list format: [{"country": "USA", "percentage": 45}, ...]
                if isinstance(parsed, dict):
                    top_countries = [{"country": k, "percentage": v} for k, v in parsed.items()]
                else:
                    top_countries = parsed
            
            top_age_groups = None
            if p['top_age_groups']:
                parsed = json.loads(p['top_age_groups'])
                # Convert dict to list format: [{"ageRange": "25-34", "percentage": 40}, ...]
                if isinstance(parsed, dict):
                    top_age_groups = [{"ageRange": k, "percentage": v} for k, v in parsed.items()]
                else:
                    top_age_groups = parsed
            
            gender_split = json.loads(p['gender_split']) if p['gender_split'] else None
            
            platforms_map[creator_id_str].append(PlatformMarketplaceResponse(
                id=str(p['id']),
                name=p['name'],
                handle=p['handle'],
                followers=p['followers'],
                engagement_rate=float(p['engagement_rate']),
                top_countries=top_countries,
                top_age_groups=top_age_groups,
                gender_split=gender_split
            ))
        
        # Build response
        response = []
        for creator in creators_data:
            creator_id_str = str(creator['id'])
            platforms = platforms_map.get(creator_id_str, [])
            audience_size = sum(p.followers for p in platforms)
            
            response.append(CreatorMarketplaceResponse(
                id=creator_id_str,
                name=creator['name'],
                location=creator['location'] or "",
                short_description=creator['short_description'] or "",
                portfolio_link=creator['portfolio_link'],
                profile_picture=creator['profile_picture'],
                platforms=platforms,
                audience_size=audience_size,
                average_rating=round(float(creator['average_rating']), 2),
                total_reviews=creator['total_reviews'],
                created_at=creator['created_at']
            ))
        
        return response
        
    except Exception as e:
        logger.error(f"Error fetching creators for marketplace: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to fetch creators: {str(e)}"
        )

