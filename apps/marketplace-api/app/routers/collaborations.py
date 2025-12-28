"""
Collaboration routes for creators and hotels
"""
from fastapi import APIRouter, HTTPException, status, Depends, Query
from pydantic import BaseModel, Field, field_validator, model_validator, ConfigDict
from typing import List, Optional, Literal
from datetime import datetime, date
from decimal import Decimal
from app.database import Database
from app.dependencies import get_current_user_id, get_current_hotel_profile_id
import logging
import json

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/collaborations", tags=["collaborations"])


# ============================================
# REQUEST MODELS
# ============================================

class PlatformDeliverable(BaseModel):
    """Individual deliverable item"""
    type: str = Field(..., description="Deliverable type (e.g., 'Instagram Post', 'Instagram Stories')")
    quantity: int = Field(..., gt=0, description="Number of deliverables of this type")
    
    model_config = ConfigDict(populate_by_name=True)


class PlatformDeliverablesItem(BaseModel):
    """Platform with its deliverables"""
    platform: Literal["Instagram", "TikTok", "YouTube", "Facebook"] = Field(
        ..., 
        description="Social media platform"
    )
    deliverables: List[PlatformDeliverable] = Field(
        ..., 
        min_length=1, 
        description="List of deliverables for this platform"
    )
    
    model_config = ConfigDict(populate_by_name=True)


class CreateCollaborationRequest(BaseModel):
    """Request model for creating a collaboration (supports both creator and hotel initiators)"""
    initiator_type: Literal["creator", "hotel"] = Field(
        ..., 
        description="Who is initiating the collaboration"
    )
    
    # Common required fields
    listing_id: str = Field(..., description="Hotel listing ID")
    creator_id: Optional[str] = Field(
        None,
        description="Creator ID. For creator-initiated: optional (will be auto-filled from authenticated user). For hotel-initiated: required, must be the ID of the creator being invited."
    )
    platform_deliverables: List[PlatformDeliverablesItem] = Field(
        ..., 
        min_length=1, 
        description="Platform deliverables commitment"
    )
    
    # Creator-specific fields
    why_great_fit: Optional[str] = Field(
        None, 
        max_length=500, 
        description="Why the creator is a good fit (required for creator applications)"
    )
    travel_date_from: Optional[date] = Field(
        None, 
        description="Proposed check-in date for creator applications"
    )
    travel_date_to: Optional[date] = Field(
        None, 
        description="Proposed check-out date for creator applications"
    )
    preferred_months: Optional[List[str]] = Field(
        None, 
        description="Preferred months (month abbreviations like ['Jan', 'Feb'])"
    )
    consent: Optional[bool] = Field(
        None, 
        description="Consent flag (required and must be true for creator applications)"
    )
    
    # Hotel-specific fields
    collaboration_type: Optional[Literal["Free Stay", "Paid", "Discount"]] = Field(
        None, 
        description="Type of collaboration (required for hotel invitations)"
    )
    free_stay_min_nights: Optional[int] = Field(
        None, 
        gt=0, 
        description="Minimum nights for Free Stay (required if collaboration_type is 'Free Stay')"
    )
    free_stay_max_nights: Optional[int] = Field(
        None, 
        gt=0, 
        description="Maximum nights for Free Stay (required if collaboration_type is 'Free Stay')"
    )
    paid_amount: Optional[Decimal] = Field(
        None, 
        gt=0, 
        description="Payment amount for Paid collaboration (required if collaboration_type is 'Paid')"
    )
    discount_percentage: Optional[int] = Field(
        None, 
        ge=1, 
        le=100, 
        description="Discount percentage for Discount collaboration (required if collaboration_type is 'Discount')"
    )
    preferred_date_from: Optional[date] = Field(
        None, 
        description="Preferred start date for hotel invitations"
    )
    preferred_date_to: Optional[date] = Field(
        None, 
        description="Preferred end date for hotel invitations"
    )
    
    @model_validator(mode='after')
    def validate_by_initiator_type(self):
        """Validate fields based on initiator_type"""
        if self.initiator_type == "creator":
            # Creator-specific validations
            if not self.why_great_fit:
                raise ValueError("why_great_fit is required for creator applications")
            if self.consent is not True:
                raise ValueError("consent must be true for creator applications")
            # Either dates or months should be provided (both optional but recommended)
            if not self.travel_date_from and not self.preferred_months:
                # This is a warning, not an error - but we'll allow it
                pass
        elif self.initiator_type == "hotel":
            # Hotel-specific validations
            if not self.creator_id:
                raise ValueError("creator_id is required for hotel invitations")
            if not self.collaboration_type:
                raise ValueError("collaboration_type is required for hotel invitations")
            
            # Validate type-specific fields
            if self.collaboration_type == "Free Stay":
                if not self.free_stay_min_nights or not self.free_stay_max_nights:
                    raise ValueError("free_stay_min_nights and free_stay_max_nights are required for Free Stay collaboration")
                if self.free_stay_max_nights < self.free_stay_min_nights:
                    raise ValueError("free_stay_max_nights must be >= free_stay_min_nights")
            elif self.collaboration_type == "Paid":
                if not self.paid_amount or self.paid_amount <= 0:
                    raise ValueError("paid_amount is required and must be > 0 for Paid collaboration")
            elif self.collaboration_type == "Discount":
                if not self.discount_percentage or not (1 <= self.discount_percentage <= 100):
                    raise ValueError("discount_percentage must be between 1-100 for Discount collaboration")
            
            # Either dates or months should be provided (both optional but recommended)
            if not self.preferred_date_from and not self.preferred_months:
                # This is a warning, not an error - but we'll allow it
                pass
        
        # Validate date ranges if provided
        if self.travel_date_from and self.travel_date_to:
            if self.travel_date_to < self.travel_date_from:
                raise ValueError("travel_date_to must be >= travel_date_from")
        
        if self.preferred_date_from and self.preferred_date_to:
            if self.preferred_date_to < self.preferred_date_from:
                raise ValueError("preferred_date_to must be >= preferred_date_from")
        
        return self
    
    model_config = ConfigDict(populate_by_name=True)


