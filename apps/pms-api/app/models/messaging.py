from pydantic import BaseModel, ConfigDict
from typing import List, Optional


def to_camel(string: str) -> str:
    parts = string.split("_")
    return parts[0] + "".join(w.capitalize() for w in parts[1:])


class MessageCreate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    body: str


class ConversationStatusUpdate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    status: str  # 'open', 'closed', or 'archived'


class MessageResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    conversation_id: str
    sender_type: str
    sender_name: str
    body: str
    channel: str
    is_read: bool
    created_at: str


class ConversationResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    booking_id: Optional[str] = None
    channel: str
    guest_name: str
    guest_email: str
    subject: str
    status: str
    unread_count: int
    last_message_at: Optional[str] = None
    last_message_preview: Optional[str] = None
    booking_reference: Optional[str] = None
    room_name: Optional[str] = None
    created_at: str


