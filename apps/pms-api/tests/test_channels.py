"""Tests for channel alias normalization (VAY-350).

The PMS Calendar / source filters / reports key off a single canonical
key per OTA. Channex sends the raw ``ota_name`` in inconsistent forms;
``app.channels`` collapses those onto the canonical key so consumers
don't each re-implement the alias table.
"""

import pytest
from app.channels import channel_label, is_ota_channel, normalize_channel

# ── normalize_channel ─────────────────────────────────────────────────


@pytest.mark.parametrize(
    "raw, expected",
    [
        # All Booking.com aliases collapse onto the canonical key
        ("Booking.com", "booking.com"),
        ("booking.com", "booking.com"),
        ("BOOKING.COM", "booking.com"),
        ("booking_com", "booking.com"),
        ("BookingCom", "booking.com"),
        ("bookingcom", "booking.com"),
        ("booking", "booking.com"),
        # Whitespace tolerance
        ("  Booking.com  ", "booking.com"),
        # Other major OTAs pass through canonically
        ("Airbnb", "airbnb"),
        ("airbnb", "airbnb"),
        ("Expedia", "expedia"),
        ("expedia.com", "expedia"),
        ("Agoda", "agoda"),
        # PMS-native + sentinel are preserved
        ("direct", "direct"),
        ("Direct", "direct"),
        # Empty / missing input falls back to the legacy ``channex``
        # sentinel rather than dropping the booking on the floor
        (None, "channex"),
        ("", "channex"),
        ("   ", "channex"),
        # Unknown OTAs are passed through lowercased so future entries
        # surface to operators without a code change
        ("MyNewOta", "mynewota"),
    ],
)
def test_normalize_channel(raw, expected):
    assert normalize_channel(raw) == expected


# ── channel_label (host-notification labels) ──────────────────────────


@pytest.mark.parametrize(
    "raw, expected",
    [
        # Aliases all resolve to the brand label
        ("Booking.com", "Booking.com"),
        ("booking_com", "Booking.com"),
        ("bookingcom", "Booking.com"),
        ("booking", "Booking.com"),
        ("airbnb", "Airbnb"),
        ("Expedia", "Expedia"),
        # Direct / channex / missing all collapse to the generic "OTA"
        # label per the original VAY-315 spec — hosts shouldn't see the
        # internal ``channex`` sentinel
        ("direct", "OTA"),
        ("channex", "OTA"),
        ("", "OTA"),
        (None, "OTA"),
        # Unknown but non-sentinel sources surface as a tidy title-cased
        # form rather than snake_case
        ("my_new_ota", "My New Ota"),
    ],
)
def test_channel_label(raw, expected):
    assert channel_label(raw) == expected


# ── is_ota_channel (VAY-490 — externally-settled invoices) ────────────


@pytest.mark.parametrize(
    "raw, expected",
    [
        # OTA channels — externally settled
        ("airbnb", True),
        ("Airbnb", True),
        ("booking.com", True),
        ("Booking.com", True),
        ("booking_com", True),
        ("booking", True),
        ("expedia", True),
        ("agoda", True),
        ("vrbo", True),
        ("hostelworld", True),
        ("tripadvisor", True),
        ("hotels.com", True),
        # Fallback for unknown OTA names from Channex — still externally settled
        ("channex", True),
        # PMS-native / unknown sources are not OTA-settled
        ("direct", False),
        ("Direct", False),
        ("", False),
        (None, False),
        ("some_unknown_pos", False),
    ],
)
def test_is_ota_channel(raw, expected):
    assert is_ota_channel(raw) == expected
