"""
Admin collaboration-monitoring endpoints + admin-side respond/approve.
"""
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, status as http_status, Depends, Query

from app.database import Database, AuthDatabase
from app.dependencies import get_admin_user
from app.routers.collaborations import get_collaboration_deliverables
from app.services.affiliate import AffiliateProvisioningService
from app.services.chat_system import create_system_message
from app.services.notifications import (
    get_party_email_and_name,
    send_email_background,
    notify_vayada_team,
)
from app.email_service import (
    create_collaboration_response_email_html,
    create_collaboration_approved_email_html,
)
from app.repositories.user_repo import UserRepository
from app.repositories.collaboration_repo import CollaborationRepository

from app.models.collaborations import CollaborationResponse, RespondToCollaborationRequest
from app.models.admin import CollaborationListResponse

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get(
    "/collaborations",
    response_model=CollaborationListResponse,
    status_code=http_status.HTTP_200_OK,
)
async def get_admin_collaborations(
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int = Query(20, ge=1, le=100, description="Items per page"),
    status: Optional[str] = Query(None, description="Filter by status"),
    search: Optional[str] = Query(None, description="Search by creator name or hotel name"),
    admin_id: str = Depends(get_admin_user)
):
    """Get all collaborations for admin monitoring."""
    try:
        search_user_ids = None
        if search:
            search_users = await AuthDatabase.fetch(
                "SELECT id FROM users WHERE name ILIKE $1",
                f"%{search}%"
            )
            search_user_ids = [r['id'] for r in search_users]

        where_conditions = []
        params = []
        param_counter = 1

        if status:
            where_conditions.append(f"c.status = ${param_counter}")
            params.append(status)
            param_counter += 1

        if search:
            if search_user_ids:
                where_conditions.append(f"(hp.name ILIKE ${param_counter} OR cr.user_id = ANY(${param_counter + 1}::uuid[]))")
                params.append(f"%{search}%")
                params.append(search_user_ids)
                param_counter += 2
            else:
                where_conditions.append(f"hp.name ILIKE ${param_counter}")
                params.append(f"%{search}%")
                param_counter += 1

        where_clause = " AND ".join(where_conditions) if where_conditions else "1=1"

        count_query = f"""
            SELECT COUNT(*) as total
            FROM collaborations c
            JOIN creators cr ON cr.id = c.creator_id
            JOIN hotel_profiles hp ON hp.id = c.hotel_id
            WHERE {where_clause}
        """
        total_result = await Database.fetchrow(count_query, *params)
        total = total_result['total'] if total_result else 0

        offset = (page - 1) * page_size
        limit_param = param_counter
        offset_param = param_counter + 1

        data_query = f"""
            SELECT c.*,
                   cr.profile_picture as creator_profile_picture,
                   cr.user_id as creator_user_id,
                   hp.name as hotel_name,
                   hl.name as listing_name,
                   hl.location as listing_location
            FROM collaborations c
            JOIN creators cr ON cr.id = c.creator_id
            JOIN hotel_profiles hp ON hp.id = c.hotel_id
            JOIN hotel_listings hl ON hl.id = c.listing_id
            WHERE {where_clause}
            ORDER BY c.created_at DESC
            LIMIT ${limit_param} OFFSET ${offset_param}
        """

        query_params = params + [page_size, offset]
        rows = await Database.fetch(data_query, *query_params)

        if rows:
            creator_user_ids = list(set(row['creator_user_id'] for row in rows))
            user_rows = await AuthDatabase.fetch(
                "SELECT id, name FROM users WHERE id = ANY($1::uuid[])",
                creator_user_ids
            )
            users_map = {str(u['id']): u['name'] for u in user_rows}
        else:
            users_map = {}

        collaborations = []
        for row in rows:
            collab_id = str(row['id'])
            deliverables = await get_collaboration_deliverables(collab_id)
            collaborations.append(CollaborationResponse.from_db_row(
                row,
                creator_name=users_map.get(str(row['creator_user_id']), 'Unknown'),
                platform_deliverables=deliverables,
            ))

        return CollaborationListResponse(collaborations=collaborations, total=total)

    except Exception as e:
        logger.error(f"Error fetching admin collaborations: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to fetch collaborations"
        )


async def _build_admin_collaboration_response(collaboration_id: str) -> CollaborationResponse:
    """Re-fetch and build the standard collaboration response payload."""
    updated = await CollaborationRepository.get_full(collaboration_id)
    creator_user = await UserRepository.get_by_id(updated['creator_user_id'], columns="name")
    creator_name = creator_user['name'] if creator_user else 'Unknown'
    plat_delivs_resp = await get_collaboration_deliverables(collaboration_id)
    return CollaborationResponse.from_db_row(
        updated,
        creator_name=creator_name,
        platform_deliverables=plat_delivs_resp,
    )


