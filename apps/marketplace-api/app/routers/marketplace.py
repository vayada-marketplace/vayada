"""
Marketplace routes for public browsing
"""
from fastapi import APIRouter, HTTPException, status, Query
from typing import List, Optional, Literal
from datetime import datetime
import logging
import json

from app.models.common import CollaborationOfferingResponse, CreatorRequirementsResponse
from app.models.marketplace import (
    ListingMarketplaceResponse,
    PlatformMarketplaceResponse,
    CreatorMarketplaceResponse,
)
from app.repositories.user_repo import UserRepository
from app.repositories.creator_repo import CreatorRepository
from app.repositories.hotel_repo import HotelRepository

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
        # Pre-fetch verified user IDs
        verified_users = await UserRepository.get_verified_users()
        verified_ids = [r['id'] for r in verified_users]

        if not verified_ids:
            return []

        # Get all listings from hotels with complete profiles whose user_id is verified
        listings_data = await HotelRepository.get_marketplace_listings(verified_ids)
        
        if not listings_data:
            return []
        
        # Get all listing IDs
        listing_ids = [str(l['id']) for l in listings_data]
        
        # Get all collaboration offerings for these listings
        offerings_data = await HotelRepository.get_offerings_for_listings(listing_ids)
        
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
        requirements_data = await HotelRepository.get_requirements_for_listings(listing_ids)

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
                creator_types=r['creator_types'],
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
async def get_all_creators(
    creator_type: Optional[List[Literal["Lifestyle", "Travel"]]] = Query(None, description="Filter by creator type(s)")
):
    """
    Get all creators for the marketplace page.
    Returns only creators with complete profiles (profile_complete = true) and verified status.
    Includes platforms, audience size, and ratings information.

    Optional filters:
    - creator_type: Filter by creator type(s) - can pass multiple values (e.g., ?creator_type=Lifestyle&creator_type=Travel)
    """
    try:
        # Pre-fetch verified user data
        verified_users = await UserRepository.get_verified_users(columns="id, name, status")
        verified_ids = [r['id'] for r in verified_users]
        users_map = {str(u['id']): u for u in verified_users}

        if not verified_ids:
            return []

        # Fetch creators with complete profiles whose user_id is verified
        creators_data = await CreatorRepository.get_complete_creators_by_user_ids(
            verified_ids, creator_type_filter=creator_type
        )

        if not creators_data:
            return []

        # Get all creator IDs
        creator_ids = [c['id'] for c in creators_data]
        
        # Get all platforms for these creators
        platforms_data = await CreatorRepository.get_platforms_for_creators(creator_ids)
        
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

            # Look up user name from AuthDatabase data
            user_info = users_map.get(str(creator['user_id']))
            user_name = user_info['name'] if user_info else ""

            response.append(CreatorMarketplaceResponse(
                id=creator_id_str,
                name=user_name,
                location=creator['location'] or "",
                short_description=creator['short_description'] or "",
                portfolio_link=creator['portfolio_link'],
                profile_picture=creator['profile_picture'],
                creator_type=creator['creator_type'] or 'Lifestyle',
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

