"""
Collaboration routes for creators and hotels
"""
from fastapi import APIRouter, HTTPException, status, Depends, Query
from typing import List, Optional
from datetime import datetime
from app.database import Database
from app.dependencies import get_current_user_id, get_current_hotel_profile_id
import logging
import json
import uuid
from .chat import create_system_message
from app.models.collaborations import (
    PlatformDeliverable,
    PlatformDeliverablesItem,
    CreateCollaborationRequest,
    RespondToCollaborationRequest,
    UpdateCollaborationTermsRequest,
    CancelCollaborationRequest,
    CollaborationResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/collaborations", tags=["collaborations"])


# ============================================
# HELPER FUNCTIONS
# ============================================

async def get_collaboration_deliverables(collaboration_id: str) -> List[PlatformDeliverablesItem]:
    """
    Fetch deliverables for a collaboration from the collaboration_deliverables table
    and format them into the PlatformDeliverablesItem structure.
    """
    rows = await Database.fetch(
        """
        SELECT id, platform, type, quantity, status
        FROM collaboration_deliverables
        WHERE collaboration_id = $1
        ORDER BY platform, type
        """,
        collaboration_id
    )
    
    if not rows:
        return []
        
    # Group by platform
    platform_map = {}
    for row in rows:
        platform = row['platform']
        if platform not in platform_map:
            platform_map[platform] = []
            
        platform_map[platform].append(PlatformDeliverable(
            id=str(row['id']),
            type=row['type'],
            quantity=row['quantity'],
            status=row['status']
        ))
        
    return [
        PlatformDeliverablesItem(platform=platform, deliverables=deliverables)
        for platform, deliverables in platform_map.items()
    ]


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
                        preferred_months, consent
                    )
                    VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
                    RETURNING *
                    """,
                    request.initiator_type, creator_id, hotel_id, request.listing_id,
                    request.why_great_fit, request.collaboration_type,
                    request.free_stay_min_nights, request.free_stay_max_nights,
                    request.paid_amount, request.discount_percentage,
                    request.travel_date_from, request.travel_date_to,
                    request.preferred_date_from, request.preferred_date_to,
                    request.preferred_months, request.consent
                )
                
                collaboration_id = collaboration['id']
                
                # Insert deliverables into the new table
                for platform_item in request.platform_deliverables:
                    for d in platform_item.deliverables:
                        await conn.execute(
                            """
                            INSERT INTO collaboration_deliverables (
                                collaboration_id, platform, type, quantity, status
                            ) VALUES ($1, $2, $3, $4, $5)
                            """,
                            collaboration_id,
                            platform_item.platform,
                            d.type,
                            d.quantity,
                            d.status
                        )
        
        # Fetch deliverables from the new table for the response
        platform_deliverables_response = await get_collaboration_deliverables(str(collaboration['id']))
        
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
        
        plat_delivs_resp = await get_collaboration_deliverables(collaboration_id)
        
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
        
        if request.collaboration_type:
            updates.append(f"collaboration_type = ${param_idx}")
            update_params.append(request.collaboration_type)
            param_idx += 1
            diff_summary.append(f"Type: {request.collaboration_type}")
            
            # Nullify fields of other types when type changes
            if request.collaboration_type == "Free Stay":
                updates.append("paid_amount = NULL")
                updates.append("discount_percentage = NULL")
            elif request.collaboration_type == "Paid":
                updates.append("free_stay_min_nights = NULL")
                updates.append("free_stay_max_nights = NULL")
                updates.append("discount_percentage = NULL")
            elif request.collaboration_type == "Discount":
                updates.append("free_stay_min_nights = NULL")
                updates.append("free_stay_max_nights = NULL")
                updates.append("paid_amount = NULL")

        # Handle nights consistency
        target_min = request.free_stay_min_nights
        target_max = request.free_stay_max_nights
        
        if request.stay_nights is not None:
            target_min = request.stay_nights
            target_max = request.stay_nights
            
        # If switching to Free Stay or already in it, ensure both min/max are set if one is provided
        is_now_free_stay = (request.collaboration_type == "Free Stay") or \
                          (not request.collaboration_type and current_collab['collaboration_type'] == "Free Stay")
                          
        if is_now_free_stay:
            if target_min is not None and target_max is None and current_collab['free_stay_max_nights'] is None:
                target_max = target_min
            elif target_max is not None and target_min is None and current_collab['free_stay_min_nights'] is None:
                target_min = target_max

        if target_min is not None:
            updates.append(f"free_stay_min_nights = ${param_idx}")
            update_params.append(target_min)
            param_idx += 1
            diff_summary.append(f"Min Nights: {target_min}")

        if target_max is not None:
            updates.append(f"free_stay_max_nights = ${param_idx}")
            update_params.append(target_max)
            param_idx += 1
            # Only add to summary if it's different from min or we didn't add stay_nights summary
            if target_max != target_min:
                diff_summary.append(f"Max Nights: {target_max}")
            elif request.stay_nights is not None:
                # If we used stay_nights, we already have a nice summary "Nights: X" logic below? 
                # Actually let's just use stay_nights if provided
                pass

        if request.stay_nights is not None:
            # Re-summarize if we used the convenience field
            diff_summary = [s for s in diff_summary if not s.startswith("Min Nights") and not s.startswith("Max Nights")]
            diff_summary.append(f"Nights: {request.stay_nights}")

        if request.paid_amount is not None:
            updates.append(f"paid_amount = ${param_idx}")
            update_params.append(request.paid_amount)
            param_idx += 1
            diff_summary.append(f"Amount: {request.paid_amount}")

        if request.discount_percentage is not None:
            updates.append(f"discount_percentage = ${param_idx}")
            update_params.append(request.discount_percentage)
            param_idx += 1
            diff_summary.append(f"Discount: {request.discount_percentage}%")

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
            # We'll handle deliverables update inside the transaction below
            diff_summary.append("Deliverables updated")
            
        if not updates and not request.platform_deliverables:
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
                
                # Update deliverables if provided
                if request.platform_deliverables:
                    # Delete old deliverables
                    await conn.execute(
                        "DELETE FROM collaboration_deliverables WHERE collaboration_id = $1",
                        collaboration_id
                    )
                    # Insert new ones
                    for platform_item in request.platform_deliverables:
                        for d in platform_item.deliverables:
                            await conn.execute(
                                """
                                INSERT INTO collaboration_deliverables (
                                    collaboration_id, platform, type, quantity, status
                                ) VALUES ($1, $2, $3, $4, $5)
                                """,
                                collaboration_id,
                                platform_item.platform,
                                d.type,
                                d.quantity,
                                "pending" # Reset to pending during negotiation
                            )

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
        
        plat_delivs_resp = await get_collaboration_deliverables(collaboration_id)

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
            stay_nights=updated['free_stay_min_nights'] if updated['free_stay_min_nights'] == updated['free_stay_max_nights'] else None,
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
        
        plat_delivs_resp = await get_collaboration_deliverables(collaboration_id)
        
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
        logger.error(f"Error approving: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/{collaboration_id}/cancel", response_model=CollaborationResponse)
async def cancel_collaboration(
    collaboration_id: str,
    request: CancelCollaborationRequest,
    user_id: str = Depends(get_current_user_id)
):
    """
    Withdraw or cancel a collaboration.
    Can be performed by either party at any stage before completion.
    """
    try:
        collab = await Database.fetchrow("SELECT * FROM collaborations WHERE id = $1", collaboration_id)
        if not collab:
            raise HTTPException(status_code=404, detail="Collaboration not found")
            
        # Verify permissions
        creator_profile = await Database.fetchrow("SELECT id FROM creators WHERE user_id = $1", user_id)
        is_creator = creator_profile and str(creator_profile['id']) == str(collab['creator_id'])
        
        hotel_profile = await Database.fetchrow("SELECT id FROM hotel_profiles WHERE user_id = $1", user_id)
        is_hotel = hotel_profile and str(hotel_profile['id']) == str(collab['hotel_id'])
        
        if not is_creator and not is_hotel:
            raise HTTPException(status_code=403, detail="Not authorized to cancel this collaboration")
            
        # Verify status
        if collab['status'] in ['completed', 'cancelled', 'declined']:
            raise HTTPException(status_code=400, detail=f"Cannot cancel collaboration with status '{collab['status']}'")
            
        sender_name = "Creator" if is_creator else "Hotel"
        
        # Update
        updates = [
            "status = 'cancelled'",
            "cancelled_at = NOW()",
            "updated_at = NOW()"
        ]
        
        pool = await Database.get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute(f"UPDATE collaborations SET {', '.join(updates)} WHERE id = $1", collaboration_id)
                
                msg = f"🚫 {sender_name} has cancelled the collaboration."
                if request.reason:
                    msg += f"\\n\\nReason: {request.reason}"
                await create_system_message(collaboration_id, msg, conn=conn)

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
        
        plat_delivs_resp = await get_collaboration_deliverables(collaboration_id)
        
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
        logger.error(f"Error cancelling: {str(e)}")
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
            
        # Toggle in the new table
        row = await Database.fetchrow(
            "SELECT type, status FROM collaboration_deliverables WHERE id = $1 AND collaboration_id = $2",
            deliverable_id, collaboration_id
        )
        
        if not row:
            raise HTTPException(status_code=404, detail="Deliverable not found")
            
        new_status = "completed" if row['status'] == "pending" else "pending"
        deliverable_name = row['type']
        
        await Database.execute(
            "UPDATE collaboration_deliverables SET status = $1, updated_at = NOW() WHERE id = $2",
            new_status, deliverable_id
        )
        

        status_text = "completed" if new_status == "completed" else "incomplete"
        await create_system_message(collaboration_id, f"{'✅' if new_status == 'completed' else '🔄'} Deliverable '{deliverable_name}' marked as {status_text}.")
        
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
        
        plat_delivs_resp = await get_collaboration_deliverables(collaboration_id)
        
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
