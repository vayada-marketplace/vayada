"""
Authentication utilities
"""
import bcrypt
import secrets
import random
from typing import Optional
from datetime import datetime, timedelta, timezone


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
    from app.database import Database
    
    user = await Database.fetchrow(
        "SELECT * FROM users WHERE email = $1",
        email
    )
    return dict(user) if user else None


async def create_user(email: str, password_hash: str, user_type: str, name: Optional[str] = None) -> dict:
    """Create a new user in the database"""
    from app.database import Database
    
    # Use email as name if not provided
    if not name:
        name = email.split('@')[0]  # Use part before @ as default name
    
    user = await Database.fetchrow(
        """
        INSERT INTO users (email, password_hash, name, type, status)
        VALUES ($1, $2, $3, $4, 'pending')
        RETURNING *
        """,
        email,
        password_hash,
        name,
        user_type
    )
    return dict(user)


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
    from app.database import Database
    
    token = generate_password_reset_token()
    expires_at = datetime.utcnow() + timedelta(hours=expires_in_hours)
    
    await Database.execute(
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
    from app.database import Database
    
    # Get token from database
    token_record = await Database.fetchrow(
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
    
    # Check if token is used
    if token_record['used']:
        return None
    
    # Check if token is expired
    if datetime.utcnow() > token_record['expires_at']:
        return None
    
    # Check if user account is suspended
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
    from app.database import Database
    
    result = await Database.execute(
        """
        UPDATE password_reset_tokens
        SET used = true
        WHERE token = $1 AND used = false
        """,
        token
    )
    
    return result == "UPDATE 1"


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
    from app.database import Database
    
    code = generate_email_verification_code()
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=expires_in_minutes)
    
    # Invalidate any existing unused codes for this email
    await Database.execute(
        """
        UPDATE email_verification_codes
        SET used = true
        WHERE email = $1 AND used = false AND expires_at > now()
        """,
        email
    )
    
    # Insert new code
    await Database.execute(
        """
        INSERT INTO email_verification_codes (email, code, expires_at)
        VALUES ($1, $2, $3)
        """,
        email,
        code,
        expires_at
    )
    
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
    from app.database import Database
    
    # Get the most recent unused code for this email
    code_record = await Database.fetchrow(
        """
        SELECT id, expires_at, used
        FROM email_verification_codes
        WHERE email = $1 AND code = $2 AND used = false
        ORDER BY created_at DESC
        LIMIT 1
        """,
        email,
        code
    )
    
    if not code_record:
        return False
    
    # Check if code is expired
    if datetime.now(timezone.utc) > code_record['expires_at']:
        return False
    
    # Mark code as used
    await Database.execute(
        """
        UPDATE email_verification_codes
        SET used = true
        WHERE id = $1
        """,
        code_record['id']
    )
    
    return True


async def mark_email_as_verified(email: str) -> bool:
    """
    Mark a user's email as verified
    
    Args:
        email: Email address to mark as verified
    
    Returns:
        True if email was marked as verified, False otherwise
    """
    from app.database import Database
    
    result = await Database.execute(
        """
        UPDATE users
        SET email_verified = true
        WHERE email = $1
        """,
        email
    )
    
    return result == "UPDATE 1"

