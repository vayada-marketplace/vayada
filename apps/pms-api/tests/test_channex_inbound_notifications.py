"""Tests for the OTA-booking host notification gating wired into the
Channex inbound pipeline (VAY-315).

Both toggles (master ``email_notifications`` AND ``ota_booking_alerts``)
must be true in booking_db before the email is sent.
"""

from unittest.mock import AsyncMock, patch

import pytest
from app.services.channex.inbound import _maybe_notify_ota_booking
from app.services.email_service import (
    _ota_channel_label,
    send_host_ota_booking_imported,
)

# ── Channel-label helper ──────────────────────────────────────────────


def test_channel_label_known_aliases():
    assert _ota_channel_label("airbnb") == "Airbnb"
    assert _ota_channel_label("Booking.com") == "Booking.com"
    assert _ota_channel_label("booking_com") == "Booking.com"
    assert _ota_channel_label("expedia") == "Expedia"


def test_channel_label_falls_back_to_generic_ota():
    # Per ticket: when Channex doesn't send a recognizable channel name,
    # use the generic label "OTA".
    assert _ota_channel_label("") == "OTA"
    assert _ota_channel_label(None) == "OTA"
    assert _ota_channel_label("channex") == "OTA"


def test_channel_label_titlecases_unknown_value():
    # Unknown but non-empty channels are still surfaced — beats showing
    # ``snake_case`` to hoteliers.
    assert _ota_channel_label("my_new_ota") == "My New Ota"


# ── Toggle gating ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_notify_skipped_when_master_off(monkeypatch):
    monkeypatch.setattr(
        "app.services.channex.inbound.app_settings.BOOKING_ENGINE_DATABASE_URL",
        "postgres://stub",
    )
    with (
        patch(
            "app.services.channex.inbound.BookingEngineDatabase.fetchrow",
            new_callable=AsyncMock,
            return_value={
                "email_notifications": False,
                "ota_booking_alerts": True,
                "contact_email": "host@example.com",
            },
        ),
        patch(
            "app.services.channex.inbound.BookingRepository.get_by_id",
            new_callable=AsyncMock,
        ) as get_booking,
        patch(
            "app.services.channex.inbound.send_host_ota_booking_imported",
            new_callable=AsyncMock,
        ) as send,
    ):
        await _maybe_notify_ota_booking("hotel-A", "booking-1", event="imported")
        send.assert_not_called()
        get_booking.assert_not_called()


@pytest.mark.asyncio
async def test_notify_skipped_when_ota_toggle_off(monkeypatch):
    monkeypatch.setattr(
        "app.services.channex.inbound.app_settings.BOOKING_ENGINE_DATABASE_URL",
        "postgres://stub",
    )
    with (
        patch(
            "app.services.channex.inbound.BookingEngineDatabase.fetchrow",
            new_callable=AsyncMock,
            return_value={
                "email_notifications": True,
                "ota_booking_alerts": False,
                "contact_email": "host@example.com",
            },
        ),
        patch(
            "app.services.channex.inbound.send_host_ota_booking_imported",
            new_callable=AsyncMock,
        ) as send,
    ):
        await _maybe_notify_ota_booking("hotel-A", "booking-1", event="imported")
        send.assert_not_called()


@pytest.mark.asyncio
async def test_notify_sent_when_both_toggles_on(monkeypatch):
    monkeypatch.setattr(
        "app.services.channex.inbound.app_settings.BOOKING_ENGINE_DATABASE_URL",
        "postgres://stub",
    )
    booking = {
        "id": "booking-1",
        "channel": "airbnb",
        "guest_first_name": "Sue",
        "guest_last_name": "Puls",
        "booking_reference": "REF-1",
        "room_name": "Garden Suite",
        "hotel_name": "Villa Sava",
        "hotel_slug": "villa-sava",
        "check_in": "2026-10-08",
        "check_out": "2026-10-12",
        "adults": 2,
        "children": 0,
        "currency": "IDR",
        "total_amount": 4_000_000,
    }
    with (
        patch(
            "app.services.channex.inbound.BookingEngineDatabase.fetchrow",
            new_callable=AsyncMock,
            return_value={
                "email_notifications": True,
                "ota_booking_alerts": True,
                "contact_email": "fallback@example.com",
            },
        ),
        patch(
            "app.services.channex.inbound.BookingRepository.get_by_id",
            new_callable=AsyncMock,
            return_value=booking,
        ),
        patch(
            "app.services.channex.inbound.Database.fetchrow",
            new_callable=AsyncMock,
            return_value={"contact_email": "host@example.com"},
        ),
        patch(
            "app.services.channex.inbound.send_host_ota_booking_imported",
            new_callable=AsyncMock,
        ) as send,
    ):
        await _maybe_notify_ota_booking("hotel-A", "booking-1", event="imported")
        send.assert_awaited_once()
        # Recipient comes from the PMS hotels row (preferred over booking_db).
        assert send.await_args.args[0] == "host@example.com"
        assert send.await_args.kwargs["event"] == "imported"


