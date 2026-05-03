"""Hotel-facing inbox API: list threads, read thread, reply, attachments."""
import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Query

from app.dependencies import require_hotel_admin
from app.models.messaging import (
    Message,
    MessageAttachment,
    MessageThread,
    SendMessageRequest,
    ThreadDetailResponse,
    ThreadListResponse,
    UnreadCountResponse,
)
from app.repositories.channex_mapping_repo import ChannexConnectionRepository
from app.repositories.messaging_repo import (
    MessageAttachmentRepository,
    MessageRepository,
    MessageThreadRepository,
)
from app.services import channex_service
from app.utils import get_hotel_id

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["admin-messaging"])


def _thread_to_model(row: dict) -> MessageThread:
    return MessageThread(
        id=str(row["id"]),
        source=row["source"],
        channel=row.get("channel"),
        booking_id=str(row["booking_id"]) if row.get("booking_id") else None,
        guest_name=row.get("guest_name"),
        guest_email=row.get("guest_email"),
        status=row["status"],
        last_message_at=row.get("last_message_at"),
        last_message_preview=row.get("last_message_preview"),
        last_message_direction=row.get("last_message_direction"),
        unread_count=int(row.get("unread_count") or 0),
    )


def _message_to_model(row: dict, attachments: list) -> Message:
    return Message(
        id=str(row["id"]),
        thread_id=str(row["thread_id"]),
        direction=row["direction"],
        sender_name=row.get("sender_name"),
        body=row.get("body") or "",
        sent_at=row["sent_at"],
        read_at=row.get("read_at"),
        attachments=[
            MessageAttachment(
                id=str(a["id"]),
                filename=a.get("filename"),
                content_type=a.get("content_type"),
                size_bytes=a.get("size_bytes"),
                url=a.get("source_url"),  # phase 1: pass through Channex URL
            )
            for a in attachments
        ],
    )


