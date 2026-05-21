"""At-rest encryption for third-party integration credentials.

We store per-hotel API keys (e.g. Lodgify) in plain Postgres columns
which means rest-encryption is our responsibility, not the database's.
Fernet gives authenticated symmetric encryption with a fixed key — no
key-derivation, no per-row salt to track — which is the right level of
ceremony for credentials that the server itself needs to use on every
outbound API call.

The Fernet key is read lazily from ``INTEGRATION_SECRETS_KEY`` on first
use, not at import time. Test environments that never call the helper
don't need the env var set, and the missing-key error fires only at
the call site that actually wants to encrypt.

Key rotation is deferred — when we need it, swap to ``MultiFernet``
with the new key first in the list. Not building that yet.
"""

import os
from functools import lru_cache

from cryptography.fernet import Fernet, InvalidToken

_ENV_VAR = "INTEGRATION_SECRETS_KEY"


class IntegrationSecretError(Exception):
    """Raised on configuration or decryption failures. Surfaces as a
    500 to admin callers — never to guests."""


@lru_cache(maxsize=1)
def _fernet() -> Fernet:
    key = os.environ.get(_ENV_VAR, "").strip()
    if not key:
        raise IntegrationSecretError(
            f"{_ENV_VAR} is not configured; cannot encrypt integration credentials"
        )
    try:
        return Fernet(key.encode("utf-8"))
    except (ValueError, TypeError) as exc:
        raise IntegrationSecretError(
            f"{_ENV_VAR} is not a valid Fernet key (expected urlsafe base64, 32 bytes pre-encoding)"
        ) from exc


def encrypt(plaintext: str) -> str:
    if not isinstance(plaintext, str):
        raise IntegrationSecretError("encrypt() requires a string")
    token = _fernet().encrypt(plaintext.encode("utf-8"))
    return token.decode("utf-8")


def decrypt(token: str) -> str:
    if not isinstance(token, str):
        raise IntegrationSecretError("decrypt() requires a string")
    try:
        plaintext = _fernet().decrypt(token.encode("utf-8"))
    except InvalidToken as exc:
        raise IntegrationSecretError("integration secret failed to decrypt") from exc
    return plaintext.decode("utf-8")
