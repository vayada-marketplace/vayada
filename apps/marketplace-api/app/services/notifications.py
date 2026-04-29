"""
Email-notification helpers shared across routers.

Background email tasks need a strong reference set, otherwise asyncio's GC
can collect a fire-and-forget task before SMTP completes (cause of the
VAY-241 missed admin notifications regression).
"""
import asyncio
import logging
from typing import Optional

from app.email_service import send_email
from app.repositories.creator_repo import CreatorRepository
from app.repositories.hotel_repo import HotelRepository
from app.repositories.user_repo import UserRepository

logger = logging.getLogger(__name__)


VAYADA_COLLABORATIONS_EMAIL = "collaborations@vayada.com"
MARKETPLACE_ADMIN_EMAIL = "p.paetzold@vayada.com"

_background_tasks: set = set()


async def _send_email_safe(to_email: str, subject: str, html_body: str) -> None:
    try:
        await send_email(to_email, subject, html_body)
    except Exception as e:
        logger.error(f"Background email to {to_email} failed: {e}")


def send_email_background(to_email: str, subject: str, html_body: str) -> None:
    """Fire-and-forget email sending — never blocks the response."""
    task = asyncio.create_task(_send_email_safe(to_email, subject, html_body))
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)


def notify_vayada_team(subject: str, html_body: str) -> None:
    """Send a copy to the vayada collaborations team."""
    send_email_background(VAYADA_COLLABORATIONS_EMAIL, f"[Internal] {subject}", html_body)


def notify_marketplace_admin(subject: str, html_body: str) -> None:
    """Send a copy of marketplace activity to the marketplace admin."""
    send_email_background(MARKETPLACE_ADMIN_EMAIL, f"[Marketplace] {subject}", html_body)


async def get_party_email_and_name(
    party: str,
    creator_id: Optional[str] = None,
    hotel_id: Optional[str] = None,
) -> tuple:
    """Resolve (email, name) for a collaboration party ('creator' or 'hotel')."""
    try:
        if party == "creator" and creator_id:
            creator = await CreatorRepository.get_by_id(creator_id, columns="user_id")
            if creator:
                user = await UserRepository.get_by_id(creator['user_id'], columns="email, name")
                if user:
                    return user['email'], user['name']
        elif party == "hotel" and hotel_id:
            hotel = await HotelRepository.get_profile_by_id(hotel_id, columns="user_id, name")
            if hotel:
                user = await UserRepository.get_by_id(hotel['user_id'], columns="email, name")
                if user:
                    return user['email'], hotel['name']
    except Exception as e:
        logger.error(f"Failed to resolve {party} email: {e}")
    return None, None
