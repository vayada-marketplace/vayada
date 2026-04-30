"""
Collaboration routes for creators and hotels
"""
from fastapi import APIRouter, HTTPException, status, Depends, Query
from typing import List, Optional
from datetime import datetime
from app.database import Database
from app.dependencies import get_current_user_id, get_current_hotel_profile_id
from app.repositories.user_repo import UserRepository
from app.repositories.creator_repo import CreatorRepository
from app.repositories.hotel_repo import HotelRepository
from app.repositories.collaboration_repo import CollaborationRepository
import logging
import json
import uuid
from app.services.affiliate import AffiliateProvisioningService
from app.services.chat_system import create_system_message
from app.services.notifications import (
    get_party_email_and_name,
    send_email_background,
    notify_vayada_team,
    notify_marketplace_admin,
)
from app.email_service import (
    create_collaboration_request_email_html,
    create_collaboration_response_email_html,
    create_collaboration_counter_offer_email_html,
    create_collaboration_approved_email_html,
    create_collaboration_cancelled_email_html,
    create_admin_collaboration_request_email_html,
    create_admin_collaboration_response_email_html,
)
from app.models.collaborations import (
    PlatformDeliverable,
    PlatformDeliverablesItem,
    CreateCollaborationRequest,
    RespondToCollaborationRequest,
    UpdateCollaborationTermsRequest,
    CancelCollaborationRequest,
    CollaborationResponse,
    RateCollaborationRequest,
    RateCollaborationResponse,
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
    rows = await CollaborationRepository.get_deliverables(collaboration_id)
    
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
            user = await UserRepository.get_by_id(user_id, columns="id, type")

            if not user or user['type'] != 'creator':
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Only creators can create creator-initiated collaborations"
                )
            
            # Get creator profile
            creator = await CreatorRepository.get_by_user_id(user_id, columns="id")
            
            if not creator:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="Creator profile not found."
                )
            
            creator_id = str(creator['id'])
            
        elif request.initiator_type == "hotel":
            # Verify user is a hotel
            user = await UserRepository.get_by_id(user_id, columns="id, type")

            if not user or user['type'] != 'hotel':
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Only hotels can create hotel-initiated collaborations"
                )
            
            # Get hotel profile
            hotel_profile = await HotelRepository.get_profile_by_user_id(user_id, columns="id")
            
            if not hotel_profile:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="Hotel profile not found."
                )
            
            authenticated_hotel_id = str(hotel_profile['id'])
        
        # Verify listing exists
        listing = await CollaborationRepository.get_listing_with_hotel(request.listing_id)

        if not listing:
            raise HTTPException(status_code=404, detail="Listing not found")

        hotel_id = str(listing['hotel_profile_id'])

        if request.initiator_type == "hotel":
            creator_id = request.creator_id
            if str(listing['hotel_profile_id']) != authenticated_hotel_id:
                raise HTTPException(status_code=403, detail="Listing ownership mismatch")

        # Eligibility checks for creator-initiated applications
        if request.initiator_type == "creator":
            min_followers_required = listing.get('req_min_followers')
            if min_followers_required:
                total_followers_row = await Database.fetchrow(
                    "SELECT COALESCE(SUM(followers), 0) AS total FROM creator_platforms WHERE creator_id = $1",
                    creator_id,
                )
                creator_total_followers = int(total_followers_row['total']) if total_followers_row else 0
                if creator_total_followers < int(min_followers_required):
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail=(
                            f"This listing requires at least {int(min_followers_required):,} followers. "
                            f"You currently have {creator_total_followers:,}."
                        ),
                    )

            max_nights = listing.get('offering_free_stay_max_nights')
            if max_nights and request.travel_date_from and request.travel_date_to:
                requested_nights = (request.travel_date_to - request.travel_date_from).days
                if requested_nights > int(max_nights):
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail=(
                            f"This hotel offers a maximum of {int(max_nights)} nights for free stays. "
                            f"You requested {requested_nights} nights."
                        ),
                    )
        
        # Verify creator exists
        creator_record = await CreatorRepository.get_by_id(creator_id, columns="id, user_id, profile_picture")
        if not creator_record:
            raise HTTPException(status_code=404, detail="Creator not found")

        creator_user_info = await UserRepository.get_by_id(creator_record['user_id'], columns="name, status")
        
        
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
                        paid_amount, currency, discount_percentage,
                        travel_date_from, travel_date_to,
                        preferred_date_from, preferred_date_to,
                        preferred_months, consent, creator_fee
                    )
                    VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8, $9, COALESCE($10, 'USD'), $11, $12, $13, $14, $15, $16, $17, $18)
                    RETURNING *
                    """,
                    request.initiator_type, creator_id, hotel_id, request.listing_id,
                    request.why_great_fit, request.collaboration_type,
                    request.free_stay_min_nights, request.free_stay_max_nights,
                    request.paid_amount, request.currency, request.discount_percentage,
                    request.travel_date_from, request.travel_date_to,
                    request.preferred_date_from, request.preferred_date_to,
                    request.preferred_months, request.consent, request.creator_fee
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
        
        # Fetch contact info for both parties (used by recipient + admin notifications)
        creator_email_addr, creator_display_name = await get_party_email_and_name(
            "creator", creator_id=creator_id)
        hotel_email_addr, hotel_display_name = await get_party_email_and_name(
            "hotel", hotel_id=hotel_id)

        # Send email notification to the recipient
        if request.initiator_type == "creator":
            initiator_name = creator_user_info['name'] if creator_user_info else 'A creator'
            recipient_email, recipient_name = hotel_email_addr, hotel_display_name
        else:
            initiator_name = listing['hotel_name']
            recipient_email, recipient_name = creator_email_addr, creator_display_name

        if recipient_email:
            html = create_collaboration_request_email_html(
                recipient_name=recipient_name or "there",
                initiator_name=initiator_name,
                initiator_type=request.initiator_type,
                collaboration_type=request.collaboration_type,
                listing_name=listing['name'],
                listing_location=listing.get('location'),
                why_great_fit=request.why_great_fit,
            )
            send_email_background(recipient_email, "New Collaboration Request on vayada", html)
            notify_vayada_team("New Collaboration Request on vayada", html)

        admin_html = create_admin_collaboration_request_email_html(
            creator_name=creator_display_name or (creator_user_info['name'] if creator_user_info else 'Unknown'),
            creator_email=creator_email_addr,
            hotel_name=listing['hotel_name'],
            hotel_email=hotel_email_addr,
            listing_name=listing['name'],
            listing_location=listing.get('location'),
            collaboration_type=request.collaboration_type,
            initiator_type=request.initiator_type,
            why_great_fit=request.why_great_fit,
        )
        notify_marketplace_admin("New collaboration request", admin_html)

        joined_row = {
            **collaboration,
            'hotel_name': listing['hotel_name'],
            'listing_name': listing['name'],
            'listing_location': listing['location'],
            'creator_profile_picture': creator_record['profile_picture'],
        }
        return CollaborationResponse.from_db_row(
            joined_row,
            creator_name=creator_user_info['name'] if creator_user_info else 'Unknown',
            platform_deliverables=platform_deliverables_response,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating collaboration: {str(e)}")
        raise


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
        collab = await CollaborationRepository.get_by_id(collaboration_id)

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
            hotel_profile = await HotelRepository.get_profile_by_user_id(user_id, columns="id")
            if hotel_profile and str(hotel_profile['id']) == str(collab['hotel_id']):
                is_recipient = True
                recipient_role = "Hotel"
        elif collab['initiator_type'] == "hotel":
            # Initiated by hotel -> recipient is the creator
            creator_profile = await CreatorRepository.get_by_user_id(user_id, columns="id")
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
        updated = await CollaborationRepository.get_full(collaboration_id)

        # Fetch creator name
        creator_user = await UserRepository.get_by_id(updated['creator_user_id'], columns="name")
        creator_name = creator_user['name'] if creator_user else 'Unknown'

        # Send email to the initiator about the response
        if collab['initiator_type'] == "creator":
            initiator_email, initiator_name = await get_party_email_and_name(
                "creator", creator_id=str(collab['creator_id']))
            responder_name = updated['hotel_name']
        else:
            initiator_email, initiator_name = await get_party_email_and_name(
                "hotel", hotel_id=str(collab['hotel_id']))
            responder_name = creator_name

        if initiator_email:
            accepted = request.status == "accepted"
            html = create_collaboration_response_email_html(
                recipient_name=initiator_name or "there",
                responder_name=responder_name,
                accepted=accepted,
                collaboration_type=collab['collaboration_type'],
                listing_name=updated['listing_name'],
                listing_location=updated.get('listing_location'),
                response_message=request.response_message,
            )
            subject = "Collaboration Request Accepted" if accepted else "Collaboration Request Declined"
            send_email_background(initiator_email, subject, html)
            notify_vayada_team(subject, html)

        # Admin notification — only when the hotel is the responder (per ticket spec)
        if collab['initiator_type'] == "creator":
            accepted = request.status == "accepted"
            creator_email_addr = initiator_email
            creator_display_name = initiator_name
            hotel_email_addr, hotel_display_name = await get_party_email_and_name(
                "hotel", hotel_id=str(collab['hotel_id']))
            admin_html = create_admin_collaboration_response_email_html(
                creator_name=creator_display_name or creator_name,
                creator_email=creator_email_addr,
                hotel_name=hotel_display_name or updated['hotel_name'],
                hotel_email=hotel_email_addr,
                listing_name=updated['listing_name'],
                listing_location=updated.get('listing_location'),
                collaboration_type=collab['collaboration_type'],
                accepted=accepted,
                response_message=request.response_message,
            )
            admin_subject = (
                "Hotel accepted collaboration request"
                if accepted else "Hotel declined collaboration request"
            )
            notify_marketplace_admin(admin_subject, admin_html)

        plat_delivs_resp = await get_collaboration_deliverables(collaboration_id)
        return CollaborationResponse.from_db_row(
            updated,
            creator_name=creator_name,
            platform_deliverables=plat_delivs_resp,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error responding to collaboration: {str(e)}", exc_info=True)
        raise




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
        current_collab = await CollaborationRepository.get_by_id(collaboration_id)
        if not current_collab:
            raise HTTPException(status_code=404, detail="Collaboration not found")

        is_creator = False
        is_hotel = False
        sender_name = "User"

        creator_profile = await CreatorRepository.get_by_user_id(user_id, columns="id")
        if creator_profile and str(creator_profile['id']) == str(current_collab['creator_id']):
            is_creator = True
            sender_name = "Creator"

        if not is_creator:
            hotel_profile = await HotelRepository.get_profile_by_user_id(user_id, columns="id")
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

        if request.currency is not None:
            updates.append(f"currency = ${param_idx}")
            update_params.append(request.currency)
            param_idx += 1
            diff_summary.append(f"Currency: {request.currency}")

        if request.discount_percentage is not None:
            updates.append(f"discount_percentage = ${param_idx}")
            update_params.append(request.discount_percentage)
            param_idx += 1
            diff_summary.append(f"Discount: {request.discount_percentage}%")

        if request.creator_fee is not None:
            updates.append(f"creator_fee = ${param_idx}")
            update_params.append(request.creator_fee)
            param_idx += 1
            diff_summary.append(f"Creator Fee: {request.creator_fee}%")

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
        updated = await CollaborationRepository.get_full(collaboration_id)

        # Fetch creator name
        creator_user = await UserRepository.get_by_id(updated['creator_user_id'], columns="name")
        creator_name = creator_user['name'] if creator_user else 'Unknown'

        # Send email to the other party about the counter-offer
        if is_creator:
            other_email, other_name = await get_party_email_and_name(
                "hotel", hotel_id=str(current_collab['hotel_id']))
            sender_display = creator_name
        else:
            other_email, other_name = await get_party_email_and_name(
                "creator", creator_id=str(current_collab['creator_id']))
            sender_display = updated['hotel_name']

        if other_email and diff_summary:
            collab_type = request.collaboration_type or current_collab['collaboration_type']
            html = create_collaboration_counter_offer_email_html(
                recipient_name=other_name or "there",
                sender_name=sender_display,
                sender_role=sender_name,
                collaboration_type=collab_type,
                listing_name=updated['listing_name'],
                changes_summary=" | ".join(diff_summary),
                listing_location=updated.get('listing_location'),
            )
            send_email_background(other_email, "New Counter-Offer on Your Collaboration", html)

        plat_delivs_resp = await get_collaboration_deliverables(collaboration_id)
        return CollaborationResponse.from_db_row(
            updated,
            creator_name=creator_name,
            platform_deliverables=plat_delivs_resp,
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating terms: {str(e)}")
        raise


@router.post("/{collaboration_id}/approve", response_model=CollaborationResponse)
async def approve_collaboration_terms(
    collaboration_id: str,
    user_id: str = Depends(get_current_user_id)
):
    """
    Approve terms (Double Confirmation).
    """
    try:
        collab = await CollaborationRepository.get_by_id(collaboration_id)
        if not collab:
            raise HTTPException(status_code=404, detail="Collaboration not found")

        is_creator = False
        is_hotel = False
        sender_name = "User"

        creator_profile = await CreatorRepository.get_by_user_id(user_id, columns="id")
        if creator_profile and str(creator_profile['id']) == str(collab['creator_id']):
            is_creator = True
            sender_name = "Creator"

        if not is_creator:
            hotel_profile = await HotelRepository.get_profile_by_user_id(user_id, columns="id")
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
        updated = await CollaborationRepository.get_full(collaboration_id)

        # Fetch creator name
        creator_user = await UserRepository.get_by_id(updated['creator_user_id'], columns="name")
        creator_name = creator_user['name'] if creator_user else 'Unknown'

        # Send email notifications for approval
        creator_email, creator_email_name = await get_party_email_and_name(
            "creator", creator_id=str(collab['creator_id']))
        hotel_email, hotel_email_name = await get_party_email_and_name(
            "hotel", hotel_id=str(collab['hotel_id']))

        if new_status == 'accepted':
            affiliate_link = await AffiliateProvisioningService.provision_for_accepted_collab(
                collaboration_id,
                creator_id=str(collab['creator_id']),
                hotel_id=str(collab['hotel_id']),
                creator_email=creator_email,
                creator_name=creator_email_name,
                commission=collab.get('creator_fee'),
            )

            # Both approved — notify both parties
            for email, name in [(creator_email, creator_email_name), (hotel_email, hotel_email_name)]:
                if email:
                    # Only include affiliate link in creator's email
                    link_for_email = affiliate_link if email == creator_email else None
                    html = create_collaboration_approved_email_html(
                        recipient_name=name or "there",
                        other_party_name=sender_name,
                        collaboration_type=collab['collaboration_type'],
                        listing_name=updated['listing_name'],
                        listing_location=updated.get('listing_location'),
                        both_approved=True,
                        affiliate_link=link_for_email,
                    )
                    send_email_background(email, "Collaboration Confirmed!", html)
                notify_vayada_team("Collaboration Confirmed!", html)
        else:
            # Only one side approved — notify the other party to approve
            if is_creator:
                other_email, other_name = hotel_email, hotel_email_name
                approver_name = creator_name
            else:
                other_email, other_name = creator_email, creator_email_name
                approver_name = updated['hotel_name']

            if other_email:
                html = create_collaboration_approved_email_html(
                    recipient_name=other_name or "there",
                    other_party_name=approver_name,
                    collaboration_type=collab['collaboration_type'],
                    listing_name=updated['listing_name'],
                    listing_location=updated.get('listing_location'),
                    both_approved=False,
                )
                send_email_background(other_email, "Terms Approved — Your Confirmation Needed", html)

        plat_delivs_resp = await get_collaboration_deliverables(collaboration_id)

        # Re-fetch to include any affiliate fields written after acceptance
        if new_status == 'accepted':
            updated = await CollaborationRepository.get_full(collaboration_id)

        return CollaborationResponse.from_db_row(
            updated,
            creator_name=creator_name,
            platform_deliverables=plat_delivs_resp,
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error approving: {str(e)}")
        raise


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
        collab = await CollaborationRepository.get_by_id(collaboration_id)
        if not collab:
            raise HTTPException(status_code=404, detail="Collaboration not found")

        # Verify permissions
        creator_profile = await CreatorRepository.get_by_user_id(user_id, columns="id")
        is_creator = creator_profile and str(creator_profile['id']) == str(collab['creator_id'])

        hotel_profile = await HotelRepository.get_profile_by_user_id(user_id, columns="id")
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
        updated = await CollaborationRepository.get_full(collaboration_id)

        # Fetch creator name
        creator_user = await UserRepository.get_by_id(updated['creator_user_id'], columns="name")
        creator_name = creator_user['name'] if creator_user else 'Unknown'

        # Send email to the other party about the cancellation
        if is_creator:
            other_email, other_name = await get_party_email_and_name(
                "hotel", hotel_id=str(collab['hotel_id']))
            canceller_display = creator_name
        else:
            other_email, other_name = await get_party_email_and_name(
                "creator", creator_id=str(collab['creator_id']))
            canceller_display = updated['hotel_name']

        if other_email:
            html = create_collaboration_cancelled_email_html(
                recipient_name=other_name or "there",
                canceller_name=canceller_display,
                canceller_role=sender_name,
                collaboration_type=collab['collaboration_type'],
                listing_name=updated['listing_name'],
                listing_location=updated.get('listing_location'),
                reason=request.reason,
            )
            send_email_background(other_email, "Collaboration Cancelled", html)
            notify_vayada_team("Collaboration Cancelled", html)

        plat_delivs_resp = await get_collaboration_deliverables(collaboration_id)
        return CollaborationResponse.from_db_row(
            updated,
            creator_name=creator_name,
            platform_deliverables=plat_delivs_resp,
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error cancelling: {str(e)}")
        raise


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
        collab = await CollaborationRepository.get_by_id(collaboration_id)
        if not collab:
            raise HTTPException(status_code=404, detail="Collaboration not found")

        # Auth (simplified for restoration)
        creator_profile = await CreatorRepository.get_by_user_id(user_id, columns="id")
        is_creator = creator_profile and str(creator_profile['id']) == str(collab['creator_id'])
        hotel_profile = await HotelRepository.get_profile_by_user_id(user_id, columns="id")
        is_hotel = hotel_profile and str(hotel_profile['id']) == str(collab['hotel_id'])
        
        if not is_creator and not is_hotel:
            raise HTTPException(status_code=403, detail="Not authorized")
            
        # Toggle in the new table
        row = await CollaborationRepository.get_deliverable(deliverable_id, collaboration_id)

        if not row:
            raise HTTPException(status_code=404, detail="Deliverable not found")

        new_status = "completed" if row['status'] == "pending" else "pending"
        deliverable_name = row['type']

        await CollaborationRepository.update_deliverable_status(deliverable_id, new_status)
        

        status_text = "completed" if new_status == "completed" else "incomplete"
        await create_system_message(collaboration_id, f"{'✅' if new_status == 'completed' else '🔄'} Deliverable '{deliverable_name}' marked as {status_text}.")
        
        # Return Updated
        updated = await CollaborationRepository.get_full(collaboration_id)

        # Fetch creator name
        creator_user = await UserRepository.get_by_id(updated['creator_user_id'], columns="name")
        creator_name = creator_user['name'] if creator_user else 'Unknown'

        plat_delivs_resp = await get_collaboration_deliverables(collaboration_id)
        return CollaborationResponse.from_db_row(
            updated,
            creator_name=creator_name,
            platform_deliverables=plat_delivs_resp,
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error toggling: {str(e)}", exc_info=True)
        raise


@router.post("/{collaboration_id}/rate", response_model=RateCollaborationResponse)
async def rate_collaboration(
    collaboration_id: str,
    request: RateCollaborationRequest,
    user_id: str = Depends(get_current_user_id)
):
    """
    Rate a creator after completing a collaboration.
    Only hotels can rate collaborations they participated in.
    """
    try:
        # Verify user is a hotel
        user = await UserRepository.get_by_id(user_id, columns="id, type")

        if not user or user['type'] != 'hotel':
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Only hotels can rate collaborations"
            )

        # Get hotel profile
        hotel_profile = await HotelRepository.get_profile_by_user_id(user_id, columns="id")

        if not hotel_profile:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Hotel profile not found"
            )

        hotel_profile_id = str(hotel_profile['id'])

        # Fetch collaboration
        collab = await CollaborationRepository.get_by_id(collaboration_id)

        if not collab:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Collaboration not found"
            )

        # Verify the hotel is a participant in this collaboration
        if str(collab['hotel_id']) != hotel_profile_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Not authorized to rate this collaboration"
            )

        # Verify collaboration is completed
        if collab['status'] != 'completed':
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Collaboration is not completed"
            )

        # Check if already rated
        existing_rating = await CollaborationRepository.get_rating_by_collaboration(collaboration_id)

        if existing_rating:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="You have already rated this collaboration"
            )

        # Insert rating
        rating_row = await CollaborationRepository.create_rating(
            str(collab['creator_id']),
            hotel_profile_id,
            collaboration_id,
            request.rating,
            request.comment
        )

        return RateCollaborationResponse(
            message="Rating submitted successfully",
            rating_id=str(rating_row['id']),
            created_at=rating_row['created_at']
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error rating collaboration: {str(e)}", exc_info=True)
        raise