@router.get("/messaging/threads", response_model=ThreadListResponse)
async def list_threads(
    status: Optional[str] = Query(None, regex="^(open|closed|no_reply_needed)$"),
    limit: int = Query(50, ge=1, le=100),
    before: Optional[datetime] = None,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    rows = await MessageThreadRepository.list_by_hotel(
        hotel_id, status=status, limit=limit, before=before,
    )
    threads = [_thread_to_model(r) for r in rows]
    next_cursor = (
        rows[-1]["last_message_at"].isoformat()
        if len(rows) == limit and rows[-1].get("last_message_at")
        else None
    )
    return ThreadListResponse(threads=threads, next_cursor=next_cursor)


@router.get("/messaging/threads/{thread_id}", response_model=ThreadDetailResponse)
async def get_thread(
    thread_id: str,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    thread_row = await MessageThreadRepository.get_by_id(thread_id, hotel_id)
    if not thread_row:
        raise HTTPException(status_code=404, detail="Thread not found")

    message_rows = await MessageRepository.list_by_thread(thread_id)
    attachments_by_msg: dict[str, list] = {}
    for att in await MessageAttachmentRepository.list_by_thread(thread_id):
        attachments_by_msg.setdefault(str(att["message_id"]), []).append(att)

    messages = [
        _message_to_model(m, attachments_by_msg.get(str(m["id"]), []))
        for m in message_rows
    ]
    return ThreadDetailResponse(
        thread=_thread_to_model(thread_row),
        messages=messages,
    )


@router.post("/messaging/threads/{thread_id}/messages", response_model=Message)
async def send_message(
    thread_id: str,
    body: SendMessageRequest,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    thread = await MessageThreadRepository.get_by_id(thread_id, hotel_id)
    if not thread:
        raise HTTPException(status_code=404, detail="Thread not found")
    if not body.body and not body.attachment_ids:
        raise HTTPException(status_code=400, detail="message body or attachment required")

    api_key = channex_service.get_platform_api_key()
    source_thread_id = thread["source_thread_id"]

    # Channex accepts one attachment per message; if more were uploaded, send
    # them as separate messages. Body goes with the first.
    attachments = body.attachment_ids or [None]
    last_inserted = None
    for idx, attachment_id in enumerate(attachments):
        msg_body = body.body if idx == 0 else ""
        try:
            channex_msg = await channex_service.post_thread_message(
                api_key, source_thread_id,
                message=msg_body, attachment_id=attachment_id,
            )
        except Exception as e:
            logger.exception("Failed to send Channex message")
            raise HTTPException(status_code=502, detail=f"Channex send failed: {e}")

        attrs = channex_msg.get("attributes") or {}
        sent_at_str = attrs.get("inserted_at")
        sent_at = (
            datetime.fromisoformat(sent_at_str.replace("Z", "+00:00"))
            if sent_at_str else datetime.now(timezone.utc)
        )
        inserted = await MessageRepository.insert_and_update_thread(
            thread_id=thread_id,
            source_message_id=str(channex_msg["id"]),
            direction="outbound",
            sender_name=None,
            body=msg_body,
            sent_at=sent_at,
            raw_payload=channex_msg,
        )
        if inserted and attachment_id:
            await MessageAttachmentRepository.add(
                message_id=str(inserted["id"]),
                source_attachment_id=attachment_id,
            )
        last_inserted = inserted

    if not last_inserted:
        # All sends collided with prior records — return the latest existing.
        rows = await MessageRepository.list_by_thread(thread_id)
        if not rows:
            raise HTTPException(status_code=500, detail="Send appeared to succeed but message not found")
        last_inserted = rows[-1]

    atts = await MessageAttachmentRepository.list_by_message(str(last_inserted["id"]))
    return _message_to_model(last_inserted, atts)


@router.post("/messaging/threads/{thread_id}/attachments")
async def upload_thread_attachment(
    thread_id: str,
    file: UploadFile = File(...),
    user_id: str = Depends(require_hotel_admin),
):
    """Upload an attachment to Channex; returns the attachment_id to pass to
    the send-message endpoint."""
    hotel_id = await get_hotel_id(user_id)
    thread = await MessageThreadRepository.get_by_id(thread_id, hotel_id)
    if not thread:
        raise HTTPException(status_code=404, detail="Thread not found")

    contents = await file.read()
    if len(contents) > 25 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Attachment exceeds 25MB")

    api_key = channex_service.get_platform_api_key()
    try:
        result = await channex_service.upload_attachment(
            api_key,
            file_bytes=contents,
            filename=file.filename or "attachment",
            content_type=file.content_type or "application/octet-stream",
        )
    except Exception as e:
        logger.exception("Channex attachment upload failed")
        raise HTTPException(status_code=502, detail=f"Upload failed: {e}")

    return {"attachment_id": result["id"]}


@router.post("/messaging/threads/{thread_id}/read", response_model=MessageThread)
async def mark_thread_read(
    thread_id: str,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    row = await MessageThreadRepository.mark_all_read(thread_id, hotel_id)
    if not row:
        raise HTTPException(status_code=404, detail="Thread not found")
    return _thread_to_model(row)


@router.post("/messaging/threads/{thread_id}/close", response_model=MessageThread)
async def close_thread(
    thread_id: str,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    thread = await MessageThreadRepository.get_by_id(thread_id, hotel_id)
    if not thread:
        raise HTTPException(status_code=404, detail="Thread not found")

    api_key = channex_service.get_platform_api_key()
    try:
        await channex_service.close_thread(api_key, thread["source_thread_id"])
    except Exception as e:
        logger.warning("Channex close_thread failed (continuing locally): %s", e)

    row = await MessageThreadRepository.update_status(thread_id, hotel_id, "closed")
    return _thread_to_model(row) if row else _thread_to_model(thread)


@router.post("/messaging/threads/{thread_id}/no-reply-needed", response_model=MessageThread)
async def mark_no_reply_needed(
    thread_id: str,
    user_id: str = Depends(require_hotel_admin),
):
    """Booking.com only — tells BDC the conversation needs no reply (counts
    toward response-time SLA)."""
    hotel_id = await get_hotel_id(user_id)
    thread = await MessageThreadRepository.get_by_id(thread_id, hotel_id)
    if not thread:
        raise HTTPException(status_code=404, detail="Thread not found")
    if thread.get("channel") != "booking.com":
        raise HTTPException(status_code=400, detail="Only available for Booking.com threads")

    api_key = channex_service.get_platform_api_key()
    try:
        await channex_service.mark_thread_no_reply_needed(api_key, thread["source_thread_id"])
    except Exception as e:
        logger.exception("Channex no_reply_needed failed")
        raise HTTPException(status_code=502, detail=f"Channex call failed: {e}")

    row = await MessageThreadRepository.update_status(thread_id, hotel_id, "no_reply_needed")
    return _thread_to_model(row) if row else _thread_to_model(thread)


@router.get("/messaging/unread-count", response_model=UnreadCountResponse)
async def unread_count(
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    n = await MessageThreadRepository.hotel_unread_count(hotel_id)
    return UnreadCountResponse(unread_count=n)
