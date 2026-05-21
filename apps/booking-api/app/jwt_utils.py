"""
JWT token utilities
"""
from datetime import datetime, timedelta, timezone
from typing import Optional, Dict
import jwt
from app.config import settings


def create_access_token(data: Dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()

    if expires_delta:
        expire = datetime.now(timezone.utc) + expires_delta
    else:
        expire = datetime.now(timezone.utc) + timedelta(minutes=settings.JWT_ACCESS_TOKEN_EXPIRE_MINUTES)

    to_encode.update({"exp": expire, "iat": datetime.now(timezone.utc)})

    encoded_jwt = jwt.encode(
        to_encode,
        settings.JWT_SECRET_KEY,
        algorithm=settings.JWT_ALGORITHM
    )

    return encoded_jwt


def decode_access_token(token: str) -> Optional[Dict]:
    try:
        payload = jwt.decode(
            token,
            settings.JWT_SECRET_KEY,
            algorithms=[settings.JWT_ALGORITHM]
        )
        return payload
    except jwt.ExpiredSignatureError:
        return None
    except jwt.InvalidTokenError:
        return None


def get_token_expiration_seconds() -> int:
    return settings.JWT_ACCESS_TOKEN_EXPIRE_MINUTES * 60


def is_token_expired(token: str) -> Optional[bool]:
    try:
        payload = jwt.decode(
            token,
            options={"verify_signature": False}
        )
        exp = payload.get("exp")
        if exp:
            expire_dt = datetime.fromtimestamp(exp, tz=timezone.utc)
            return datetime.now(timezone.utc) >= expire_dt
        return None
    except Exception:
        return None
