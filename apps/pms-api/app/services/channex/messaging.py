"""Channex multichannel inbox: webhook ingestion + safety-net polling."""
import logging
from datetime import datetime, timezone
from typing import Optional

from app.database import Database
from app.repositories.channex_mapping_repo import ChannexConnectionRepository
from app.repositories.messaging_repo import (
    MessageAttachmentRepository,
    MessageRepository,
    MessageThreadRepository,
)
from app.services import channex_service

logger = logging.getLogger(__name__)


def _normalize_provider(provider: str) -> Optional[str]:
    """Channex returns 'BookingCom' / 'AirBNB' / 'Expedia'. Map to internal keys
    (matches admin_channex._normalize_channex_application convention)."""
    if not provider:
        return None
    p = provider.lower().replace("_", "").replace("-", "").replace(".", "")
    if "booking" in p:
        return "booking.com"
    if "airbnb" in p or "abnb" in p:
        return "airbnb"
    if "expedia" in p:
        return "expedia"
    return "other"


def _direction_from_sender(sender: str) -> str:
    """Channex sender enum: 'guest' (inbound) vs 'property'/host (outbound)."""
    return "inbound" if (sender or "").lower() == "guest" else "outbound"


def _parse_iso(ts: Optional[str]) -> datetime:
    if not ts:
        return datetime.now(timezone.utc)
    if ts.endswith("Z"):
        ts = ts[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(ts)
    except ValueError:
        return datetime.now(timezone.utc)


async def _resolve_booking_id(hotel_id: str, channex_booking_id: Optional[str]) -> Optional[str]:
    if not channex_booking_id:
        return None
    from app.repositories.channex_mapping_repo import ChannexBookingMappingRepository
    mapping = await ChannexBookingMappingRepository.get_by_channex_id(
        hotel_id, channex_booking_id,
    )
    return str(mapping["booking_id"]) if mapping else None


async def _ensure_thread(
    *,
    hotel_id: str,
    channex_thread_id: str,
    channex_property_id: str,
    channex_booking_id: Optional[str] = None,
    seed_attrs: Optional[dict] = None,
) -> dict:
    """Look up or create the local thread row, hydrating from Channex if the
    webhook payload doesn't include enough metadata."""
    existing = await MessageThreadRepository.get_by_source_thread_id(
        "channex", channex_thread_id,
    )
    attrs = seed_attrs or {}
    if not attrs.get("title") or not attrs.get("provider"):
        # Hydrate via API — webhook payloads omit thread-level metadata.
        try:
            api_key = channex_service.get_platform_api_key()
            thread_obj = await channex_service.get_message_thread(api_key, channex_thread_id)
            attrs = {**(thread_obj.get("attributes") or thread_obj), **attrs}
        except Exception as e:
            logger.warning(
                "Failed to fetch Channex thread %s metadata: %s",
                channex_thread_id, e,
            )

    booking_id = await _resolve_booking_id(hotel_id, channex_booking_id)
    return await MessageThreadRepository.upsert_from_source(
        hotel_id=hotel_id,
        source="channex",
        source_thread_id=channex_thread_id,
        channel=_normalize_provider(attrs.get("provider")),
        guest_name=attrs.get("title"),
        guest_email=attrs.get("guest_email"),
        source_booking_id=channex_booking_id,
        booking_id=booking_id,
        status="closed" if attrs.get("is_closed") else (existing or {}).get("status", "open") or "open",
    )


async def _persist_attachments(message_id: str, attachments: list) -> None:
    for att in attachments or []:
        # Channex returns either URL-only objects or {id, links: {url, thumbnail}}
        links = att.get("links") or {}
        url = links.get("url") or att.get("url")
        await MessageAttachmentRepository.add(
            message_id=message_id,
            source_url=url,
            filename=att.get("file_name") or att.get("filename"),
            content_type=att.get("file_type") or att.get("content_type"),
            size_bytes=att.get("size"),
            source_attachment_id=att.get("id"),
        )


async def process_inbound_message_event(payload: dict, top_level: dict) -> None:
    """Handle a single 'message' webhook event from Channex.
    `payload` is the inner `payload` object; `top_level` is the full envelope
    (we use it for property_id fallback)."""
    channex_property_id = (
        payload.get("property_id") or top_level.get("property_id")
    )
    if not channex_property_id:
        logger.warning("Channex message event missing property_id, skipping")
        return

    conn = await ChannexConnectionRepository.get_by_property_id(channex_property_id)
    if not conn:
        logger.warning(
            "Channex message event for unknown property %s, skipping",
            channex_property_id,
        )
        return
    hotel_id = str(conn["hotel_id"])

    channex_thread_id = payload.get("message_thread_id")
    if not channex_thread_id:
        logger.warning("Channex message event missing message_thread_id, skipping")
        return

    thread = await _ensure_thread(
        hotel_id=hotel_id,
        channex_thread_id=channex_thread_id,
        channex_property_id=channex_property_id,
        channex_booking_id=payload.get("booking_id"),
    )

    sent_at = _parse_iso(payload.get("inserted_at") or top_level.get("timestamp"))
    inserted = await MessageRepository.insert_and_update_thread(
        thread_id=str(thread["id"]),
        source_message_id=str(payload["id"]),
        direction=_direction_from_sender(payload.get("sender", "")),
        sender_name=payload.get("sender_name"),
        body=payload.get("message") or "",
        sent_at=sent_at,
        raw_payload=payload,
    )

    if inserted:
        await _persist_attachments(str(inserted["id"]), payload.get("attachments") or [])


async def sync_threads_for_hotel(hotel_id: str) -> None:
    """Safety-net poll: list threads on the property and ingest any messages we
    don't already have. Idempotent via (thread_id, source_message_id) unique
    index."""
    conn = await ChannexConnectionRepository.get_by_hotel_id(hotel_id)
    if not conn or not conn.get("is_active") or not conn.get("messaging_app_installed"):
        return
    if not conn.get("channex_property_id"):
        return

    api_key = channex_service.get_platform_api_key()
    property_id = str(conn["channex_property_id"])

    try:
        threads = await channex_service.list_message_threads(
            api_key, property_id=property_id,
        )
    except Exception as e:
        logger.error("Failed to list Channex threads for hotel %s: %s", hotel_id, e)
        return

    for t in threads:
        attrs = t.get("attributes") or {}
        thread_id = t.get("id")
        if not thread_id:
            continue

        relationships = t.get("relationships") or {}
        booking_rel = (relationships.get("booking") or {}).get("data") or {}
        channex_booking_id = booking_rel.get("id") or attrs.get("booking_id")

        local_thread = await _ensure_thread(
            hotel_id=hotel_id,
            channex_thread_id=thread_id,
            channex_property_id=property_id,
            channex_booking_id=channex_booking_id,
            seed_attrs=attrs,
        )

        try:
            messages = await channex_service.list_thread_messages(api_key, thread_id)
        except Exception as e:
            logger.warning("Failed to list messages for thread %s: %s", thread_id, e)
            continue

        for m in messages:
            m_attrs = m.get("attributes") or {}
            inserted = await MessageRepository.insert_and_update_thread(
                thread_id=str(local_thread["id"]),
                source_message_id=str(m["id"]),
                direction=_direction_from_sender(m_attrs.get("sender", "")),
                sender_name=m_attrs.get("sender_name"),
                body=m_attrs.get("message") or "",
                sent_at=_parse_iso(m_attrs.get("inserted_at")),
                raw_payload=m_attrs,
            )
            if inserted:
                await _persist_attachments(
                    str(inserted["id"]), m_attrs.get("attachments") or [],
                )

    await ChannexConnectionRepository.update_last_message_sync(
        hotel_id, datetime.now(timezone.utc),
    )


async def poll_messages_for_all_hotels() -> None:
    """Scheduler entrypoint."""
    rows = await ChannexConnectionRepository.list_with_messaging()
    for conn in rows:
        try:
            await sync_threads_for_hotel(str(conn["hotel_id"]))
        except Exception as e:
            logger.error(
                "Channex message sync failed for hotel %s: %s",
                conn["hotel_id"], e,
            )
