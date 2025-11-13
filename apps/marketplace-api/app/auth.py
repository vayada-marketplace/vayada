"""
Authentication utilities
"""
import bcrypt
from typing import Optional


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

