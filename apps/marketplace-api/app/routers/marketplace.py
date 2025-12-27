"""
Marketplace routes for public browsing
"""
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field, ConfigDict
from typing import List, Optional
from datetime import datetime
from decimal import Decimal
from app.database import Database
import logging

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/marketplace", tags=["marketplace"])


class CollaborationOfferingResponse(BaseModel):
    """Collaboration offering response model"""
    id: str
    listingId: str = Field(alias="listing_id")
    collaborationType: str = Field(alias="collaboration_type")
    availabilityMonths: List[str] = Field(alias="availability_months")
    platforms: List[str]
    freeStayMinNights: Optional[int] = Field(None, alias="free_stay_min_nights")
    freeStayMaxNights: Optional[int] = Field(None, alias="free_stay_max_nights")
    paidMaxAmount: Optional[Decimal] = Field(None, alias="paid_max_amount")
    discountPercentage: Optional[int] = Field(None, alias="discount_percentage")
    createdAt: datetime = Field(alias="created_at")
    updatedAt: datetime = Field(alias="updated_at")
    
    model_config = ConfigDict(populate_by_name=True, from_attributes=True)


class CreatorRequirementsResponse(BaseModel):
    """Creator requirements response model"""
    id: str
    listingId: str = Field(alias="listing_id")
    platforms: List[str]
    minFollowers: Optional[int] = Field(None, alias="min_followers")
    targetCountries: List[str] = Field(alias="target_countries")
    targetAgeMin: Optional[int] = Field(None, alias="target_age_min")
    targetAgeMax: Optional[int] = Field(None, alias="target_age_max")
    createdAt: datetime = Field(alias="created_at")
    updatedAt: datetime = Field(alias="updated_at")
    
    model_config = ConfigDict(populate_by_name=True, from_attributes=True)


class ListingMarketplaceResponse(BaseModel):
    """Listing response model for marketplace"""
    id: str
    hotelProfileId: str = Field(alias="hotel_profile_id")
    hotelName: str = Field(alias="hotel_name")
    hotelPicture: Optional[str] = Field(None, alias="hotel_picture")
    name: str
    location: str
    description: str
    accommodationType: Optional[str] = Field(None, alias="accommodation_type")
    images: List[str]
    status: str
    collaborationOfferings: List[CollaborationOfferingResponse] = Field(alias="collaboration_offerings")
    creatorRequirements: Optional[CreatorRequirementsResponse] = Field(None, alias="creator_requirements")
    createdAt: datetime = Field(alias="created_at")
    
    model_config = ConfigDict(populate_by_name=True, from_attributes=True)


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
                       target_age_min, target_age_max, created_at, updated_at
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

