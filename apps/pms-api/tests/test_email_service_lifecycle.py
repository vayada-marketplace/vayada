"""Unit tests for the host/ops booking-request lifecycle email renderer."""

from unittest.mock import AsyncMock, patch

import pytest
from app.services import email_service
from app.services.email_service import (
    _render_request_status_email,
    send_booking_request_notification,
    send_host_booking_accepted,
    send_host_booking_expired,
    send_host_booking_rejected,
    send_host_booking_withdrawn,
    send_host_guest_cancelled,
)

BOOKING = {
    "id": "booking-uuid-1",
    "booking_reference": "VAY-ABC123",
    "hotel_name": "Hotel Sunshine",
    "hotel_slug": "hotel-sunshine",
    "guest_first_name": "Alice",
    "guest_last_name": "Smith",
    "guest_email": "alice@example.com",
    "payment_method": "card",
    "room_name": "Deluxe Suite",
    "check_in": "2026-06-01",
    "check_out": "2026-06-04",
    "adults": 2,
    "children": 1,
    "addon_names": ["Breakfast", "Airport pickup"],
    "currency": "USD",
    "total_amount": 450.00,
}


def _shared_assertions(subject: str, html: str, expected_headline: str):
    """Every status email must contain the canonical detail block."""
    assert expected_headline in html
    assert f"<h2>{expected_headline}</h2>" in html
    assert "Hotel Sunshine" in html
    assert "Alice Smith" in html
    assert "alice@example.com" in html
    assert "Card (authorization hold)" in html
    assert "VAY-ABC123" in html
    assert "Deluxe Suite" in html
    assert "2026-06-01" in html
    assert "2026-06-04" in html
    assert "2 adults, 1 children" in html
    assert "Breakfast, Airport pickup" in html
    assert "USD 450.0" in html


def test_render_pending_has_full_structure_and_24h_alert():
    subject, html = _render_request_status_email(BOOKING, "pending")
    assert subject == "New Booking Request: Hotel Sunshine — VAY-ABC123"
    _shared_assertions(subject, html, "New Booking Request")
    assert "24 hours" in html
    assert "Review &amp; Respond" in html


def test_render_accepted():
    subject, html = _render_request_status_email(BOOKING, "accepted")
    assert subject == "Booking Confirmed: Hotel Sunshine — VAY-ABC123"
    _shared_assertions(subject, html, "Booking Confirmed")
    assert "Payment has been captured" in html


def test_render_accepted_pay_at_property():
    booking = {**BOOKING, "payment_method": "pay_at_property"}
    _, html = _render_request_status_email(booking, "accepted")
    assert "guest will pay at the property" in html.lower()
    assert "Pay at property" in html


def test_render_declined():
    subject, html = _render_request_status_email(BOOKING, "declined")
    assert subject == "Booking Request Declined: Hotel Sunshine — VAY-ABC123"
    _shared_assertions(subject, html, "Booking Request Declined")
    assert "declined the request" in html.lower()


def test_render_cancelled():
    subject, html = _render_request_status_email(BOOKING, "cancelled")
    assert subject == "Booking Request Cancelled: Hotel Sunshine — VAY-ABC123"
    _shared_assertions(subject, html, "Booking Request Cancelled")
    assert "available for new bookings" in html


def test_render_expired():
    subject, html = _render_request_status_email(BOOKING, "expired")
    assert subject == "Booking Request Expired: Hotel Sunshine — VAY-ABC123"
    _shared_assertions(subject, html, "Booking Request Expired")
    assert "24 hours" in html


def test_render_unknown_status_raises():
    with pytest.raises(ValueError):
        _render_request_status_email(BOOKING, "bogus")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "sender,expected_headline",
    [
        (send_booking_request_notification, "New Booking Request"),
        (send_host_booking_accepted, "Booking Confirmed"),
        (send_host_booking_rejected, "Booking Request Declined"),
        (send_host_booking_withdrawn, "Booking Request Cancelled"),
        (send_host_guest_cancelled, "Booking Request Cancelled"),
        (send_host_booking_expired, "Booking Request Expired"),
    ],
)
async def test_host_emails_cc_ops_recipients(sender, expected_headline):
    """Every host-facing lifecycle email must be CC'd to the Vayada ops list."""
    sent = []

    async def fake_send(to, subject, html_body):
        sent.append((to, subject, html_body))

    with (
        patch.object(email_service, "_send_email", side_effect=fake_send),
        patch.object(email_service.settings, "VAYADA_OPS_EMAIL", "ops@vayada.com"),
    ):
        if sender is send_host_booking_rejected:
            await sender("host@example.com", BOOKING, reason="No availability")
        else:
            await sender("host@example.com", BOOKING)

    recipients = [to for (to, _s, _h) in sent]
    assert "host@example.com" in recipients
    assert "ops@vayada.com" in recipients
    assert "p.paetzold@vayada.com" in recipients
    assert "t.schreyer@vayada.com" in recipients
    # Same body delivered to every recipient
    bodies = {html for (_t, _s, html) in sent}
    assert len(bodies) == 1
    assert f"<h2>{expected_headline}</h2>" in bodies.pop()


@pytest.mark.asyncio
async def test_no_duplicate_when_host_email_matches_ops_email():
    """If the hotel contact_email is the same as an ops recipient, don't double-send."""
    sent = []

    async def fake_send(to, subject, html_body):
        sent.append(to)

    with (
        patch.object(email_service, "_send_email", side_effect=fake_send),
        patch.object(email_service.settings, "VAYADA_OPS_EMAIL", "host@example.com"),
    ):
        await send_booking_request_notification("host@example.com", BOOKING)

    # host@example.com appears exactly once (deduplicated against ops list)
    assert sent.count("host@example.com") == 1


@pytest.mark.asyncio
async def test_missing_hotel_email_still_sends_to_ops():
    sent = []

    async def fake_send(to, subject, html_body):
        sent.append(to)

    with (
        patch.object(email_service, "_send_email", side_effect=fake_send),
        patch.object(email_service.settings, "VAYADA_OPS_EMAIL", "ops@vayada.com"),
    ):
        await send_booking_request_notification("", BOOKING)

    assert "" not in sent
    assert "ops@vayada.com" in sent
