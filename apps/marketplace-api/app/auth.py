"""
Authentication utilities
"""
import bcrypt
import secrets
import random
from typing import Optional
from datetime import datetime, timezone

from app.repositories.user_repo import UserRepository
from app.repositories.password_reset_repo import PasswordResetRepository
from app.repositories.verification_repo import VerificationRepository


def hash_password(password: str) -> str:
    """Hash a password using bcrypt"""
    salt = bcrypt.gensalt()
    hashed = bcrypt.hashpw(password.encode('utf-8'), salt)
    return hashed.decode('utf-8')


def verify_password(password: str, hashed_password: str) -> bool:
    """Verify a password against a hash"""
    return bcrypt.checkpw(
        password.encode('utf-8'),
        hashed_password.encode('utf-8')
    )


async def get_user_by_email(email: str) -> Optional[dict]:
    """Get user by email from database"""
    return await UserRepository.get_by_email(email)


async def create_user(email: str, password_hash: str, user_type: str, name: Optional[str] = None) -> dict:
    """Create a new user in the database"""
    if not name:
        name = email.split('@')[0]

    return await UserRepository.create(
        email=email,
        password_hash=password_hash,
        name=name,
        user_type=user_type,
        terms_version="2024-01-01",
        privacy_version="2024-01-01",
        marketing_consent=False,
    )


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


def generate_email_verification_code() -> str:
    """Generate a 6-digit verification code"""
    return f"{random.randint(100000, 999999)}"


async def create_email_verification_code(email: str, expires_in_minutes: int = 15) -> str:
    """
    Create and store an email verification code

    Args:
        email: Email address to verify
        expires_in_minutes: Code expiration time in minutes (default: 15 minutes)

    Returns:
        The generated 6-digit verification code
    """
    code = generate_email_verification_code()

    # Invalidate any existing unused codes for this email
    await VerificationRepository.invalidate_codes_for_email(email)

    # Insert new code
    await VerificationRepository.create_code(email, code, expires_in_minutes)

    return code


async def verify_email_code(email: str, code: str) -> bool:
    """
    Verify an email verification code

    Args:
        email: Email address
        code: 6-digit verification code

    Returns:
        True if code is valid and not expired, False otherwise
    """
    import logging
    logger = logging.getLogger(__name__)

    code_record = await VerificationRepository.get_valid_code(email, code)

    if not code_record:
        logger.debug(f"No valid code found for email: {email}, code: {code}")
        return False

    # Mark code as used
    await VerificationRepository.mark_code_used(code_record['id'])

    logger.debug(f"Code verified successfully for email: {email}, expires_at: {code_record['expires_at']}")
    return True


async def mark_email_as_verified(email: str) -> bool:
    """
    Mark a user's email as verified

    Args:
        email: Email address to mark as verified

    Returns:
        True if email was marked as verified, False otherwise
    """
    return await UserRepository.mark_email_verified(email)


def generate_email_verification_token() -> str:
    """Generate a secure email verification token"""
    return secrets.token_urlsafe(32)


async def create_email_verification_token(user_id: str, expires_in_hours: int = 48) -> str:
    """
    Create an email verification token for a user

    Args:
        user_id: User ID
        expires_in_hours: Token expiration time in hours (default: 48 hours)

    Returns:
        The generated verification token
    """
    token = generate_email_verification_token()

    # Invalidate any existing unused tokens for this user
    await VerificationRepository.invalidate_tokens_for_user(user_id)

    # Insert new token
    await VerificationRepository.create_token(user_id, token, expires_in_hours)

    return token


async def validate_email_verification_token(token: str) -> Optional[dict]:
    """
    Validate an email verification token

    Args:
        token: Email verification token

    Returns:
        Dictionary with user_id and email if token is valid, None otherwise
    """
    token_record = await VerificationRepository.get_valid_token(token)

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


async def mark_email_verification_token_as_used(token: str) -> bool:
    """
    Mark an email verification token as used

    Args:
        token: Email verification token

    Returns:
        True if token was marked as used, False otherwise
    """
    return await VerificationRepository.mark_token_used(token)