class RespondToCollaborationRequest(BaseModel):
    """Request model for responding to a collaboration (accept/decline)"""
    status: Literal["accepted", "declined"] = Field(
        ..., 
        description="Response status"
    )
    response_message: Optional[str] = Field(
        None, 
        description="Optional message when responding"
    )
    
    model_config = ConfigDict(populate_by_name=True)


# ============================================
# RESPONSE MODELS
# ============================================

class CollaborationResponse(BaseModel):
    """Response model for collaboration data"""
    id: str
    initiator_type: str
    status: str
    creator_id: str
    creator_name: str
    creator_profile_picture: Optional[str] = None
    hotel_id: str
    hotel_name: str
    listing_id: str
    listing_name: str
    listing_location: str
    
    # Collaboration terms
    collaboration_type: Optional[str] = None
    free_stay_min_nights: Optional[int] = None
    free_stay_max_nights: Optional[int] = None
    paid_amount: Optional[Decimal] = None
    discount_percentage: Optional[int] = None
    
    # Dates
    travel_date_from: Optional[date] = None
    travel_date_to: Optional[date] = None
    preferred_date_from: Optional[date] = None
    preferred_date_to: Optional[date] = None
    preferred_months: Optional[List[str]] = None
    
    # Communication
    why_great_fit: Optional[str] = None
    
    # Deliverables
    platform_deliverables: List[PlatformDeliverablesItem]
    
    # Consent
    consent: Optional[bool] = None
    
    # Timestamps
    created_at: datetime
    updated_at: datetime
    responded_at: Optional[datetime] = None
    cancelled_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    
    model_config = ConfigDict(populate_by_name=True, from_attributes=True)


# ============================================
# ENDPOINTS
# ============================================

