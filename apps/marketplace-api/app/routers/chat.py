"""
Chat routes for collaborations
"""
from fastapi import APIRouter, HTTPException, status as http_status, Depends, Query
from pydantic import BaseModel, Field, ConfigDict
from typing import List, Optional, Literal
from datetime import datetime
import json
import logging
from app.database import Database
from app.dependencies import get_current_user_id

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/collaborations", tags=["chat"])

# ============================================
# MODELS
# ============================================

class CreateChatMessageRequest(BaseModel):
    """Request to send a chat message"""
    content: str = Field(..., min_length=1)
    message_type: Literal["text", "image"] = "text"
    
    model_config = ConfigDict(populate_by_name=True)


class ChatMessageResponse(BaseModel):
    """Response model for a chat message"""
    id: str
    collaborationId: str = Field(alias="collaboration_id")
    senderId: Optional[str] = Field(None, alias="sender_id") # Null for system messages
    content: str
    messageType: str = Field(alias="message_type")
    metadata: Optional[dict] = None
    createdAt: datetime = Field(alias="created_at")
    readAt: Optional[datetime] = Field(None, alias="read_at")
    
    # Sender info (joined)
    senderName: Optional[str] = Field(None, alias="sender_name")
    senderAvatar: Optional[str] = Field(None, alias="sender_avatar")
    
    model_config = ConfigDict(populate_by_name=True, from_attributes=True)


class ConversationResponse(BaseModel):
    """Inbox thread / Conversation summary"""
    collaborationId: str = Field(alias="collaboration_id")
    collaborationStatus: str = Field(alias="collaboration_status")
    partnerName: str = Field(alias="partner_name")
    partnerAvatar: Optional[str] = Field(None, alias="partner_avatar")
    lastMessageContent: Optional[str] = Field(None, alias="last_message_content")
    lastMessageAt: Optional[datetime] = Field(None, alias="last_message_at")
    lastMessageType: Optional[str] = Field(None, alias="last_message_type")
    unreadCount: int = Field(0, alias="unread_count")
    myRole: str = Field(alias="my_role") # 'creator' or 'hotel'
    
    model_config = ConfigDict(populate_by_name=True)


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
    query = """
    INSERT INTO chat_messages (collaboration_id, sender_id, content, message_type, metadata)
    VALUES ($1, NULL, $2, 'system', $3)
    """
    params = [collaboration_id, content, json.dumps(metadata) if metadata else None]
    
    if conn:
        await conn.execute(query, *params)
    else:
        await Database.execute(query, *params)


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
    query = """
    WITH user_collabs AS (
        SELECT 
            c.id as collab_id,
            c.status as collab_status,
            CASE 
                WHEN cr.user_id = $1 THEN 'creator'
                WHEN hp.user_id = $1 THEN 'hotel'
            END as my_role,
            CASE 
                WHEN cr.user_id = $1 THEN hp.user_id
                ELSE cr.user_id
            END as partner_user_id
        FROM collaborations c
        JOIN creators cr ON cr.id = c.creator_id
        JOIN hotel_profiles hp ON hp.id = c.hotel_id
        WHERE (cr.user_id = $1 OR hp.user_id = $1)
          AND c.status != 'pending'
    ),
    latest_messages AS (
        SELECT DISTINCT ON (collaboration_id) 
            collaboration_id, content, created_at, message_type
        FROM chat_messages
        ORDER BY collaboration_id, created_at DESC
    ),
    unread_counts AS (
        SELECT collaboration_id, COUNT(*) as count
        FROM chat_messages
        WHERE read_at IS NULL AND sender_id != $1
        GROUP BY collaboration_id
    )
    SELECT 
        uc.collab_id,
        uc.collab_status,
        uc.my_role,
        p_user.name as partner_name,
        COALESCE(p_creator.profile_picture, p_hotel.picture) as partner_avatar,
        lm.content as last_message_content,
        lm.created_at as last_message_at,
        lm.message_type as last_message_type,
        COALESCE(un.count, 0) as unread_count
    FROM user_collabs uc
    JOIN users p_user ON p_user.id = uc.partner_user_id
    LEFT JOIN creators p_creator ON p_creator.user_id = uc.partner_user_id
    LEFT JOIN hotel_profiles p_hotel ON p_hotel.user_id = uc.partner_user_id
    LEFT JOIN latest_messages lm ON lm.collaboration_id = uc.collab_id
    LEFT JOIN unread_counts un ON un.collaboration_id = uc.collab_id
    ORDER BY COALESCE(lm.created_at, '1970-01-01') DESC
    """
    
    rows = await Database.fetch(query, user_id)
    
    return [
        ConversationResponse(
            collaboration_id=str(row['collab_id']),
            collaboration_status=row['collab_status'],
            partner_name=row['partner_name'],
            partner_avatar=row['partner_avatar'],
            last_message_content=row['last_message_content'],
            last_message_at=row['last_message_at'],
            last_message_type=row['last_message_type'],
            unread_count=row['unread_count'],
            my_role=row['my_role']
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
    # 1. Verify access checking user is participant
    # (Simple check: user must be creator or hotel associated with collab)
    # We can fetch the collaboration to verify specific user, 
    # but for now we follow the pattern in collaborations.py (which I added but simplified)
    
    # Ideally reuse access check logic
    
    query = """
        SELECT m.*, 
               CASE WHEN u.name IS NOT NULL THEN u.name ELSE 'System' END as sender_name,
               CASE 
                   WHEN c.profile_picture IS NOT NULL THEN c.profile_picture 
                   WHEN hp.picture IS NOT NULL THEN hp.picture 
                   ELSE NULL 
               END as sender_avatar
        FROM chat_messages m
        LEFT JOIN users u ON u.id = m.sender_id
        LEFT JOIN creators c ON c.user_id = u.id
        LEFT JOIN hotel_profiles hp ON hp.user_id = u.id
        WHERE m.collaboration_id = $1
    """
    params = [collaboration_id]
    param_idx = 2
    
    if before:
        query += f" AND m.created_at < ${param_idx}"
        params.append(before)
        param_idx += 1
        
    query += " ORDER BY m.created_at DESC LIMIT 50"
    
    messages = await Database.fetch(query, *params)
    
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
            sender_name=m['sender_name'],
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
    
    query = """
    INSERT INTO chat_messages (collaboration_id, sender_id, content, message_type)
    VALUES ($1, $2, $3, $4)
    RETURNING id, created_at
    """
    
    row = await Database.fetchrow(query, collaboration_id, user_id, request.content, request.message_type)
    
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
        query = """
        UPDATE chat_messages 
        SET read_at = NOW() 
        WHERE collaboration_id = $1 
          AND (sender_id != $2 OR sender_id IS NULL)
          AND read_at IS NULL
        """
        await Database.execute(query, collaboration_id, user_id)
        return {"status": "success", "message": "Messages marked as read"}
    except Exception as e:
        logger.error(f"Error marking messages as read: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))
