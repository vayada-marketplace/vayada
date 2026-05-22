"""
JWT token utilities
"""

from datetime import UTC, datetime, timedelta

import jwt

from app.config import settings


def create_access_token(data: dict, expires_delta: timedelta | None = None) -> str:
    to_encode = data.copy()

    if expires_delta:
        expire = datetime.now(UTC) + expires_delta
    else:
        expire = datetime.now(UTC) + timedelta(minutes=settings.JWT_ACCESS_TOKEN_EXPIRE_MINUTES)

    to_encode.update({"exp": expire, "iat": datetime.now(UTC)})

    encoded_jwt = jwt.encode(to_encode, settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM)

    return encoded_jwt


def decode_access_token(token: str) -> dict | None:
    try:
        payload = jwt.decode(token, settings.JWT_SECRET_KEY, algorithms=[settings.JWT_ALGORITHM])
        return payload
    except jwt.ExpiredSignatureError:
        return None
    except jwt.InvalidTokenError:
        return None


def get_token_expiration_seconds() -> int:
    return settings.JWT_ACCESS_TOKEN_EXPIRE_MINUTES * 60


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
    try:
        payload = jwt.decode(token, options={"verify_signature": False})
        exp = payload.get("exp")
        if exp:
            expire_dt = datetime.fromtimestamp(exp, tz=UTC)
            return datetime.now(UTC) >= expire_dt
        return None
    except Exception:
        return None
