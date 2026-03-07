"""
Authentication utilities — password hashing and reset tokens.
"""
import bcrypt
import secrets
from typing import Optional
from datetime import datetime, timezone

from app.repositories.password_reset_repo import PasswordResetRepository


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
