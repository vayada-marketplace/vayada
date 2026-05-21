"""
Chat-related Pydantic models
"""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

# ============================================
# CHAT MESSAGE REQUEST
# ============================================


class CreateChatMessageRequest(BaseModel):
    """Request to send a chat message"""

    content: str = Field(..., min_length=1)
    message_type: Literal["text", "image"] = "text"

    model_config = ConfigDict(populate_by_name=True)


# ============================================
# CHAT MESSAGE RESPONSE
# ============================================


class ChatMessageResponse(BaseModel):
    """Response model for a chat message"""

    id: str
    collaborationId: str = Field(alias="collaboration_id")
    senderId: str | None = Field(None, alias="sender_id")  # Null for system messages
    content: str
    messageType: str = Field(alias="message_type")
    metadata: dict | None = None
    createdAt: datetime = Field(alias="created_at")
    readAt: datetime | None = Field(None, alias="read_at")

    # Sender info (joined)
    senderName: str | None = Field(None, alias="sender_name")
    senderAvatar: str | None = Field(None, alias="sender_avatar")

    model_config = ConfigDict(populate_by_name=True, from_attributes=True)


# ============================================
# CONVERSATION RESPONSE
# ============================================


class ConversationResponse(BaseModel):
    """Inbox thread / Conversation summary"""

    collaborationId: str = Field(alias="collaboration_id")
    collaborationStatus: str = Field(alias="collaboration_status")
    partnerName: str = Field(alias="partner_name")
    partnerAvatar: str | None = Field(None, alias="partner_avatar")
    lastMessageContent: str | None = Field(None, alias="last_message_content")
    lastMessageAt: datetime | None = Field(None, alias="last_message_at")
    lastMessageType: str | None = Field(None, alias="last_message_type")
    unreadCount: int = Field(0, alias="unread_count")
    myRole: str = Field(alias="my_role")  # 'creator' or 'hotel'
    listingName: str | None = Field(None, alias="listing_name")

    model_config = ConfigDict(populate_by_name=True)
