"""
Chat routes for collaborations
"""
from fastapi import APIRouter, HTTPException, status as http_status, Depends, Query
from typing import List, Optional
from datetime import datetime
import json
import logging

from app.dependencies import get_current_user_id
from app.repositories.user_repo import UserRepository
from app.repositories.chat_repo import ChatRepository
from app.models.chat import (
    CreateChatMessageRequest,
    ChatMessageResponse,
    ConversationResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/collaborations", tags=["chat"])


# ============================================
# HELPERS
# ============================================

async def create_system_message(
    collaboration_id: str,
    content: str,
    metadata: dict = None,
    conn = None
):
    """Helper to insert a system message into chat"""
    await ChatRepository.create_system_message(
        collaboration_id,
        content,
        json.dumps(metadata) if metadata else None,
        conn=conn
    )


# ============================================
# ENDPOINTS
# ============================================

@router.get("/conversations", response_model=List[ConversationResponse])
async def get_conversations(
    user_id: str = Depends(get_current_user_id)
):
    """
    Get all chat threads for the logged-in user.
    Returns partner info, last message, and unread count.
    """
    rows = await ChatRepository.get_conversations(user_id)

    # Batch-fetch partner names
    partner_ids = list(set(str(row['partner_user_id']) for row in rows if row['partner_user_id']))
    partner_names_map = await UserRepository.batch_get_names(partner_ids) if partner_ids else {}

    return [
        ConversationResponse(
            collaboration_id=str(row['collab_id']),
            collaboration_status=row['collab_status'],
            partner_name=partner_names_map.get(str(row['partner_user_id']), 'Unknown'),
            partner_avatar=row['partner_avatar'],
            last_message_content=row['last_message_content'],
            last_message_at=row['last_message_at'],
            last_message_type=row['last_message_type'],
            unread_count=row['unread_count'],
            my_role=row['my_role'],
            listing_name=row['listing_name']
        )
        for row in rows
    ]

@router.get("/{collaboration_id}/messages", response_model=List[ChatMessageResponse])
async def get_chat_messages(
    collaboration_id: str,
    limit: int = Query(50, ge=1, le=100),
    before: Optional[datetime] = None,
    user_id: str = Depends(get_current_user_id)
):
    """Get chat history"""
    messages = await ChatRepository.get_messages(collaboration_id, before)

    # Batch-fetch sender names
    sender_ids = list(set(str(m['sender_id']) for m in messages if m['sender_id']))
    sender_names_map = await UserRepository.batch_get_names(sender_ids) if sender_ids else {}

    return [
        ChatMessageResponse(
            id=str(m['id']),
            collaboration_id=str(m['collaboration_id']),
            sender_id=str(m['sender_id']) if m['sender_id'] else None,
            content=m['content'],
            message_type=m['message_type'],
            metadata=json.loads(m['metadata']) if m['metadata'] else None,
            created_at=m['created_at'],
            read_at=m['read_at'],
            sender_name=sender_names_map.get(str(m['sender_id']), 'System') if m['sender_id'] else 'System',
            sender_avatar=m['sender_avatar']
        )
        for m in messages
    ]


@router.post("/{collaboration_id}/messages", response_model=ChatMessageResponse)
async def send_chat_message(
    collaboration_id: str,
    request: CreateChatMessageRequest,
    user_id: str = Depends(get_current_user_id)
):
    """Send a text message"""
    # TODO: Verify access

    row = await ChatRepository.send_message(collaboration_id, user_id, request.content, request.message_type)

    return ChatMessageResponse(
        id=str(row['id']),
        collaboration_id=collaboration_id,
        sender_id=user_id,
        content=request.content,
        message_type=request.message_type,
        created_at=row['created_at'],
        metadata=None,
        # Default sender info (frontend will often reload or have current user info)
        sender_name="Me",
        sender_avatar=None
    )

@router.post("/{collaboration_id}/read")
async def mark_messages_as_read(
    collaboration_id: str,
    user_id: str = Depends(get_current_user_id)
):
    """
    Mark all messages in a collaboration as read for the current user.
    Logic: Mark all messages where sender is NOT the current user (or is system/NULL).
    """
    try:
        await ChatRepository.mark_as_read(collaboration_id, user_id)
        return {"status": "success", "message": "Messages marked as read"}
    except Exception as e:
        logger.error(f"Error marking messages as read: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))
