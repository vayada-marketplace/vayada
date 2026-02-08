"""
Authentication utilities
"""
import bcrypt
import secrets
from typing import Optional
from datetime import datetime, timedelta, timezone


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
    from app.database import AuthDatabase

    user = await AuthDatabase.fetchrow(
        "SELECT * FROM users WHERE email = $1",
        email
    )
    return dict(user) if user else None


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
    from app.database import AuthDatabase

    token = generate_password_reset_token()
    expires_at = datetime.now(timezone.utc) + timedelta(hours=expires_in_hours)

    await AuthDatabase.execute(
        """
        INSERT INTO password_reset_tokens (user_id, token, expires_at)
        VALUES ($1, $2, $3)
        """,
        user_id,
        token,
        expires_at
    )

    return token


async def validate_password_reset_token(token: str) -> Optional[dict]:
    """
    Validate a password reset token

    Args:
        token: Password reset token

    Returns:
        Dictionary with user_id if token is valid, None otherwise
    """
    from app.database import AuthDatabase

    token_record = await AuthDatabase.fetchrow(
        """
        SELECT prt.id, prt.user_id, prt.expires_at, prt.used, u.email, u.status
        FROM password_reset_tokens prt
        JOIN users u ON u.id = prt.user_id
        WHERE prt.token = $1
        """,
        token
    )

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
    from app.database import AuthDatabase

    result = await AuthDatabase.execute(
        """
        UPDATE password_reset_tokens
        SET used = true
        WHERE token = $1 AND used = false
        """,
        token
    )

    return result == "UPDATE 1"
