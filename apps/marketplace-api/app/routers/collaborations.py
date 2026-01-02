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
import uuid
from .chat import create_system_message

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/collaborations", tags=["collaborations"])


# ============================================
# REQUEST MODELS
# ============================================

class PlatformDeliverable(BaseModel):
    """Individual deliverable item"""
    id: Optional[str] = Field(None, description="Unique ID for the deliverable")
    type: str = Field(..., description="Deliverable type (e.g., 'Instagram Post', 'Instagram Stories')")
    quantity: int = Field(..., gt=0, description="Number of deliverables of this type")
    completed: bool = Field(default=False, description="Whether the deliverable has been completed")
    completed_at: Optional[datetime] = Field(None, description="When the deliverable was completed")
    
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


class UpdateCollaborationTermsRequest(BaseModel):
    """Request model for suggesting changes (Negotiation)"""
    travel_date_from: Optional[date] = None
    travel_date_to: Optional[date] = None
    platform_deliverables: Optional[List[PlatformDeliverablesItem]] = None
    
    # Validation logic to ensure at least one field is provided
    @model_validator(mode='after')
    def check_at_least_one_update(self):
        if not self.travel_date_from and not self.travel_date_to and not self.platform_deliverables:
            raise ValueError("At least one term (dates or deliverables) must be updated")
        return self
        
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
    
    # Negotiation
    hotel_agreed_at: Optional[datetime] = None
    creator_agreed_at: Optional[datetime] = None
    term_last_updated_at: Optional[datetime] = None
    
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
    """
    try:
        # Validate based on initiator_type
        if request.initiator_type == "creator":
            # Verify creator_id matches authenticated user
            user = await Database.fetchrow(
                "SELECT id, type FROM users WHERE id = $1",
                user_id
            )
            
            if not user or user['type'] != 'creator':
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
                    detail="Creator profile not found."
                )
            
            creator_id = str(creator['id'])
            
        elif request.initiator_type == "hotel":
            # Verify user is a hotel
            user = await Database.fetchrow(
                "SELECT id, type FROM users WHERE id = $1",
                user_id
            )
            
            if not user or user['type'] != 'hotel':
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
                    detail="Hotel profile not found."
                )
            
            authenticated_hotel_id = str(hotel_profile['id'])
        
        # Verify listing exists
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
            raise HTTPException(status_code=404, detail="Listing not found")
        
        hotel_id = str(listing['hotel_profile_id'])
        
        if request.initiator_type == "hotel":
            creator_id = request.creator_id
            if str(listing['hotel_profile_id']) != authenticated_hotel_id:
                raise HTTPException(status_code=403, detail="Listing ownership mismatch")
        
        # Verify creator exists
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
            raise HTTPException(status_code=404, detail="Creator not found")
        
        # Prepare platform_deliverables as JSONB
        platform_deliverables_json = json.dumps([
            {
                "platform": item.platform,
                "deliverables": [
                    {
                        "id": d.id or str(uuid.uuid4()),
                        "type": d.type, 
                        "quantity": d.quantity,
                        "completed": d.completed,
                        "completed_at": d.completed_at.isoformat() if d.completed_at else None
                    }
                    for d in item.deliverables
                ]
            }
            for item in request.platform_deliverables
        ])
        
        # Create collaboration
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
                    VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
                    RETURNING *
                    """,
                    request.initiator_type, creator_id, hotel_id, request.listing_id,
                    request.why_great_fit, request.collaboration_type,
                    request.free_stay_min_nights, request.free_stay_max_nights,
                    request.paid_amount, request.discount_percentage,
                    request.travel_date_from, request.travel_date_to,
                    request.preferred_date_from, request.preferred_date_to,
                    request.preferred_months, platform_deliverables_json, request.consent
                )
        
        # Parse platform_deliverables back
        platform_deliverables_data = json.loads(collaboration['platform_deliverables'])
        platform_deliverables_response = [
            PlatformDeliverablesItem(
                platform=item['platform'],
                deliverables=[PlatformDeliverable(**d) for d in item['deliverables']]
            )
            for item in platform_deliverables_data
        ]
        
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
        
    except Exception as e:
        logger.error(f"Error creating collaboration: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/{collaboration_id}/respond", response_model=CollaborationResponse)
