"""
In-platform notifications: list and mark-read for the authenticated user.

Notifications are emitted by other parts of the platform (admin verification
of creators, etc.) and surface in the user's inbox / notification center.
"""

import logging
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from fastapi import status as http_status
from pydantic import BaseModel

from app.dependencies import get_current_user_id_allow_pending
from app.repositories.notification_repo import NotificationRepository

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/notifications", tags=["notifications"])


class NotificationResponse(BaseModel):
    id: str
    type: str
    title: str
    body: str
    link_url: str | None = None
    read_at: datetime | None = None
    created_at: datetime


class NotificationListResponse(BaseModel):
    notifications: list[NotificationResponse]
    unread_count: int


def _serialize(row: dict) -> NotificationResponse:
    return NotificationResponse(
        id=str(row["id"]),
        type=row["type"],
        title=row["title"],
        body=row["body"],
        link_url=row.get("link_url"),
        read_at=row.get("read_at"),
        created_at=row["created_at"],
    )


@router.get("", response_model=NotificationListResponse)
async def list_notifications(
    unread_only: bool = False,
    limit: int = 50,
    user_id: str = Depends(get_current_user_id_allow_pending),
):
    """List notifications for the authenticated user, newest first.

    Allows pending users so newly-approved creators can read the approval
    notification before their next login refresh would otherwise update
    them to verified.
    """
    if limit < 1 or limit > 200:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="limit must be between 1 and 200",
        )

    rows = await NotificationRepository.list_for_user(user_id, unread_only=unread_only, limit=limit)
    unread = await NotificationRepository.count_unread(user_id)
    return NotificationListResponse(
        notifications=[_serialize(r) for r in rows],
        unread_count=unread,
    )


@router.post("/{notification_id}/read", status_code=http_status.HTTP_204_NO_CONTENT)
async def mark_notification_read(
    notification_id: str,
    user_id: str = Depends(get_current_user_id_allow_pending),
):
    """Mark a notification as read. No-op if already read or not found."""
    await NotificationRepository.mark_read(notification_id, user_id)
    return None
