"""
Authentication utilities
"""
import bcrypt
import secrets
from typing import Optional
from datetime import datetime, timezone

from app.repositories.user_repo import UserRepository
from app.repositories.password_reset_repo import PasswordResetRepository


def hash_password(password: str) -> str:
    salt = bcrypt.gensalt()
    hashed = bcrypt.hashpw(password.encode('utf-8'), salt)
    return hashed.decode('utf-8')


def verify_password(password: str, hashed_password: str) -> bool:
    return bcrypt.checkpw(
        password.encode('utf-8'),
        hashed_password.encode('utf-8')
    )


async def get_user_by_email(email: str) -> Optional[dict]:
    return await UserRepository.get_by_email(email)


def generate_password_reset_token() -> str:
    """Generate a secure password reset token"""
    return secrets.token_urlsafe(32)


async def create_password_reset_token(user_id: str, expires_in_hours: int = 1) -> str:
    """
    Create a password reset token for a user

    Args:
        user_id: User ID
        expires_in_hours: Token expiration time in hours (default: 1 hour)

    Returns:
        The generated reset token
    """
    token = generate_password_reset_token()
    await PasswordResetRepository.create(user_id, token, expires_in_hours)
    return token


async def validate_password_reset_token(token: str) -> Optional[dict]:
    """
    Validate a password reset token

    Args:
        token: Password reset token

    Returns:
        Dictionary with user_id if token is valid, None otherwise
    """
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
        'email': token_record['email']
    }


async def mark_password_reset_token_as_used(token: str) -> bool:
    """
    Mark a password reset token as used

    Args:
        token: Password reset token

    Returns:
        True if token was marked as used, False otherwise
    """
    return await PasswordResetRepository.mark_used(token)
