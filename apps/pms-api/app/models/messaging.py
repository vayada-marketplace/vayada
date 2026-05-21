from datetime import datetime

from pydantic import BaseModel, ConfigDict


def to_camel(string: str) -> str:
    parts = string.split("_")
    return parts[0] + "".join(w.capitalize() for w in parts[1:])


class _Camel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class MessageAttachment(_Camel):
    id: str
    filename: str | None = None
    content_type: str | None = None
    size_bytes: int | None = None
    url: str | None = None  # presigned S3 url; null until generated


class Message(_Camel):
    id: str
    thread_id: str
    direction: str  # "inbound" | "outbound"
    sender_name: str | None = None
    body: str
    sent_at: datetime
    read_at: datetime | None = None
    attachments: list[MessageAttachment] = []


class MessageThread(_Camel):
    id: str
    source: str
    channel: str | None = None  # "booking.com" | "airbnb" | "expedia" | None
    booking_id: str | None = None
    guest_name: str | None = None
    guest_email: str | None = None
    status: str
    last_message_at: datetime | None = None
    last_message_preview: str | None = None
    last_message_direction: str | None = None
    unread_count: int = 0


class ThreadListResponse(_Camel):
    threads: list[MessageThread]
    next_cursor: str | None = None


class ThreadDetailResponse(_Camel):
    thread: MessageThread
    messages: list[Message]


class SendMessageRequest(_Camel):
    body: str = ""
    attachment_ids: list[str] = []


class UnreadCountResponse(_Camel):
    unread_count: int
