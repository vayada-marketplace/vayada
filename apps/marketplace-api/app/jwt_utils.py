"""
JWT token utilities
"""

from datetime import UTC, datetime, timedelta

import jwt

from app.config import settings


def create_access_token(data: dict, expires_delta: timedelta | None = None) -> str:
    """
    Create a JWT access token

    Args:
        data: Dictionary containing user data (e.g., {"sub": user_id, "email": email})
        expires_delta: Optional timedelta for token expiration. If None, uses default from settings.

    Returns:
        Encoded JWT token string
    """
    to_encode = data.copy()

    if expires_delta:
        expire = datetime.now(UTC) + expires_delta
    else:
        expire = datetime.now(UTC) + timedelta(minutes=settings.JWT_ACCESS_TOKEN_EXPIRE_MINUTES)

    to_encode.update({"exp": expire, "iat": datetime.now(UTC)})

    encoded_jwt = jwt.encode(to_encode, settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM)

    return encoded_jwt


def decode_access_token(token: str) -> dict | None:
    """
    Decode and verify a JWT access token

    Args:
        token: JWT token string

    Returns:
        Decoded token payload as dictionary, or None if invalid/expired
    """
    try:
        payload = jwt.decode(token, settings.JWT_SECRET_KEY, algorithms=[settings.JWT_ALGORITHM])
        return payload
    except jwt.ExpiredSignatureError:
        return None
    except jwt.InvalidTokenError:
        return None


def get_token_expiration_seconds() -> int:
    """
    Get token expiration time in seconds from settings

    Returns:
        Expiration time in seconds
    """
    return settings.JWT_ACCESS_TOKEN_EXPIRE_MINUTES * 60


def get_user_id_from_token(token: str) -> str | None:
    """
    Extract user ID from JWT token

    Args:
        token: JWT token string

    Returns:
        User ID string, or None if token is invalid
    """
    payload = decode_access_token(token)
    if payload:
        return payload.get("sub")  # 'sub' is the standard JWT claim for subject (user ID)
    return None


def get_token_expiration(token: str) -> datetime | None:
    """
    Get token expiration time without full validation

    Args:
        token: JWT token string

    Returns:
        Expiration datetime, or None if token is invalid
    """
    try:
        # Decode without verification to get expiration
        payload = jwt.decode(token, options={"verify_signature": False})
        exp = payload.get("exp")
        if exp:
            return datetime.fromtimestamp(exp, tz=UTC)
        return None
    except:
        return None


def create_totp_session_token(user_id: str, email: str, user_type: str) -> str:
    """Short-lived (3 min) token proving password auth passed. Carries totp_pending=True."""
    return create_access_token(
        data={"sub": user_id, "email": email, "type": user_type, "totp_pending": True},
        expires_delta=timedelta(minutes=3),
    )


def decode_totp_session_token(token: str) -> dict | None:
    """Validate a totp_session token. Returns payload only if totp_pending=True."""
    payload = decode_access_token(token)
    if payload and payload.get("totp_pending") is True:
        return payload
    return None


def is_token_expired(token: str) -> bool | None:
    """
    Check if token is expired

    Args:
        token: JWT token string

    Returns:
        True if expired, False if valid and not expired, None if invalid format
    """
    exp = get_token_expiration(token)
    if exp is None:
        return None  # Invalid token format - cannot determine if expired
    # Ensure exp is timezone-aware for comparison
    if exp.tzinfo is None:
        exp = exp.replace(tzinfo=UTC)
    return datetime.now(UTC) >= exp
