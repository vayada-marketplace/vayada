from pydantic import BaseModel, ConfigDict
from typing import Optional, List
from datetime import datetime


def to_camel(string: str) -> str:
    parts = string.split("_")
    return parts[0] + "".join(w.capitalize() for w in parts[1:])


class _Camel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class MessageAttachment(_Camel):
    id: str
    filename: Optional[str] = None
    content_type: Optional[str] = None
    size_bytes: Optional[int] = None
    url: Optional[str] = None  # presigned S3 url; null until generated


class Message(_Camel):
    id: str
    thread_id: str
    direction: str  # "inbound" | "outbound"
    sender_name: Optional[str] = None
    body: str
    sent_at: datetime
    read_at: Optional[datetime] = None
    attachments: List[MessageAttachment] = []


class MessageThread(_Camel):
    id: str
    source: str
    channel: Optional[str] = None  # "booking.com" | "airbnb" | "expedia" | None
    booking_id: Optional[str] = None
    guest_name: Optional[str] = None
    guest_email: Optional[str] = None
    status: str
    last_message_at: Optional[datetime] = None
    last_message_preview: Optional[str] = None
    last_message_direction: Optional[str] = None
    unread_count: int = 0


class ThreadListResponse(_Camel):
    threads: List[MessageThread]
    next_cursor: Optional[str] = None


class ThreadDetailResponse(_Camel):
    thread: MessageThread
    messages: List[Message]


class SendMessageRequest(_Camel):
    body: str = ""
    attachment_ids: List[str] = []


class UnreadCountResponse(_Camel):
    unread_count: int
