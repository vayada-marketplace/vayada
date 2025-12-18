"""
Authentication utilities
"""
import bcrypt
import secrets
from typing import Optional
from datetime import datetime, timedelta


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