async def respond_to_collaboration_request(
    collaboration_id: str,
    request: RespondToCollaborationRequest,
    user_id: str = Depends(get_current_user_id)
):
    """
    Accept or decline a collaboration request (initial invitation or application).
    
    When accepting:
    - Status changes from 'pending' to 'negotiating'
    - Chat becomes available for both parties to discuss and bargain terms
    - Use the /approve endpoint to finalize and mark as 'accepted' when both parties agree
    
    When declining:
    - Status changes to 'declined'
    - Collaboration is closed
    """
    try:
        # Fetch collaboration
        collab = await Database.fetchrow(
            "SELECT * FROM collaborations WHERE id = $1",
            collaboration_id
        )
        
        if not collab:
            raise HTTPException(status_code=404, detail="Collaboration not found")
            
        if collab['status'] != 'pending':
            raise HTTPException(
                status_code=400, 
                detail=f"Cannot respond to collaboration with status '{collab['status']}'. Only 'pending' requests can be accepted/declined."
            )

        # Determine if the user is the recipient
        is_recipient = False
        recipient_role = ""
        
        if collab['initiator_type'] == "creator":
            # Initiated by creator -> recipient is the hotel
            hotel_profile = await Database.fetchrow(
                "SELECT id FROM hotel_profiles WHERE user_id = $1",
                user_id
            )
            if hotel_profile and str(hotel_profile['id']) == str(collab['hotel_id']):
                is_recipient = True
                recipient_role = "Hotel"
        elif collab['initiator_type'] == "hotel":
            # Initiated by hotel -> recipient is the creator
            creator_profile = await Database.fetchrow(
                "SELECT id FROM creators WHERE user_id = $1",
                user_id
            )
            if creator_profile and str(creator_profile['id']) == str(collab['creator_id']):
                is_recipient = True
                recipient_role = "Creator"
        
        if not is_recipient:
            raise HTTPException(status_code=403, detail="Not authorized to respond to this collaboration request")

        # Update status
        # When accepting, move to 'negotiating' status to enable chat for bargaining
        # Only the /approve endpoint should mark as 'accepted' when both parties agree
        if request.status == "accepted":
            new_status = "negotiating"
        else:
            new_status = request.status
            
        updates = [
            "status = $1",
            "responded_at = NOW()",
            "updated_at = NOW()"
        ]
        params = [new_status, collaboration_id]
        
        if request.status == "accepted":
            # Mark that the recipient agreed to start negotiating
            if recipient_role == "Hotel":
                updates.append("hotel_agreed_at = NOW()")
            else:
                updates.append("creator_agreed_at = NOW()")
        
        query = f"UPDATE collaborations SET {', '.join(updates)} WHERE id = ${len(params)} RETURNING *"
        
        pool = await Database.get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute(query, *params)
                
                # Create system messages
                if request.status == "accepted":
                    # Accepting means ready to negotiate
                    msg = f"✅ {recipient_role} is ready to discuss the collaboration terms."
                    if request.response_message:
                        msg += f"\n\nMessage: {request.response_message}"
                    await create_system_message(collaboration_id, msg, conn=conn)
                    await create_system_message(collaboration_id, "💬 Chat is now open! Discuss and finalize the terms.", conn=conn)
                else:
                    # Declined
                    msg = f"❌ {recipient_role} has declined the collaboration request."
                    if request.response_message:
                        msg += f"\n\nMessage: {request.response_message}"
                    await create_system_message(collaboration_id, msg, conn=conn)

        # Fetch full data for response
        updated = await Database.fetchrow(
            """
            SELECT c.*, cr_user.name as creator_name, cr.profile_picture as creator_profile_picture,
                   hp.name as hotel_name, hl.name as listing_name, hl.location as listing_location
            FROM collaborations c
            JOIN creators cr ON cr.id = c.creator_id
            JOIN users cr_user ON cr_user.id = cr.user_id
            JOIN hotel_profiles hp ON hp.id = c.hotel_id
            JOIN hotel_listings hl ON hl.id = c.listing_id
            WHERE c.id = $1
            """,
            collaboration_id
        )
        
        plat_delivs = json.loads(updated['platform_deliverables'])
        plat_delivs_resp = [
            PlatformDeliverablesItem(
                platform=item['platform'],
                deliverables=[PlatformDeliverable(**d) for d in item['deliverables']]
            ) for item in plat_delivs
        ]
        
        return CollaborationResponse(
            id=str(updated['id']),
            initiator_type=updated['initiator_type'],
            status=updated['status'],
            creator_id=str(updated['creator_id']),
            creator_name=updated['creator_name'],
            creator_profile_picture=updated['creator_profile_picture'],
            hotel_id=str(updated['hotel_id']),
            hotel_name=updated['hotel_name'],
            listing_id=str(updated['listing_id']),
            listing_name=updated['listing_name'],
            listing_location=updated['listing_location'],
            collaboration_type=updated['collaboration_type'],
            free_stay_min_nights=updated['free_stay_min_nights'],
            free_stay_max_nights=updated['free_stay_max_nights'],
            paid_amount=updated['paid_amount'],
            discount_percentage=updated['discount_percentage'],
            travel_date_from=updated['travel_date_from'],
            travel_date_to=updated['travel_date_to'],
            preferred_date_from=updated['preferred_date_from'],
            preferred_date_to=updated['preferred_date_to'],
            preferred_months=updated['preferred_months'],
            why_great_fit=updated['why_great_fit'],
            platform_deliverables=plat_delivs_resp,
            consent=updated['consent'],
            created_at=updated['created_at'],
            updated_at=updated['updated_at'],
            responded_at=updated['responded_at'],
            cancelled_at=updated['cancelled_at'],
            completed_at=updated['completed_at'],
            hotel_agreed_at=updated['hotel_agreed_at'],
            creator_agreed_at=updated['creator_agreed_at'],
            term_last_updated_at=updated['term_last_updated_at']
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error responding to collaboration: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))




