import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends, Query

from app.dependencies import require_hotel_admin
from app.utils import get_hotel_id
from app.repositories.messaging_repo import ConversationRepository, MessageRepository
from app.models.messaging import (
    ConversationResponse,
    MessageResponse,
    MessageCreate,
    ConversationStatusUpdate,
)
from app.services.messaging_service import send_host_message, mark_conversation_read

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["admin-messaging"])


def _conversation_to_response(c: dict) -> ConversationResponse:
    last_msg = c.get("last_message_at")
    return ConversationResponse(
        id=str(c["id"]),
        booking_id=str(c["booking_id"]) if c.get("booking_id") else None,
        channel=c["channel"],
        guest_name=c["guest_name"],
        guest_email=c["guest_email"],
        subject=c["subject"],
        status=c["status"],
        unread_count=c["unread_count"],
        last_message_at=last_msg.isoformat() if last_msg else None,
        last_message_preview=c.get("last_message_preview"),
        booking_reference=c.get("booking_reference"),
        room_name=c.get("room_name"),
        created_at=c["created_at"].isoformat(),
    )


def _message_to_response(m: dict) -> MessageResponse:
    return MessageResponse(
        id=str(m["id"]),
        conversation_id=str(m["conversation_id"]),
        sender_type=m["sender_type"],
        sender_name=m["sender_name"],
        body=m["body"],
        channel=m["channel"],
        is_read=m["is_read"],
        created_at=m["created_at"].isoformat(),
    )


@router.get("/conversations")
async def list_conversations(
    status: Optional[str] = Query(None),
    channel: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    conversations = await ConversationRepository.list_by_hotel_id(
        hotel_id, status=status, channel=channel, search=search, limit=limit, offset=offset
    )
    total = await ConversationRepository.count_by_hotel_id(
        hotel_id, status=status, channel=channel, search=search
    )
    return {
        "conversations": [_conversation_to_response(c) for c in conversations],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


@router.get("/conversations/unread-count")
async def get_unread_count(
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    count = await ConversationRepository.count_unread_by_hotel_id(hotel_id)
    return {"unreadCount": count}


@router.get("/conversations/{conversation_id}", response_model=ConversationResponse)
async def get_conversation(
    conversation_id: str,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    conversation = await ConversationRepository.get_by_id(conversation_id)
    if not conversation or str(conversation["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return _conversation_to_response(conversation)


@router.get("/conversations/{conversation_id}/messages")
async def list_messages(
    conversation_id: str,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    conversation = await ConversationRepository.get_by_id(conversation_id)
    if not conversation or str(conversation["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Conversation not found")

    messages = await MessageRepository.list_by_conversation(conversation_id, limit=limit, offset=offset)
    total = await MessageRepository.count_by_conversation(conversation_id)
    return {
        "messages": [_message_to_response(m) for m in messages],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


@router.post("/conversations/{conversation_id}/messages", response_model=MessageResponse, status_code=201)
async def post_message(
    conversation_id: str,
    data: MessageCreate,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    try:
        message = await send_host_message(conversation_id, data.body, hotel_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return _message_to_response(message)


@router.patch("/conversations/{conversation_id}/status", response_model=ConversationResponse)
async def update_conversation_status(
    conversation_id: str,
    data: ConversationStatusUpdate,
    user_id: str = Depends(require_hotel_admin),
):
    if data.status not in ("open", "closed", "archived"):
        raise HTTPException(status_code=400, detail="Status must be 'open', 'closed', or 'archived'")

    hotel_id = await get_hotel_id(user_id)
    conversation = await ConversationRepository.get_by_id(conversation_id)
    if not conversation or str(conversation["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Conversation not found")

    updated = await ConversationRepository.update_status(conversation_id, data.status)
    full = await ConversationRepository.get_by_id(conversation_id)
    return _conversation_to_response(full)


@router.post("/conversations/{conversation_id}/mark-read")
async def post_mark_read(
    conversation_id: str,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    conversation = await ConversationRepository.get_by_id(conversation_id)
    if not conversation or str(conversation["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Conversation not found")

    await mark_conversation_read(conversation_id)
    return {"status": "ok"}