@router.post("/collaborations/{collaboration_id}/respond", response_model=CollaborationResponse)
async def admin_respond_to_collaboration(
    collaboration_id: str,
    request: RespondToCollaborationRequest,
    admin_id: str = Depends(get_admin_user)
):
    """
    Admin accepts or declines a pending collaboration on behalf of the hotel.

    Only valid for creator-initiated, pending collaborations.
    Accept moves status to 'negotiating' and sets hotel_agreed_at.
    Decline moves status to 'declined'.
    """
    collab = await CollaborationRepository.get_by_id(collaboration_id)
    if not collab:
        raise HTTPException(status_code=404, detail="Collaboration not found")

    if collab['status'] != 'pending':
        raise HTTPException(
            status_code=400,
            detail=f"Cannot respond to collaboration with status '{collab['status']}'. Only 'pending' requests can be accepted/declined."
        )

    if collab['initiator_type'] != 'creator':
        raise HTTPException(
            status_code=400,
            detail="Admin can only respond on behalf of the hotel for creator-initiated requests."
        )

    new_status = "negotiating" if request.status == "accepted" else "declined"

    updates = ["status = $1", "responded_at = NOW()", "updated_at = NOW()"]
    params = [new_status, collaboration_id]
    if request.status == "accepted":
        updates.append("hotel_agreed_at = NOW()")

    query = f"UPDATE collaborations SET {', '.join(updates)} WHERE id = ${len(params)}"

    pool = await Database.get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(query, *params)

            if request.status == "accepted":
                msg = "✅ Vayada admin (on behalf of Hotel) is ready to discuss the collaboration terms."
                if request.response_message:
                    msg += f"\n\nMessage: {request.response_message}"
                await create_system_message(collaboration_id, msg, conn=conn)
                await create_system_message(collaboration_id, "💬 Chat is now open! Discuss and finalize the terms.", conn=conn)
            else:
                msg = "❌ Vayada admin (on behalf of Hotel) has declined the collaboration request."
                if request.response_message:
                    msg += f"\n\nMessage: {request.response_message}"
                await create_system_message(collaboration_id, msg, conn=conn)

    response = await _build_admin_collaboration_response(collaboration_id)

    creator_email, creator_email_name = await get_party_email_and_name(
        "creator", creator_id=str(collab['creator_id'])
    )
    if creator_email:
        accepted = request.status == "accepted"
        html = create_collaboration_response_email_html(
            recipient_name=creator_email_name or "there",
            responder_name=response.hotel_name,
            accepted=accepted,
            collaboration_type=collab['collaboration_type'],
            listing_name=response.listing_name,
            listing_location=response.listing_location,
            response_message=request.response_message,
        )
        subject = "Collaboration Request Accepted" if accepted else "Collaboration Request Declined"
        send_email_background(creator_email, subject, html)
        notify_vayada_team(subject, html)

    return response


@router.post("/collaborations/{collaboration_id}/approve", response_model=CollaborationResponse)
async def admin_approve_collaboration(
    collaboration_id: str,
    admin_id: str = Depends(get_admin_user)
):
    """
    Admin approves the current terms on behalf of the hotel.

    Sets hotel_agreed_at = NOW(). If the creator has already agreed, the
    collaboration flips to 'accepted' and the affiliate record is provisioned.
    """
    collab = await CollaborationRepository.get_by_id(collaboration_id)
    if not collab:
        raise HTTPException(status_code=404, detail="Collaboration not found")

    if collab['status'] not in ('pending', 'negotiating'):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot approve collaboration with status '{collab['status']}'."
        )

    other_agreed = collab['creator_agreed_at'] is not None
    updates = ["hotel_agreed_at = NOW()", "updated_at = NOW()"]
    new_status = None
    if other_agreed:
        updates.append("status = 'accepted'")
        updates.append("responded_at = NOW()")
        new_status = 'accepted'
    elif collab['status'] == 'pending':
        # Approving from pending without responding first — treat like an accept
        # so the conversation can move forward.
        updates.append("status = 'negotiating'")

    query = f"UPDATE collaborations SET {', '.join(updates)} WHERE id = $1"
    pool = await Database.get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(query, collaboration_id)
            await create_system_message(
                collaboration_id,
                "✅ Vayada admin (on behalf of Hotel) approved the terms.",
                conn=conn,
            )
            if new_status == 'accepted':
                await create_system_message(collaboration_id, "🎉 Collaboration Accepted!", conn=conn)

    creator_email, creator_email_name = await get_party_email_and_name(
        "creator", creator_id=str(collab['creator_id'])
    )
    hotel_email, hotel_email_name = await get_party_email_and_name(
        "hotel", hotel_id=str(collab['hotel_id'])
    )

    if new_status == 'accepted':
        affiliate_link = await AffiliateProvisioningService.provision_for_accepted_collab(
            collaboration_id,
            creator_id=str(collab['creator_id']),
            hotel_id=str(collab['hotel_id']),
            creator_email=creator_email,
            creator_name=creator_email_name,
            commission=collab.get('creator_fee'),
        )

        for email, name in [(creator_email, creator_email_name), (hotel_email, hotel_email_name)]:
            if email:
                link_for_email = affiliate_link if email == creator_email else None
                html = create_collaboration_approved_email_html(
                    recipient_name=name or "there",
                    other_party_name="Hotel",
                    collaboration_type=collab['collaboration_type'],
                    listing_name=(await CollaborationRepository.get_full(collaboration_id))['listing_name'],
                    listing_location=None,
                    both_approved=True,
                    affiliate_link=link_for_email,
                )
                send_email_background(email, "Collaboration Confirmed!", html)
        notify_vayada_team("Collaboration Confirmed!", html)
    else:
        if creator_email:
            updated_full = await CollaborationRepository.get_full(collaboration_id)
            html = create_collaboration_approved_email_html(
                recipient_name=creator_email_name or "there",
                other_party_name=updated_full['hotel_name'],
                collaboration_type=collab['collaboration_type'],
                listing_name=updated_full['listing_name'],
                listing_location=updated_full.get('listing_location'),
                both_approved=False,
            )
            send_email_background(creator_email, "Terms Approved — Your Confirmation Needed", html)

    return await _build_admin_collaboration_response(collaboration_id)
