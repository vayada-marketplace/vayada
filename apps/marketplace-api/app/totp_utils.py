"""
TOTP utilities: secret generation, AES encryption, code verification,
and recovery code generation.
"""

import base64
import secrets

import bcrypt
import pyotp
from cryptography.fernet import Fernet

from app.config import settings

TOTP_ISSUER = "Vayada Admin"
RECOVERY_CODE_COUNT = 10


def _fernet() -> Fernet:
    key_bytes = bytes.fromhex(settings.TOTP_ENCRYPTION_KEY)
    return Fernet(base64.urlsafe_b64encode(key_bytes))


def generate_totp_secret() -> str:
    return pyotp.random_base32()


def encrypt_secret(secret: str) -> str:
    return _fernet().encrypt(secret.encode()).decode()


def decrypt_secret(ciphertext: str) -> str:
    return _fernet().decrypt(ciphertext.encode()).decode()


def get_totp_uri(secret: str, email: str) -> str:
    return pyotp.TOTP(secret).provisioning_uri(name=email, issuer_name=TOTP_ISSUER)


def verify_totp_code(secret: str, code: str) -> bool:
    return pyotp.TOTP(secret).verify(code, valid_window=1)


def generate_recovery_codes() -> list[str]:
    """Generate RECOVERY_CODE_COUNT codes in XXXXXX-XXXXXX format."""
    return [f"{secrets.token_hex(3)}-{secrets.token_hex(3)}" for _ in range(RECOVERY_CODE_COUNT)]


def hash_recovery_code(code: str) -> str:
    return bcrypt.hashpw(code.encode(), bcrypt.gensalt()).decode()


def verify_recovery_code(code: str, hashed: str) -> bool:
    return bcrypt.checkpw(code.encode(), hashed.encode())
