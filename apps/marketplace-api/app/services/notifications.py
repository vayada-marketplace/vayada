"""
Email-notification helpers shared across routers.

Background email tasks need a strong reference set, otherwise asyncio's GC
can collect a fire-and-forget task before SMTP completes (cause of the
VAY-241 missed admin notifications regression).
"""

import asyncio
import logging

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


async def notify_marketplace_admin_sync(subject: str, html_body: str) -> bool:
    """Send the marketplace admin notification within the request lifecycle.

    Unlike the fire-and-forget helpers, this awaits the SMTP send so the
    delivery cannot be silently lost when the event loop / worker is torn
    down on an ECS redeploy while a backgrounded task is still in flight —
    the root cause of the recurring VAY-241 missed admin notifications.

    Never raises: a failed *internal* notification must not break the
    user-facing collaboration flow. Any failure is logged at ERROR with
    enough context to diagnose (the silent-drop is what the previous fix
    missed — send_email returning False was never surfaced).

    Returns True only if the email was actually accepted for delivery.
    """
    full_subject = f"[Marketplace] {subject}"
    try:
        sent = await send_email(MARKETPLACE_ADMIN_EMAIL, full_subject, html_body)
    except Exception as e:
        logger.error(
            f"Marketplace admin notification to {MARKETPLACE_ADMIN_EMAIL} "
            f"raised {e!r} (subject={full_subject!r})"
        )
        return False
    if not sent:
        logger.error(
            f"Marketplace admin notification to {MARKETPLACE_ADMIN_EMAIL} was "
            f"NOT delivered (send_email returned False — check EMAIL_ENABLED / "
            f"SMTP config) (subject={full_subject!r})"
        )
    return sent


async def get_party_email_and_name(
    party: str,
    creator_id: str | None = None,
    hotel_id: str | None = None,
) -> tuple:
    """Resolve (email, name) for a collaboration party ('creator' or 'hotel')."""
    try:
        if party == "creator" and creator_id:
            creator = await CreatorRepository.get_by_id(creator_id, columns="user_id")
            if creator:
                user = await UserRepository.get_by_id(creator["user_id"], columns="email, name")
                if user:
                    return user["email"], user["name"]
        elif party == "hotel" and hotel_id:
            hotel = await HotelRepository.get_profile_by_id(hotel_id, columns="user_id, name")
            if hotel:
                user = await UserRepository.get_by_id(hotel["user_id"], columns="email, name")
                if user:
                    return user["email"], hotel["name"]
    except Exception as e:
        logger.error(f"Failed to resolve {party} email: {e}")
    return None, None