@router.post("", response_model=CollaborationResponse, status_code=status.HTTP_201_CREATED)
async def create_collaboration(
    request: CreateCollaborationRequest,
    user_id: str = Depends(get_current_user_id)
):
    """
    Create a new collaboration application or invitation.
    
    Supports two flows:
    1. Creator → Hotel: Creator applies for a collaboration with a hotel listing
    2. Hotel → Creator: Hotel invites a creator for a collaboration
    
    The initiator_type field determines which validation rules apply.
    """
    try:
        # Validate based on initiator_type
        if request.initiator_type == "creator":
            # Verify creator_id matches authenticated user
            user = await Database.fetchrow(
                "SELECT id, type FROM users WHERE id = $1",
                user_id
            )
            
            if not user:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="User not found"
                )
            
            if user['type'] != 'creator':
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Only creators can create creator-initiated collaborations"
                )
            
            # Get creator profile
            creator = await Database.fetchrow(
                "SELECT id FROM creators WHERE user_id = $1",
                user_id
            )
            
            if not creator:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="Creator profile not found. Please complete your profile first."
                )
            
            # For creator-initiated collaborations, automatically use authenticated creator's ID
            # Ignore creator_id in request (if provided, it should match, but we'll use authenticated one)
            creator_id = str(creator['id'])
            
            # Optional: Warn if request.creator_id was provided and doesn't match (but don't fail)
            if request.creator_id and str(creator['id']) != request.creator_id:
                logger.warning(f"creator_id in request ({request.creator_id}) doesn't match authenticated creator ({creator_id}), using authenticated creator_id")
            
        elif request.initiator_type == "hotel":
            # Verify user is a hotel
            user = await Database.fetchrow(
                "SELECT id, type FROM users WHERE id = $1",
                user_id
            )
            
            if not user:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="User not found"
                )
            
            if user['type'] != 'hotel':
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Only hotels can create hotel-initiated collaborations"
                )
            
            # Get hotel profile
            hotel_profile = await Database.fetchrow(
                "SELECT id FROM hotel_profiles WHERE user_id = $1",
                user_id
            )
            
            if not hotel_profile:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="Hotel profile not found. Please create your profile first."
                )
            
            authenticated_hotel_id = str(hotel_profile['id'])
        
        # Verify listing exists and get hotel_id from it
        listing = await Database.fetchrow(
            """
            SELECT hl.id, hl.hotel_profile_id, hl.name, hl.location, hl.status,
                   hp.name as hotel_name
            FROM hotel_listings hl
            JOIN hotel_profiles hp ON hp.id = hl.hotel_profile_id
            WHERE hl.id = $1
            """,
            request.listing_id
        )
        
        if not listing:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Listing not found"
            )
        
        # If hotel-initiated, verify listing belongs to authenticated hotel
        if request.initiator_type == "hotel":
            if str(listing['hotel_profile_id']) != authenticated_hotel_id:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Listing does not belong to the authenticated hotel"
                )
        
        # Verify listing is verified (optional - you might want to allow pending listings)
        # if listing['status'] != 'verified':
        #     raise HTTPException(
        #         status_code=status.HTTP_400_BAD_REQUEST,
        #         detail="Listing must be verified to accept collaborations"
        #     )
        
        hotel_id = str(listing['hotel_profile_id'])
        
        # For hotel-initiated, get creator_id from request
        # For creator-initiated, creator_id was already set above
        if request.initiator_type == "hotel":
            creator_id = request.creator_id
        
        # Verify creator exists and is verified
        creator_user = await Database.fetchrow(
            """
            SELECT c.id, u.status, u.name, c.profile_picture
            FROM creators c
            JOIN users u ON u.id = c.user_id
            WHERE c.id = $1
            """,
            creator_id
        )
        
        if not creator_user:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Creator not found"
            )
        
        # Optional: Check if creator is verified
        # if creator_user['status'] != 'verified':
        #     raise HTTPException(
        #         status_code=status.HTTP_400_BAD_REQUEST,
        #         detail="Creator must be verified to receive collaborations"
        #     )
        
        # Check for duplicate active collaboration
        existing = await Database.fetchrow(
            """
            SELECT id FROM collaborations
            WHERE listing_id = $1 
            AND creator_id = $2 
            AND status IN ('pending', 'accepted')
            """,
            request.listing_id,
            creator_id
        )
        
        if existing:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="An active collaboration already exists between this creator and listing"
            )
        
        # Prepare platform_deliverables as JSONB
        platform_deliverables_json = json.dumps([
            {
                "platform": item.platform,
                "deliverables": [
                    {"type": d.type, "quantity": d.quantity}
                    for d in item.deliverables
                ]
            }
            for item in request.platform_deliverables
        ])
        
        # Create collaboration in transaction
        pool = await Database.get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                collaboration = await conn.fetchrow(
                    """
                    INSERT INTO collaborations (
                        initiator_type, creator_id, hotel_id, listing_id, status,
                        why_great_fit, collaboration_type,
                        free_stay_min_nights, free_stay_max_nights,
                        paid_amount, discount_percentage,
                        travel_date_from, travel_date_to,
                        preferred_date_from, preferred_date_to,
                        preferred_months, platform_deliverables, consent
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
                    RETURNING id, initiator_type, status, creator_id, hotel_id, listing_id,
                              why_great_fit, collaboration_type,
                              free_stay_min_nights, free_stay_max_nights,
                              paid_amount, discount_percentage,
                              travel_date_from, travel_date_to,
                              preferred_date_from, preferred_date_to,
                              preferred_months, platform_deliverables, consent,
                              created_at, updated_at, responded_at, cancelled_at, completed_at
                    """,
                    request.initiator_type,
                    creator_id,
                    hotel_id,
                    request.listing_id,
                    'pending',
                    request.why_great_fit,
                    request.collaboration_type,
                    request.free_stay_min_nights,
                    request.free_stay_max_nights,
                    request.paid_amount,
                    request.discount_percentage,
                    request.travel_date_from,
                    request.travel_date_to,
                    request.preferred_date_from,
                    request.preferred_date_to,
                    request.preferred_months,
                    platform_deliverables_json,
                    request.consent
                )
        
        # Parse platform_deliverables back to model
        platform_deliverables_data = json.loads(collaboration['platform_deliverables'])
        platform_deliverables_response = [
            PlatformDeliverablesItem(
                platform=item['platform'],
                deliverables=[
                    PlatformDeliverable(type=d['type'], quantity=d['quantity'])
                    for d in item['deliverables']
                ]
            )
            for item in platform_deliverables_data
        ]
        
        # Build response with related data
        return CollaborationResponse(
            id=str(collaboration['id']),
            initiator_type=collaboration['initiator_type'],
            status=collaboration['status'],
            creator_id=str(collaboration['creator_id']),
            creator_name=creator_user['name'],
            creator_profile_picture=creator_user.get('profile_picture'),
            hotel_id=str(collaboration['hotel_id']),
            hotel_name=listing['hotel_name'],
            listing_id=str(collaboration['listing_id']),
            listing_name=listing['name'],
            listing_location=listing['location'],
            collaboration_type=collaboration['collaboration_type'],
            free_stay_min_nights=collaboration['free_stay_min_nights'],
            free_stay_max_nights=collaboration['free_stay_max_nights'],
            paid_amount=collaboration['paid_amount'],
            discount_percentage=collaboration['discount_percentage'],
            travel_date_from=collaboration['travel_date_from'],
            travel_date_to=collaboration['travel_date_to'],
            preferred_date_from=collaboration['preferred_date_from'],
            preferred_date_to=collaboration['preferred_date_to'],
            preferred_months=collaboration['preferred_months'],
            why_great_fit=collaboration['why_great_fit'],
            platform_deliverables=platform_deliverables_response,
            consent=collaboration['consent'],
            created_at=collaboration['created_at'],
            updated_at=collaboration['updated_at'],
            responded_at=collaboration['responded_at'],
            cancelled_at=collaboration['cancelled_at'],
            completed_at=collaboration['completed_at']
        )
        
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        logger.error(f"Error creating collaboration: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to create collaboration: {str(e)}"
        )

