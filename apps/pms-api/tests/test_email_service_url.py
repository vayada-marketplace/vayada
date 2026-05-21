"""Unit tests for the guest booking email URL helpers."""

from app.services.email_service import _my_booking_url


def test_my_booking_url_includes_url_encoded_email():
    booking = {"hotel_slug": "zenaralombok", "booking_reference": "VAY-KNSS8B"}
    url = _my_booking_url(booking, "guest+test@example.com")
    assert url is not None
    assert url.endswith("/booking/VAY-KNSS8B?email=guest%2Btest%40example.com")
    assert "zenaralombok." in url


def test_my_booking_url_without_email_has_no_query():
    booking = {"hotel_slug": "zenaralombok", "booking_reference": "VAY-KNSS8B"}
    url = _my_booking_url(booking)
    assert url is not None
    assert "?" not in url
    assert url.endswith("/booking/VAY-KNSS8B")


def test_my_booking_url_returns_none_when_required_fields_missing():
    assert _my_booking_url({"hotel_slug": "x"}, "a@b.com") is None
    assert _my_booking_url({"booking_reference": "VAY-1"}, "a@b.com") is None