@router.put("/{collaboration_id}/terms", response_model=CollaborationResponse)
async def update_collaboration_terms(
    collaboration_id: str,
    request: UpdateCollaborationTermsRequest,
    user_id: str = Depends(get_current_user_id)
):
    """
    Suggest changes to the terms (Negotiation).
    """
    try:
        current_collab = await Database.fetchrow("SELECT * FROM collaborations WHERE id = $1", collaboration_id)
        if not current_collab:
            raise HTTPException(status_code=404, detail="Collaboration not found")
            
        is_creator = False
        is_hotel = False
        sender_name = "User"
        
        creator_profile = await Database.fetchrow("SELECT id FROM creators WHERE user_id = $1", user_id)
        if creator_profile and str(creator_profile['id']) == str(current_collab['creator_id']):
            is_creator = True
            sender_name = "Creator"
            
        if not is_creator:
            hotel_profile = await Database.fetchrow("SELECT id FROM hotel_profiles WHERE user_id = $1", user_id)
            if hotel_profile and str(hotel_profile['id']) == str(current_collab['hotel_id']):
                is_hotel = True
                sender_name = "Hotel"
        
        if not is_creator and not is_hotel:
            raise HTTPException(status_code=403, detail="Not authorized")
            
        updates = []
        update_params = []
        param_idx = 2
        diff_summary = []
        
        if request.travel_date_from:
            updates.append(f"travel_date_from = ${param_idx}")
            update_params.append(request.travel_date_from)
            param_idx += 1
            diff_summary.append(f"Check-in: {request.travel_date_from}")
            
        if request.travel_date_to:
            updates.append(f"travel_date_to = ${param_idx}")
            update_params.append(request.travel_date_to)
            param_idx += 1
            diff_summary.append(f"Check-out: {request.travel_date_to}")
            
        if request.platform_deliverables:
            deliverables_json = json.dumps([
                {
                    "platform": item.platform,
                    "deliverables": [
                        {
                            "id": d.id or str(uuid.uuid4()),
                            "type": d.type, 
                            "quantity": d.quantity,
                            "completed": False,  # Reset status during negotiation
                            "completed_at": None # Reset timestamp during negotiation
                        } 
                        for d in item.deliverables
                    ]
                }
                for item in request.platform_deliverables
            ])
            updates.append(f"platform_deliverables = ${param_idx}")
            update_params.append(deliverables_json)
            param_idx += 1
            diff_summary.append("Deliverables updated")
            
        if not updates:
             raise HTTPException(status_code=400, detail="No changes provided")

        updates.append("status = 'negotiating'")
        updates.append("term_last_updated_at = now()")
        updates.append("updated_at = now()")
        
        if is_hotel:
            updates.append("hotel_agreed_at = NOW()")
            updates.append("creator_agreed_at = NULL")
        else:
            updates.append("creator_agreed_at = NOW()")
            updates.append("hotel_agreed_at = NULL")
        
        update_query = f"UPDATE collaborations SET {', '.join(updates)} WHERE id = $1"
        update_params.insert(0, collaboration_id)
        
        pool = await Database.get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute(update_query, *update_params)
                sys_msg = f"📝 {sender_name} has suggested a counter-offer: " + " • ".join(diff_summary)
                await create_system_message(collaboration_id, sys_msg, conn=conn)

        # Return updated
        updated = await Database.fetchrow(
            """
            SELECT c.*, cr_user.name as creator_name, cr.profile_picture as creator_profile_picture,
                   hp.name as hotel_name, hl.name as listing_name, hl.location as listing_location
            FROM collaborations c
            JOIN creators cr ON cr.id = c.creator_id
            JOIN users cr_user ON cr_user.id = cr.user_id
            JOIN hotel_profiles hp ON hp.id = c.hotel_id
            JOIN hotel_listings hl ON hl.id = c.listing_id
            WHERE c.id = $1
            """,
            collaboration_id
        )
        
        plat_delivs = json.loads(updated['platform_deliverables'])
        plat_delivs_resp = [
            PlatformDeliverablesItem(
                platform=item['platform'],
                deliverables=[PlatformDeliverable(**d) for d in item['deliverables']]
            ) for item in plat_delivs
        ]

        return CollaborationResponse(
            id=str(updated['id']),
            initiator_type=updated['initiator_type'],
            status=updated['status'],
            creator_id=str(updated['creator_id']),
            creator_name=updated['creator_name'],
            creator_profile_picture=updated['creator_profile_picture'],
            hotel_id=str(updated['hotel_id']),
            hotel_name=updated['hotel_name'],
            listing_id=str(updated['listing_id']),
            listing_name=updated['listing_name'],
            listing_location=updated['listing_location'],
            collaboration_type=updated['collaboration_type'],
            free_stay_min_nights=updated['free_stay_min_nights'],
            free_stay_max_nights=updated['free_stay_max_nights'],
            paid_amount=updated['paid_amount'],
            discount_percentage=updated['discount_percentage'],
            travel_date_from=updated['travel_date_from'],
            travel_date_to=updated['travel_date_to'],
            preferred_date_from=updated['preferred_date_from'],
            preferred_date_to=updated['preferred_date_to'],
            preferred_months=updated['preferred_months'],
            why_great_fit=updated['why_great_fit'],
            platform_deliverables=plat_delivs_resp,
            consent=updated['consent'],
            created_at=updated['created_at'],
            updated_at=updated['updated_at'],
            responded_at=updated['responded_at'],
            cancelled_at=updated['cancelled_at'],
            completed_at=updated['completed_at'],
            hotel_agreed_at=updated['hotel_agreed_at'],
            creator_agreed_at=updated['creator_agreed_at'],
            term_last_updated_at=updated['term_last_updated_at']
        )
    except Exception as e:
        logger.error(f"Error updating terms: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/{collaboration_id}/approve", response_model=CollaborationResponse)
