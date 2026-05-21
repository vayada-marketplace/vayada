"""Round-trip + misuse tests for the integration-credential cipher."""

import importlib
import os

import pytest
from cryptography.fernet import Fernet


@pytest.fixture
def configured_cipher(monkeypatch):
    """Set a fresh Fernet key and reload the module so the lru_cache
    inside _fernet() doesn't leak across tests."""
    monkeypatch.setenv("INTEGRATION_SECRETS_KEY", Fernet.generate_key().decode())
    import app.integration_secrets as mod

    importlib.reload(mod)
    yield mod
    importlib.reload(mod)  # leave cache clean for the next test


def test_encrypt_decrypt_round_trip(configured_cipher):
    plaintext = "lodgify-api-key-abc123"
    token = configured_cipher.encrypt(plaintext)

    assert token != plaintext
    assert configured_cipher.decrypt(token) == plaintext


def test_two_encrypts_yield_different_ciphertexts(configured_cipher):
    """Fernet embeds a random IV, so identical plaintexts encrypt to
    distinct tokens — protects us from leaking equality of stored keys."""
    plaintext = "lodgify-api-key-abc123"
    assert configured_cipher.encrypt(plaintext) != configured_cipher.encrypt(plaintext)


def test_missing_env_var_raises(monkeypatch):
    monkeypatch.delenv("INTEGRATION_SECRETS_KEY", raising=False)
    import app.integration_secrets as mod

    importlib.reload(mod)
    with pytest.raises(mod.IntegrationSecretError):
        mod.encrypt("anything")
    importlib.reload(mod)


def test_invalid_key_raises(monkeypatch):
    monkeypatch.setenv("INTEGRATION_SECRETS_KEY", "not-a-fernet-key")
    import app.integration_secrets as mod

    importlib.reload(mod)
    with pytest.raises(mod.IntegrationSecretError):
        mod.encrypt("anything")
    importlib.reload(mod)


def test_garbage_token_fails_to_decrypt(configured_cipher):
    with pytest.raises(configured_cipher.IntegrationSecretError):
        configured_cipher.decrypt("not-a-real-token")
