"""
Authentication utilities — password hashing, reset tokens, and the
shared httpOnly auth cookie used by the *.vayada.com frontends.
"""
import bcrypt
import secrets
from typing import Optional
from datetime import datetime, timezone

from fastapi import Response

from app.config import settings
from app.repositories.password_reset_repo import PasswordResetRepository


# Cookie name is shared across backends (booking-engine, pms-backend) and
# frontends. Don't rename without coordinating.
AUTH_COOKIE_NAME = "access_token"


def set_auth_cookie(response: Response, token: str, max_age_seconds: int) -> None:
    """Set the httpOnly auth cookie on the response. SameSite=None is
    required so the cookie is sent on cross-origin XHR/fetch from
    affiliate.vayada.com → pms-api.vayada.com (same site, different
    origin)."""
    response.set_cookie(
        key=AUTH_COOKIE_NAME,
        value=token,
        max_age=max_age_seconds,
        httponly=True,
        secure=settings.AUTH_COOKIE_SECURE,
        samesite="none",
        domain=settings.AUTH_COOKIE_DOMAIN or None,
        path="/",
    )


def clear_auth_cookie(response: Response) -> None:
    response.delete_cookie(
        key=AUTH_COOKIE_NAME,
        domain=settings.AUTH_COOKIE_DOMAIN or None,
        path="/",
    )


def hash_password(password: str) -> str:
    salt = bcrypt.gensalt()
    return bcrypt.hashpw(password.encode('utf-8'), salt).decode('utf-8')


def verify_password(password: str, hashed_password: str) -> bool:
    return bcrypt.checkpw(password.encode('utf-8'), hashed_password.encode('utf-8'))


async def create_password_reset_token(user_id: str, expires_in_hours: int = 1) -> str:
    token = secrets.token_urlsafe(32)
    await PasswordResetRepository.create(user_id, token, expires_in_hours)
    return token


async def validate_password_reset_token(token: str) -> Optional[dict]:
    token_record = await PasswordResetRepository.get_valid_token(token)

    if not token_record:
        return None
    if token_record['used']:
        return None
    if datetime.now(timezone.utc) > token_record['expires_at']:
        return None
    if token_record['status'] == 'suspended':
        return None

    return {
        'user_id': str(token_record['user_id']),
        'email': token_record['email'],
    }


async def mark_password_reset_token_as_used(token: str) -> bool:
    return await PasswordResetRepository.mark_used(token)