@pytest.mark.asyncio
async def test_notify_falls_back_to_booking_db_email(monkeypatch):
    """If the PMS hotels row has no contact_email, fall back to booking_db."""
    monkeypatch.setattr(
        "app.services.channex.inbound.app_settings.BOOKING_ENGINE_DATABASE_URL",
        "postgres://stub",
    )
    with (
        patch(
            "app.services.channex.inbound.BookingEngineDatabase.fetchrow",
            new_callable=AsyncMock,
            return_value={
                "email_notifications": True,
                "ota_booking_alerts": True,
                "contact_email": "fallback@example.com",
            },
        ),
        patch(
            "app.services.channex.inbound.BookingRepository.get_by_id",
            new_callable=AsyncMock,
            return_value={"id": "booking-1", "channel": "airbnb"},
        ),
        patch(
            "app.services.channex.inbound.Database.fetchrow",
            new_callable=AsyncMock,
            return_value={"contact_email": ""},
        ),
        patch(
            "app.services.channex.inbound.send_host_ota_booking_imported",
            new_callable=AsyncMock,
        ) as send,
    ):
        await _maybe_notify_ota_booking("hotel-A", "booking-1", event="imported")
        send.assert_awaited_once()
        assert send.await_args.args[0] == "fallback@example.com"


@pytest.mark.asyncio
async def test_notify_no_op_without_booking_db_url(monkeypatch):
    """Tests / dev environments without BOOKING_ENGINE_DATABASE_URL must
    silently skip — never crash the inbound import."""
    monkeypatch.setattr(
        "app.services.channex.inbound.app_settings.BOOKING_ENGINE_DATABASE_URL",
        "",
    )
    with (
        patch(
            "app.services.channex.inbound.BookingEngineDatabase.fetchrow",
            new_callable=AsyncMock,
        ) as fetch,
        patch(
            "app.services.channex.inbound.send_host_ota_booking_imported",
            new_callable=AsyncMock,
        ) as send,
    ):
        await _maybe_notify_ota_booking("hotel-A", "booking-1", event="imported")
        fetch.assert_not_called()
        send.assert_not_called()


# ── Email composition (subject lines) ─────────────────────────────────


@pytest.mark.asyncio
async def test_imported_subject_contains_channel_and_guest():
    sent = {}

    async def fake_send(to, subject, body):
        sent["to"] = to
        sent["subject"] = subject

    with patch("app.services.email_service._send_email", new=fake_send):
        await send_host_ota_booking_imported(
            "host@example.com",
            {
                "id": "b-1",
                "channel": "booking_com",
                "guest_first_name": "John",
                "guest_last_name": "Smith",
                "booking_reference": "REF-1",
                "room_name": "Garden Suite",
                "check_in": "2026-10-08",
                "check_out": "2026-10-12",
                "adults": 2,
                "children": 0,
                "currency": "IDR",
                "total_amount": 4_000_000,
            },
            event="imported",
        )
    assert sent["subject"] == "New booking from Booking.com — John Smith"


@pytest.mark.asyncio
async def test_unknown_channel_uses_ota_fallback_in_subject():
    sent = {}

    async def fake_send(to, subject, body):
        sent["subject"] = subject

    with patch("app.services.email_service._send_email", new=fake_send):
        await send_host_ota_booking_imported(
            "host@example.com",
            {
                "id": "b-1",
                "channel": "channex",  # generic / unknown source
                "guest_first_name": "Jane",
                "guest_last_name": "Doe",
                "booking_reference": "REF-2",
                "room_name": "Deluxe",
                "check_in": "2026-10-08",
                "check_out": "2026-10-09",
                "adults": 1,
                "children": 0,
                "currency": "USD",
                "total_amount": 100,
            },
            event="imported",
        )
    assert sent["subject"] == "New booking from OTA — Jane Doe"


@pytest.mark.asyncio
async def test_modified_and_cancelled_subjects():
    sent = []

    async def fake_send(to, subject, body):
        sent.append(subject)

    base = {
        "id": "b-1",
        "channel": "airbnb",
        "guest_first_name": "Sue",
        "guest_last_name": "Puls",
        "booking_reference": "REF-3",
        "room_name": "Suite",
        "check_in": "2026-10-08",
        "check_out": "2026-10-10",
        "adults": 2,
        "children": 0,
        "currency": "EUR",
        "total_amount": 500,
    }
    with patch("app.services.email_service._send_email", new=fake_send):
        await send_host_ota_booking_imported("h@x", base, event="modified")
        await send_host_ota_booking_imported("h@x", base, event="cancelled")
    assert sent[0] == "OTA booking modified — Airbnb — Sue Puls"
    assert sent[1] == "OTA booking cancelled — Airbnb — Sue Puls"