async def approve_collaboration_terms(
    collaboration_id: str,
    user_id: str = Depends(get_current_user_id)
):
    """
    Approve terms (Double Confirmation).
    """
    try:
        collab = await Database.fetchrow("SELECT * FROM collaborations WHERE id = $1", collaboration_id)
        if not collab:
            raise HTTPException(status_code=404, detail="Collaboration not found")
            
        is_creator = False
        is_hotel = False
        sender_name = "User"
        
        creator_profile = await Database.fetchrow("SELECT id FROM creators WHERE user_id = $1", user_id)
        if creator_profile and str(creator_profile['id']) == str(collab['creator_id']):
            is_creator = True
            sender_name = "Creator"
            
        if not is_creator:
            hotel_profile = await Database.fetchrow("SELECT id FROM hotel_profiles WHERE user_id = $1", user_id)
            if hotel_profile and str(hotel_profile['id']) == str(collab['hotel_id']):
                is_hotel = True
                sender_name = "Hotel"
                
        if not is_creator and not is_hotel:
            raise HTTPException(status_code=403, detail="Not authorized")

        updates = []
        if is_creator:
            updates.append("creator_agreed_at = NOW()")
            other_agreed = collab['hotel_agreed_at'] is not None
        else:
            updates.append("hotel_agreed_at = NOW()")
            other_agreed = collab['creator_agreed_at'] is not None
            
        new_status = None
        if other_agreed:
            updates.append("status = 'accepted'")
            updates.append("responded_at = NOW()")
            new_status = 'accepted'
        
        query = f"UPDATE collaborations SET {', '.join(updates)} WHERE id = $1"
        pool = await Database.get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute(query, collaboration_id)
                await create_system_message(collaboration_id, f"✅ {sender_name} approved the terms.", conn=conn)
                if new_status == 'accepted':
                    await create_system_message(collaboration_id, "🎉 Collaboration Accepted!", conn=conn)

        # Return Updated
        updated = await Database.fetchrow(
            """
            SELECT c.*, cr_user.name as creator_name, cr.profile_picture as creator_profile_picture,
                   hp.name as hotel_name, hl.name as listing_name, hl.location as listing_location
            FROM collaborations c
            JOIN creators cr ON cr.id = c.creator_id
            JOIN users cr_user ON cr_user.id = cr.user_id
            JOIN hotel_profiles hp ON hp.id = c.hotel_id
            JOIN hotel_listings hl ON hl.id = c.listing_id
            WHERE c.id = $1
            """,
            collaboration_id
        )
        
        plat_delivs = json.loads(updated['platform_deliverables'])
        plat_delivs_resp = [
            PlatformDeliverablesItem(
                platform=item['platform'],
                deliverables=[PlatformDeliverable(**d) for d in item['deliverables']]
            ) for item in plat_delivs
        ]
        
        return CollaborationResponse(
            id=str(updated['id']),
            initiator_type=updated['initiator_type'],
            status=updated['status'],
            creator_id=str(updated['creator_id']),
            creator_name=updated['creator_name'],
            creator_profile_picture=updated['creator_profile_picture'],
            hotel_id=str(updated['hotel_id']),
            hotel_name=updated['hotel_name'],
            listing_id=str(updated['listing_id']),
            listing_name=updated['listing_name'],
            listing_location=updated['listing_location'],
            collaboration_type=updated['collaboration_type'],
            free_stay_min_nights=updated['free_stay_min_nights'],
            free_stay_max_nights=updated['free_stay_max_nights'],
            paid_amount=updated['paid_amount'],
            discount_percentage=updated['discount_percentage'],
            travel_date_from=updated['travel_date_from'],
            travel_date_to=updated['travel_date_to'],
            preferred_date_from=updated['preferred_date_from'],
            preferred_date_to=updated['preferred_date_to'],
            preferred_months=updated['preferred_months'],
            why_great_fit=updated['why_great_fit'],
            platform_deliverables=plat_delivs_resp,
            consent=updated['consent'],
            created_at=updated['created_at'],
            updated_at=updated['updated_at'],
            responded_at=updated['responded_at'],
            cancelled_at=updated['cancelled_at'],
            completed_at=updated['completed_at'],
            hotel_agreed_at=updated['hotel_agreed_at'],
            creator_agreed_at=updated['creator_agreed_at'],
            term_last_updated_at=updated['term_last_updated_at']
        )
    except Exception as e:
        logger.error(f"Error approving: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/{collaboration_id}/deliverables/{deliverable_id}/toggle", response_model=CollaborationResponse)
