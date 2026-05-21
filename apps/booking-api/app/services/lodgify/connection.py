"""Lodgify connect / disconnect / status flow.

Connect is the one place where we touch Lodgify synchronously from a
user-facing request — validating the key by listing properties before
we persist anything. Everything else (rates, availability, booking
write-back) will run from background jobs that this row enables.
"""

import logging
from datetime import UTC, datetime

from app.database import Database
from app.integration_secrets import encrypt
from app.models.lodgify import LodgifyConnectionStatus
from app.repositories.lodgify_connection_repo import LodgifyConnectionRepository
from app.services.lodgify.client import LodgifyAPIError, LodgifyAuthError, LodgifyClient

logger = logging.getLogger(__name__)


class LodgifyConnectError(Exception):
    """User-actionable failure during connect — surfaced verbatim to
    the admin UI as a 4xx so the property owner can fix the input
    (wrong key, wrong property id, etc.)."""

    def __init__(self, message: str, *, status_code: int = 422):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


async def connect_lodgify(
    hotel_id: str,
    *,
    api_key: str,
    lodgify_property_id: str,
) -> LodgifyConnectionStatus:
    """Validate the key against Lodgify, persist the encrypted key,
    flip booking_hotels.pms_type to 'lodgify'. Anything that goes
    wrong before persistence raises LodgifyConnectError so the row
    is never written half-configured."""

    client = LodgifyClient(api_key=api_key, hotel_id=hotel_id)

    try:
        properties = await client.get("/v2/properties")
    except LodgifyAuthError as exc:
        raise LodgifyConnectError("Invalid Lodgify API key") from exc
    except LodgifyAPIError as exc:
        raise LodgifyConnectError(
            f"Lodgify rejected the validation request (status {exc.status_code})",
            status_code=502,
        ) from exc

    match = _find_property(properties, lodgify_property_id)
    if match is None:
        raise LodgifyConnectError(
            "The Lodgify property id is not visible to this API key. "
            "Check the property id and key scope in Lodgify."
        )

    encrypted = encrypt(api_key)
    row = await LodgifyConnectionRepository.upsert(
        hotel_id=hotel_id,
        api_key_encrypted=encrypted,
        lodgify_property_id=lodgify_property_id,
        lodgify_property_name=match.get("name") or "",
        last_validated_at=datetime.now(UTC),
    )
    await Database.execute(
        "UPDATE booking_hotels SET pms_type = 'lodgify', updated_at = now() WHERE id = $1",
        hotel_id,
    )

    return _row_to_status(row)


async def disconnect_lodgify(hotel_id: str) -> None:
    """Soft-disconnect: keep the row for audit, clear the key so it
    can't be re-used. We deliberately do NOT flip pms_type back —
    flipping a hotel from Lodgify to Vayada-native is a separate
    migration concern (out of scope per VAY-398)."""
    await LodgifyConnectionRepository.mark_disconnected(hotel_id)


async def get_lodgify_status(hotel_id: str) -> LodgifyConnectionStatus:
    row = await LodgifyConnectionRepository.get_by_hotel_id(hotel_id)
    if not row:
        return LodgifyConnectionStatus(connected=False)
    return _row_to_status(row)


def _find_property(payload, lodgify_property_id: str) -> dict | None:
    """Lodgify's /v2/properties returns either a list or an envelope
    around a list depending on key configuration — defensively accept
    either, ignore anything else."""
    items = []
    if isinstance(payload, list):
        items = payload
    elif isinstance(payload, dict):
        for key in ("items", "data", "properties"):
            value = payload.get(key)
            if isinstance(value, list):
                items = value
                break

    for item in items:
        if not isinstance(item, dict):
            continue
        if str(item.get("id")) == str(lodgify_property_id):
            return item
    return None


def _row_to_status(row: dict) -> LodgifyConnectionStatus:
    return LodgifyConnectionStatus(
        connected=row["status"] == "active",
        status=row["status"],
        lodgify_property_id=row.get("lodgify_property_id"),
        lodgify_property_name=row.get("lodgify_property_name") or None,
        last_validated_at=row.get("last_validated_at"),
        last_error=row.get("last_error"),
    )