async def toggle_deliverable(
    collaboration_id: str,
    deliverable_id: str,
    user_id: str = Depends(get_current_user_id)
):
    """
    Toggle completion status of a deliverable.
    """
    try:
        collab = await Database.fetchrow("SELECT * FROM collaborations WHERE id = $1", collaboration_id)
        if not collab:
            raise HTTPException(status_code=404, detail="Collaboration not found")
            
        # Auth (simplified for restoration)
        creator_profile = await Database.fetchrow("SELECT id FROM creators WHERE user_id = $1", user_id)
        is_creator = creator_profile and str(creator_profile['id']) == str(collab['creator_id'])
        hotel_profile = await Database.fetchrow("SELECT id FROM hotel_profiles WHERE user_id = $1", user_id)
        is_hotel = hotel_profile and str(hotel_profile['id']) == str(collab['hotel_id'])
        
        if not is_creator and not is_hotel:
            raise HTTPException(status_code=403, detail="Not authorized")
            
        platform_deliverables = json.loads(collab['platform_deliverables'])
        found = False
        new_status = False
        deliverable_name = ""
        
        for platform_item in platform_deliverables:
            for d in platform_item['deliverables']:
                if d.get('id') == deliverable_id:
                    d['completed'] = not d.get('completed', False)
                    new_status = d['completed']
                    d['completed_at'] = datetime.now().isoformat() if d['completed'] else None
                    deliverable_name = d['type']
                    found = True
                    break
            if found: break
            
        if not found:
            raise HTTPException(status_code=404, detail="Deliverable not found")
            
        await Database.execute(
            "UPDATE collaborations SET platform_deliverables = $1, updated_at = NOW() WHERE id = $2",
            json.dumps(platform_deliverables), collaboration_id
        )
        
        status_text = "completed" if new_status else "incomplete"
        await create_system_message(collaboration_id, f"{'✅' if new_status else '🔄'} Deliverable '{deliverable_name}' marked as {status_text}.")
        
        # Return Updated
        updated = await Database.fetchrow(
            """
            SELECT c.*, cr_user.name as creator_name, cr.profile_picture as creator_profile_picture,
                   hp.name as hotel_name, hl.name as listing_name, hl.location as listing_location
            FROM collaborations c
            JOIN creators cr ON cr.id = c.creator_id
            JOIN users cr_user ON cr_user.id = cr.user_id
            JOIN hotel_profiles hp ON hp.id = c.hotel_id
            JOIN hotel_listings hl ON hl.id = c.listing_id
            WHERE c.id = $1
            """,
            collaboration_id
        )
        
        plat_delivs = json.loads(updated['platform_deliverables'])
        plat_delivs_resp = [
            PlatformDeliverablesItem(
                platform=item['platform'],
                deliverables=[PlatformDeliverable(**d) for d in item['deliverables']]
            ) for item in plat_delivs
        ]
        
        return CollaborationResponse(
            id=str(updated['id']),
            initiator_type=updated['initiator_type'],
            status=updated['status'],
            creator_id=str(updated['creator_id']),
            creator_name=updated['creator_name'],
            creator_profile_picture=updated['creator_profile_picture'],
            hotel_id=str(updated['hotel_id']),
            hotel_name=updated['hotel_name'],
            listing_id=str(updated['listing_id']),
            listing_name=updated['listing_name'],
            listing_location=updated['listing_location'],
            collaboration_type=updated['collaboration_type'],
            free_stay_min_nights=updated['free_stay_min_nights'],
            free_stay_max_nights=updated['free_stay_max_nights'],
            paid_amount=updated['paid_amount'],
            discount_percentage=updated['discount_percentage'],
            travel_date_from=updated['travel_date_from'],
            travel_date_to=updated['travel_date_to'],
            preferred_date_from=updated['preferred_date_from'],
            preferred_date_to=updated['preferred_date_to'],
            preferred_months=updated['preferred_months'],
            why_great_fit=updated['why_great_fit'],
            platform_deliverables=plat_delivs_resp,
            consent=updated['consent'],
            created_at=updated['created_at'],
            updated_at=updated['updated_at'],
            responded_at=updated['responded_at'],
            cancelled_at=updated['cancelled_at'],
            completed_at=updated['completed_at'],
            hotel_agreed_at=updated['hotel_agreed_at'],
            creator_agreed_at=updated['creator_agreed_at'],
            term_last_updated_at=updated['term_last_updated_at']
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error toggling: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
